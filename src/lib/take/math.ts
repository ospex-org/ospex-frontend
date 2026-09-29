/**
 * The arithmetic of taking a posted quote.
 *
 * `MatchingModule.matchCommitment(commitment, signature, takerDesiredRisk)`
 * turns the amount a taker asks to risk into the amounts it moves. This module
 * restates that rule, as `@ospex/sdk`'s `buildMatchPreview` and the connector
 * that writes take links both do, so the page shows what the chain will move.
 *
 *     profitTicks   = oddsTick - 100
 *     rawFill       = ceil(takerDesiredRisk * 100 / profitTicks)
 *     fillMakerRisk = rawFill rounded DOWN to a multiple of 100
 *     reverts when fillMakerRisk == 0 or fillMakerRisk > remaining maker risk
 *     takerRisk     = floor(fillMakerRisk * profitTicks / 100), capped at takerDesiredRisk
 *
 * The taker pays `takerRisk` and stands to win `fillMakerRisk`. So a taker can
 * pay slightly LESS than asked, never more, and a request larger than the
 * quote can absorb is REVERTED, not clamped.
 *
 * `oddsTick` is the MAKER's price. The taker's price is its complement.
 *
 * Pure: no I/O, no clock. Every amount is USDC base units (6 decimals) as a
 * `bigint`; no amount passes through a float.
 */

/** `MatchingModule.ODDS_SCALE`, and the lot size of a maker's risk. */
export const ODDS_SCALE = 100n;
export const MIN_ODDS_TICK = 101;
export const MAX_ODDS_TICK = 10_100;

const USDC_DECIMALS = 6;
const USDC_UNIT = 1_000_000n;

export function isValidOddsTick(oddsTick: number): boolean {
  return Number.isInteger(oddsTick) && oddsTick >= MIN_ODDS_TICK && oddsTick <= MAX_ODDS_TICK;
}

export type MatchRefusal = "odds_out_of_range" | "zero_desired" | "nothing_left" | "zero_fill" | "exceeds_remaining";

export type MatchOutcome =
  | { accepted: true; fillMakerRisk: bigint; takerRisk: bigint }
  | { accepted: false; reason: MatchRefusal };

/** What `matchCommitment` would move for this request, or why it would revert. Arithmetic only. */
export function simulateMatch(input: {
  oddsTick: number;
  remainingMakerRisk: bigint;
  takerDesiredRisk: bigint;
}): MatchOutcome {
  const { oddsTick, remainingMakerRisk, takerDesiredRisk } = input;
  if (!isValidOddsTick(oddsTick)) return { accepted: false, reason: "odds_out_of_range" };
  if (takerDesiredRisk <= 0n) return { accepted: false, reason: "zero_desired" };
  if (remainingMakerRisk <= 0n) return { accepted: false, reason: "nothing_left" };

  const profitTicks = BigInt(oddsTick) - ODDS_SCALE;
  const rawFill = (takerDesiredRisk * ODDS_SCALE + profitTicks - 1n) / profitTicks;
  const fillMakerRisk = rawFill - (rawFill % ODDS_SCALE);
  if (fillMakerRisk === 0n) return { accepted: false, reason: "zero_fill" };
  if (fillMakerRisk > remainingMakerRisk) return { accepted: false, reason: "exceeds_remaining" };

  const uncapped = (fillMakerRisk * profitTicks) / ODDS_SCALE;
  const takerRisk = uncapped > takerDesiredRisk ? takerDesiredRisk : uncapped;
  return { accepted: true, fillMakerRisk, takerRisk };
}

/**
 * The taker amount that takes everything a quote has left, or `0n` when nothing
 * can be taken. Remaining risk is floored to whole lots first; on-chain it
 * always is already.
 */
export function maxTakerRisk(oddsTick: number, remainingMakerRisk: bigint): bigint {
  if (!isValidOddsTick(oddsTick) || remainingMakerRisk <= 0n) return 0n;
  const lots = remainingMakerRisk - (remainingMakerRisk % ODDS_SCALE);
  return (lots * (BigInt(oddsTick) - ODDS_SCALE)) / ODDS_SCALE;
}

/** The smallest taker amount that fills one lot at this price. */
export function minTakerRisk(oddsTick: number): bigint {
  if (!isValidOddsTick(oddsTick)) return 0n;
  // One lot fills once ceil(t * 100 / p) reaches 100, i.e. once t * 100 > 99 * p.
  return (99n * (BigInt(oddsTick) - ODDS_SCALE)) / ODDS_SCALE + 1n;
}

/**
 * The taker's price for a quote posted at `oddsTick`, in ticks, rounded half up
 * to two decimals: D / (D - 1) for a maker price D. Display only; no amount
 * is computed from it.
 */
export function takerOddsTick(oddsTick: number): number {
  if (!isValidOddsTick(oddsTick)) {
    throw new RangeError(`oddsTick ${String(oddsTick)} is outside ${String(MIN_ODDS_TICK)}..${String(MAX_ODDS_TICK)}`);
  }
  const profitTicks = BigInt(oddsTick) - ODDS_SCALE;
  return Number((2n * ODDS_SCALE * BigInt(oddsTick) + profitTicks) / (2n * profitTicks));
}

export interface TakePlan {
  /** What the link asked to risk. */
  requestedTakerRisk: bigint;
  /** The amount passed on-chain as `takerDesiredRisk`. The request, unless the quote cannot absorb it. */
  takerDesiredRisk: bigint;
  /** Maker risk this take consumes, which is also what the taker wins. */
  fillMakerRisk: bigint;
  /** What the taker pays. At most `takerDesiredRisk`. */
  takerRisk: bigint;
  /** True when the request was cut to what the quote has left. */
  reduced: boolean;
  /** The taker's price, in ticks. Display only. */
  takerOddsTick: number;
}

export type TakePlanResult =
  | { ok: true; plan: TakePlan }
  | { ok: false; reason: "odds_out_of_range" | "zero_desired" | "nothing_left" }
  | { ok: false; reason: "too_small"; minTakerRisk: bigint };

/**
 * Size a take. A request the quote can absorb is planned as asked. One that is
 * too large is planned for everything the quote has left and marked
 * `reduced`, because the contract reverts an oversized request rather than
 * filling part of it. The connector sizes its links the same way.
 */
export function planTake(args: {
  oddsTick: number;
  remainingMakerRisk: bigint;
  requestedTakerRisk: bigint;
}): TakePlanResult {
  const { oddsTick, remainingMakerRisk, requestedTakerRisk } = args;
  const plan = (
    takerDesiredRisk: bigint,
    moved: { fillMakerRisk: bigint; takerRisk: bigint },
    reduced: boolean,
  ): TakePlan => ({
    requestedTakerRisk,
    takerDesiredRisk,
    fillMakerRisk: moved.fillMakerRisk,
    takerRisk: moved.takerRisk,
    reduced,
    takerOddsTick: takerOddsTick(oddsTick),
  });

  const asked = simulateMatch({ oddsTick, remainingMakerRisk, takerDesiredRisk: requestedTakerRisk });
  if (asked.accepted) return { ok: true, plan: plan(requestedTakerRisk, asked, false) };
  if (asked.reason === "zero_fill") return { ok: false, reason: "too_small", minTakerRisk: minTakerRisk(oddsTick) };
  if (asked.reason !== "exceeds_remaining") return { ok: false, reason: asked.reason };

  const everything = maxTakerRisk(oddsTick, remainingMakerRisk);
  if (everything === 0n) return { ok: false, reason: "nothing_left" };
  const full = simulateMatch({ oddsTick, remainingMakerRisk, takerDesiredRisk: everything });
  if (!full.accepted) {
    // Whole lots times the profit ratio always fill exactly under the rule
    // above, so this is only reachable if this file's arithmetic is wrong.
    throw new Error(`a full take of ${everything.toString()} was refused: ${full.reason}`);
  }
  return { ok: true, plan: plan(everything, full, true) };
}

// ── amounts as text ────────────────────────────────────────────────────

/** The largest amount a link may name: 1,000,000 USDC, the connector's cap. */
export const MAX_REQUEST_USDC = 1_000_000n * USDC_UNIT;

export type ParsedAmount =
  | { ok: true; baseUnits: bigint }
  | { ok: false; reason: "not_a_decimal" | "too_many_decimals" | "not_positive" | "too_large" };

/** Parse a USDC amount written as a plain decimal, such as `5` or `2.5`, into base units, with no float. */
export function parseUsdc(text: string): ParsedAmount {
  if (/^-\d+(?:\.\d+)?$/.test(text)) return { ok: false, reason: "not_positive" };
  if (!/^\d+(?:\.\d+)?$/.test(text)) return { ok: false, reason: "not_a_decimal" };
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? "" : text.slice(dot + 1);
  if (fraction.length > USDC_DECIMALS) return { ok: false, reason: "too_many_decimals" };
  // Bound the digits before BigInt sees them; the cap below does the refusing.
  if (whole.replace(/^0+/, "").length > 13) return { ok: false, reason: "too_large" };
  const baseUnits = BigInt(whole) * USDC_UNIT + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
  if (baseUnits <= 0n) return { ok: false, reason: "not_positive" };
  if (baseUnits > MAX_REQUEST_USDC) return { ok: false, reason: "too_large" };
  return { ok: true, baseUnits };
}

/** Base units with all six places, e.g. `9.999990`. */
export function formatUsdcExact(baseUnits: bigint): string {
  const negative = baseUnits < 0n;
  const magnitude = negative ? -baseUnits : baseUnits;
  const fraction = (magnitude % USDC_UNIT).toString().padStart(USDC_DECIMALS, "0");
  return `${negative ? "-" : ""}${(magnitude / USDC_UNIT).toString()}.${fraction}`;
}

/** Base units as the shortest decimal that loses nothing, e.g. `10`, `5.25`. */
export function formatUsdcShort(baseUnits: bigint): string {
  const trimmed = formatUsdcExact(baseUnits).replace(/0+$/, "");
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

/** Base units rounded half up to cents, e.g. `9.52`. For reading, not arithmetic. */
export function formatUsdcCents(baseUnits: bigint): string {
  const negative = baseUnits < 0n;
  const magnitude = negative ? -baseUnits : baseUnits;
  const cents = (magnitude + 5_000n) / 10_000n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${(cents / 100n).toString()}.${fraction}`;
}

/** Base units rounded DOWN to cents, for an amount won: never more than the chain pays. */
export function formatUsdcCentsDown(baseUnits: bigint): string {
  const magnitude = baseUnits < 0n ? 0n : baseUnits;
  return formatUsdcCents(magnitude - (magnitude % 10_000n));
}

/** True when the cents form says exactly what the amount is. */
export function isWholeCents(baseUnits: bigint): boolean {
  return baseUnits % 10_000n === 0n;
}

/** An odds tick as a decimal price, e.g. `195` is `1.95`. */
export function formatOddsTick(oddsTick: number): string {
  if (!Number.isInteger(oddsTick) || oddsTick < 0) {
    throw new RangeError(`oddsTick ${String(oddsTick)} is not a non-negative integer`);
  }
  return `${String(Math.trunc(oddsTick / 100))}.${(oddsTick % 100).toString().padStart(2, "0")}`;
}
