/**
 * Reading a quote and its game from the API, and deciding whether this page
 * will take it.
 *
 * The quote's terms are not taken on the API's word:
 *
 *   - the quote's nine signed fields must hash (EIP-712) to the hash in the
 *     link, so the fields shown are the fields the chain will check;
 *   - the signature must recover to the quote's maker;
 *   - the market comes from the scorer address the maker signed, not from the
 *     API's label for it.
 *
 * The quote's state (what is left, whether it is cancelled) is read from the
 * API here and checked again by the chain itself when the take is run as a
 * call before sending. The game's state and start time come from the API
 * alone: the contract does not look at the start, so the page's start check
 * rests on the API's conservative start time, `matchTime`.
 *
 * The checks after those follow `@ospex/sdk`'s `prepareMatch` and
 * `matchFromPreview`, and the connector that writes the links: the game is
 * verified and more than two minutes from its start, the quote is open,
 * visible, not cancelled, more than two minutes from its expiry, and has a lot
 * left, and its line already exists on-chain and is open. Taking a quote on a
 * line that does not exist yet would create the line and charge both sides a
 * fee, so this page does not.
 *
 * Pure apart from the clock the caller passes in.
 */

import { MAX_LINE_TICKS, SCORERS, TAKE_MARGIN_MS, type Market } from "./constants";
import { formatUsdcShort, isValidOddsTick, ODDS_SCALE, planTake, type TakePlan } from "./math";
import { hashCommitment, recoverSigner, type SignedCommitment } from "./tx";
import {
  backingLabel,
  formatEasternMs,
  formatLine,
  matchupLabel,
  parseTimestampMs,
  previewLines,
  sideOf,
  teamsOf,
  type Side,
  type Teams,
} from "./words";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const DIGITS = /^\d+$/;
const CONTEST_ID = /^(0|[1-9]\d{0,19})$/;

export interface Quote {
  /** Lowercase; the hash in the link. */
  hash: string;
  commitment: SignedCommitment;
  signature: string;
  market: Market;
  /** The side the MAKER holds. The taker gets the other. */
  makerPositionType: 0 | 1;
  remainingMakerRisk: bigint;
  expiryMs: number;
  /** The on-chain lifecycle: open, partially_filled, filled or cancelled. */
  storedStatus: string;
  nonceInvalidated: boolean;
}

export type QuoteRead =
  | { kind: "quote"; quote: Quote }
  /** The maker took the quote off the book. Its signed fields are no longer served. */
  | { kind: "withdrawn" }
  | { kind: "bad"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function marketOfScorer(scorer: string): Market | null {
  for (const market of Object.keys(SCORERS) as Market[]) {
    if (SCORERS[market].toLowerCase() === scorer.toLowerCase()) return market;
  }
  return null;
}

const BAD_FIELDS = "Ospex returned this quote with fields this page cannot use, so it will not take it.";

/** Read `GET /v1/commitments/:hash` for the quote named by `linkHash`. */
export function readQuote(body: unknown, linkHash: string): QuoteRead {
  const hash = linkHash.toLowerCase();
  if (!HASH.test(hash)) return { kind: "bad", reason: "This link does not name a quote." };
  if (!isRecord(body)) return { kind: "bad", reason: BAD_FIELDS };
  if (typeof body.commitmentHash !== "string" || body.commitmentHash.toLowerCase() !== hash) {
    return { kind: "bad", reason: "Ospex returned a different quote from the one this link names, so nothing will be sent." };
  }
  if (body.redacted === true || body.bookVisible !== true) return { kind: "withdrawn" };

  const {
    maker,
    contestId,
    scorer,
    lineTicks,
    positionType,
    oddsTick,
    riskAmount,
    filledRiskAmount,
    remainingRiskAmount,
    nonce,
    expiry,
    signature,
    storedStatus,
    nonceInvalidated,
    marketType,
  } = body;
  if (typeof maker !== "string" || !ADDRESS.test(maker)) return { kind: "bad", reason: BAD_FIELDS };
  if (typeof contestId !== "string" || !CONTEST_ID.test(contestId)) return { kind: "bad", reason: BAD_FIELDS };
  if (typeof scorer !== "string" || !ADDRESS.test(scorer)) return { kind: "bad", reason: BAD_FIELDS };
  if (typeof lineTicks !== "number" || !Number.isInteger(lineTicks) || Math.abs(lineTicks) > MAX_LINE_TICKS) {
    return { kind: "bad", reason: BAD_FIELDS };
  }
  if (positionType !== 0 && positionType !== 1) return { kind: "bad", reason: BAD_FIELDS };
  if (typeof oddsTick !== "number" || !isValidOddsTick(oddsTick)) return { kind: "bad", reason: BAD_FIELDS };
  for (const amount of [riskAmount, filledRiskAmount, remainingRiskAmount, nonce]) {
    if (typeof amount !== "string" || !DIGITS.test(amount)) return { kind: "bad", reason: BAD_FIELDS };
  }
  const risk = BigInt(riskAmount as string);
  const remaining = BigInt(remainingRiskAmount as string);
  if (risk <= 0n || risk % ODDS_SCALE !== 0n || remaining > risk) return { kind: "bad", reason: BAD_FIELDS };
  if (typeof expiry !== "string") return { kind: "bad", reason: BAD_FIELDS };
  const expiryMs = parseTimestampMs(expiry);
  // Signed as whole unix seconds, so it is stored as whole seconds.
  if (expiryMs === null || expiryMs % 1000 !== 0) return { kind: "bad", reason: BAD_FIELDS };
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return { kind: "bad", reason: BAD_FIELDS };
  if (typeof storedStatus !== "string" || typeof nonceInvalidated !== "boolean") {
    return { kind: "bad", reason: BAD_FIELDS };
  }

  const market = marketOfScorer(scorer);
  if (market === null) return { kind: "bad", reason: "This quote names a scorer Ospex does not use, so it will not be taken." };
  if (marketType !== null && marketType !== undefined && marketType !== market) {
    return { kind: "bad", reason: BAD_FIELDS };
  }

  const commitment: SignedCommitment = {
    maker: maker.toLowerCase(),
    contestId,
    scorer: scorer.toLowerCase(),
    lineTicks,
    positionType,
    oddsTick,
    riskAmount: riskAmount as string,
    nonce: nonce as string,
    expiry: String(expiryMs / 1000),
  };
  if (hashCommitment(commitment) !== hash) {
    return { kind: "bad", reason: "This quote's signed fields do not match the quote this link names, so nothing will be sent." };
  }
  if (recoverSigner(commitment, signature) !== commitment.maker) {
    return { kind: "bad", reason: "This quote's signature does not match its maker, so nothing will be sent." };
  }

  return {
    kind: "quote",
    quote: {
      hash,
      commitment,
      signature,
      market,
      makerPositionType: positionType,
      remainingMakerRisk: remaining,
      expiryMs,
      storedStatus,
      nonceInvalidated,
    },
  };
}

export interface Line {
  speculationId: string;
  market: Market;
  lineTicks: number;
  /** 0 is open. */
  speculationStatus: number;
}

export interface Contest {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  status: string;
  /** The API's conservative start: the earliest start the game is known to have. */
  matchTime: string;
  lines: Line[];
}

/** Read `GET /v1/contests/:contestId`, or `null` when it is not a contest this page can use. */
export function readContest(body: unknown): Contest | null {
  if (!isRecord(body)) return null;
  const { contestId, awayTeam, homeTeam, status, matchTime, speculations } = body;
  if (typeof contestId !== "string" || typeof awayTeam !== "string" || typeof homeTeam !== "string") return null;
  if (typeof status !== "string" || typeof matchTime !== "string" || !Array.isArray(speculations)) return null;
  const lines: Line[] = [];
  for (const row of speculations) {
    if (!isRecord(row)) return null;
    const { speculationId, type, lineTicks, speculationStatus } = row;
    if (typeof speculationId !== "string" || typeof speculationStatus !== "number") return null;
    if (type !== "moneyline" && type !== "spread" && type !== "total") return null;
    // A moneyline has no line; the API may send it as null.
    const ticks = lineTicks === null || lineTicks === undefined ? 0 : lineTicks;
    if (typeof ticks !== "number" || !Number.isInteger(ticks)) return null;
    lines.push({ speculationId, market: type, lineTicks: ticks, speculationStatus });
  }
  return { contestId, awayTeam, homeTeam, status, matchTime, lines };
}

export interface TakeView {
  quote: Quote;
  plan: TakePlan;
  teams: Teams;
  /** The side the taker backs. */
  takerSide: Side;
  /** "Under 47.0", "Washington Commanders (home) to win". */
  backing: string;
  /** "Indianapolis Colts @ Washington Commanders". */
  game: string;
  startMs: number;
  speculationId: string;
  /** The preview, in the connector's words. */
  preview: string[];
}

export type Assessment = { ok: true; view: TakeView } | { ok: false; lines: string[] };

function refuse(...lines: string[]): Assessment {
  return { ok: false, lines };
}

/**
 * Decide whether this page takes `quote` for `requestedRisk` at `nowMs`, and
 * write the preview if it does. Every refusal is a sentence a person can act on.
 */
export function assessTake(args: {
  quote: Quote;
  contest: Contest;
  requestedRisk: bigint;
  nowMs: number;
}): Assessment {
  const { quote, contest, requestedRisk, nowMs } = args;
  const teams = teamsOf(contest);
  const game = matchupLabel(teams);

  if (contest.contestId !== quote.commitment.contestId) {
    return refuse("Ospex returned a different game from the one this quote is on, so nothing will be sent.");
  }
  if (contest.status !== "verified") {
    return refuse(`${game} is not open for betting: its contest is ${contest.status === "" ? "in an unknown state" : contest.status}.`);
  }
  const startMs = parseTimestampMs(contest.matchTime);
  if (startMs === null) return refuse(`${game} has no start time Ospex can read, so it cannot be bet on.`);
  const startsAt = formatEasternMs(startMs) ?? contest.matchTime;
  if (startMs <= nowMs) {
    // The contract would still fill a take after the start. This page sends none.
    return refuse(`${game} started ${startsAt}. No bet is taken on a game under way.`);
  }
  if (startMs - nowMs <= TAKE_MARGIN_MS) {
    return refuse(`${game} starts ${startsAt}, less than two minutes from now. That is too close to the start to take a quote.`);
  }

  if (quote.storedStatus === "filled") return refuse("This quote has been taken in full.");
  if (quote.storedStatus === "cancelled" || quote.nonceInvalidated) return refuse("The maker has cancelled this quote.");
  if (quote.storedStatus !== "open" && quote.storedStatus !== "partially_filled") {
    return refuse(`This quote is ${quote.storedStatus === "" ? "in an unknown state" : quote.storedStatus}, so it cannot be taken.`);
  }
  const expiresAt = formatEasternMs(quote.expiryMs) ?? new Date(quote.expiryMs).toISOString();
  if (quote.expiryMs <= nowMs) return refuse(`This quote expired ${expiresAt}.`);
  if (quote.expiryMs - nowMs <= TAKE_MARGIN_MS) {
    return refuse(`This quote expires ${expiresAt}, less than two minutes from now. That is too close to take it.`);
  }
  if (quote.remainingMakerRisk - (quote.remainingMakerRisk % ODDS_SCALE) <= 0n) {
    return refuse("This quote has been taken in full.");
  }

  const takerSide = sideOf(quote.market, quote.makerPositionType === 0 ? 1 : 0);
  const lineTicks = quote.commitment.lineTicks;
  const backing = backingLabel(quote.market, takerSide, lineTicks, teams);
  const line = contest.lines.find((candidate) => candidate.market === quote.market && candidate.lineTicks === lineTicks);
  if (line === undefined) {
    const named = quote.market === "moneyline" ? "moneyline" : `${quote.market} line at ${formatLine(lineTicks)}`;
    return refuse(
      `${game} has no ${named} on-chain yet. Taking this quote would open the line and charge a fee, so this page will not take it.`,
    );
  }
  if (line.speculationStatus !== 0) return refuse(`The market for ${backing} on ${game} has closed.`);

  const planned = planTake({
    oddsTick: quote.commitment.oddsTick,
    remainingMakerRisk: quote.remainingMakerRisk,
    requestedTakerRisk: requestedRisk,
  });
  if (!planned.ok) {
    if (planned.reason === "too_small") {
      return refuse(
        `${formatUsdcShort(requestedRisk)} USDC is too small to take this quote for ${backing}. ` +
          `The smallest is ${formatUsdcShort(planned.minTakerRisk)} USDC.`,
      );
    }
    if (planned.reason === "nothing_left") return refuse("This quote has been taken in full.");
    return refuse("This quote cannot be taken for that amount.");
  }
  const plan = planned.plan;

  return {
    ok: true,
    view: {
      quote,
      plan,
      teams,
      takerSide,
      backing,
      game,
      startMs,
      speculationId: line.speculationId,
      preview: previewLines({
        market: quote.market,
        takerSide,
        lineTicks,
        teams,
        startMs,
        expiryMs: quote.expiryMs,
        plan,
      }),
    },
  };
}

/** True when two views would send the same transaction for the same amounts. */
export function sameTake(a: TakeView, b: TakeView): boolean {
  return (
    a.quote.hash === b.quote.hash &&
    a.quote.signature.toLowerCase() === b.quote.signature.toLowerCase() &&
    a.plan.takerDesiredRisk === b.plan.takerDesiredRisk &&
    a.plan.fillMakerRisk === b.plan.fillMakerRisk &&
    a.plan.takerRisk === b.plan.takerRisk &&
    a.speculationId === b.speculationId
  );
}
