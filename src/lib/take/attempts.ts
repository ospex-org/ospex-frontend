/**
 * One record per attempt to take a quote, kept in the browser.
 *
 * A take's outcome can be lost. A wallet, or the node behind it, can accept the
 * transaction and then fail to return its hash; the page can be closed or
 * reloaded while the wallet is still asking. From then on the page cannot tell
 * "sent" from "not sent", and a second take would be a second bet.
 *
 * So the page writes the attempt down before it hands the transaction to the
 * wallet, and rewrites the record every time the attempt's status changes.
 * While the latest attempt for a quote and a wallet is unresolved, the page
 * offers no plain take on that quote from that wallet, before or after a
 * reload. It looks for the attempt's fill in the API instead. An attempt whose
 * outcome is unknown ends in one of three ways, each kept in its record:
 *
 * - its fill is found and shown;
 * - a round of looking finds no fill, and the wallet's transaction count has
 *   not moved since the handoff: nothing was sent, and the quote is released;
 * - the person ticks that taking the quote again may place a second bet, and
 *   takes it again.
 *
 * If the count has moved and no fill appears, the attempt stays open and the
 * page keeps looking.
 *
 * The record is in this browser's storage for the site: another browser or
 * device does not see it. Where the browser will not keep it, the record is
 * kept in memory for as long as the page is open, and the page says that a
 * reload would lose it.
 */

import type { Fill } from "./api";
import { formatEasternMs, parseTimestampMs } from "./words";

export type AttemptStatus =
  /** Written just before the wallet was asked. Nothing has been heard since. */
  | "handoff"
  /** The wallet returned the transaction's hash. */
  | "sent"
  /** The wallet answered with an error, or the page lost the transaction: it may be in flight. */
  | "unknown"
  /** The wallet said its user declined. Nothing was sent. */
  | "declined"
  /** Mined, and it succeeded. Waiting for Ospex to list the fill. */
  | "confirmed"
  /** Ospex lists the fill. */
  | "recorded"
  /** Mined and reverted, or replaced by the wallet with something else. No bet. */
  | "failed"
  /**
   * The outcome was unknown; then a round of looking found no fill, and the
   * wallet's transaction count had not moved since the handoff. Nothing was sent.
   */
  | "unsent"
  /**
   * The outcome was unknown, and the person took the quote again after ticking
   * that it may place a second bet.
   */
  | "acknowledged";

const STATUSES: readonly AttemptStatus[] = [
  "handoff",
  "sent",
  "unknown",
  "declined",
  "confirmed",
  "recorded",
  "failed",
  "unsent",
  "acknowledged",
];

/** How many transactions the wallet has sent: mined, and with pending ones counted too. */
export interface TxCount {
  latest: number;
  pending: number;
}

/** A fill as the attempt keeps it: amounts as base-unit digits. */
export interface AttemptFill {
  txHash: string;
  takerRisk: string;
  makerRisk: string;
  oddsTick: number;
  filledAt: string;
}

export interface Attempt {
  v: 1;
  id: string;
  /** The quote's hash, lowercase. */
  quote: string;
  /** The wallet taking it, lowercase. */
  taker: string;
  /** Base-unit digits: the amount passed on-chain, what it pays, what it wins. */
  takerDesiredRisk: string;
  takerRisk: string;
  fillMakerRisk: string;
  /** The game's conservative start, as the last check read it. */
  startMs: number;
  /** A block from before the handoff, from which a replaced transaction is looked for. */
  startBlock: number;
  /** Transaction hashes of this wallet's fills on this quote from before the handoff. */
  knownFills: string[];
  status: AttemptStatus;
  /** When the last check of the quote, the game and the clock was made. */
  lastCheckAt: number;
  /** When the transaction was handed to the wallet. */
  handoffAt: number;
  /** When the wallet returned its hash. */
  sentAt: number | null;
  hash: string | null;
  blockNumber: number | null;
  /**
   * The mined block's time: from the block itself, or, when the page never saw
   * the receipt, from the fill, whose time the API gives as the block's.
   */
  minedAt: number | null;
  /** What the receipt's CommitmentMatched event says was moved. */
  matched: { takerRisk: string; makerRisk: string; oddsTick: number } | null;
  fill: AttemptFill | null;
  /** What happened, in words, when it did not go as planned. */
  note: string | null;
  /** The wallet's transaction count just before the handoff. Null in a record from before the page read it. */
  nonce: TxCount | null;
  /**
   * The count as read when a round of looking for this attempt's fill found
   * none, while its outcome was unknown. Higher than `nonce` means something was
   * sent from the wallet since the handoff.
   */
  nonceCheck: (TxCount & { at: number }) | null;
  /** When the person took the quote again over this attempt, having ticked that it may place a second bet. */
  acknowledgedAt: number | null;
  updatedAt: number;
}

export interface AttemptStore {
  /** Every attempt kept for this quote and wallet. */
  list(quote: string, taker: string): Attempt[];
  /** Write this attempt over the one with its id: in the browser's storage, or in memory when the browser will not keep it. */
  save(attempt: Attempt): void;
  /** False once the browser has not kept a record: this page's records then last only until it is reloaded or closed. */
  remembers(): boolean;
}

type KeyValue = Pick<Storage, "getItem" | "setItem">;

const PREFIX = "ospex:take:v1:";
const KEEP = 20;
const HEX = /^0x[0-9a-f]+$/;

/** A record as kept: one written before the count and the acknowledgement were recorded does not carry them. */
type Stored = Omit<Attempt, "nonce" | "nonceCheck" | "acknowledgedAt"> &
  Partial<Pick<Attempt, "nonce" | "nonceCheck" | "acknowledgedAt">>;

function isCount(value: unknown): value is TxCount {
  if (typeof value !== "object" || value === null) return false;
  const count = value as Record<string, unknown>;
  return Number.isSafeInteger(count.latest) && Number.isSafeInteger(count.pending);
}

function isStored(value: unknown): value is Stored {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  const digits = (x: unknown) => typeof x === "string" && /^\d+$/.test(x);
  const numberOrNull = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x));
  const absentOr = (x: unknown, ok: (y: unknown) => boolean) => x === undefined || x === null || ok(x);
  return (
    a.v === 1 &&
    typeof a.id === "string" &&
    typeof a.quote === "string" &&
    HEX.test(a.quote) &&
    typeof a.taker === "string" &&
    HEX.test(a.taker) &&
    digits(a.takerDesiredRisk) &&
    digits(a.takerRisk) &&
    digits(a.fillMakerRisk) &&
    typeof a.startMs === "number" &&
    typeof a.startBlock === "number" &&
    Array.isArray(a.knownFills) &&
    a.knownFills.every((h) => typeof h === "string") &&
    typeof a.status === "string" &&
    STATUSES.includes(a.status as AttemptStatus) &&
    typeof a.lastCheckAt === "number" &&
    typeof a.handoffAt === "number" &&
    numberOrNull(a.sentAt) &&
    (a.hash === null || (typeof a.hash === "string" && HEX.test(a.hash))) &&
    numberOrNull(a.blockNumber) &&
    numberOrNull(a.minedAt) &&
    (a.note === null || typeof a.note === "string") &&
    typeof a.updatedAt === "number" &&
    absentOr(a.nonce, isCount) &&
    absentOr(a.nonceCheck, (check) => isCount(check) && typeof (check as { at?: unknown }).at === "number") &&
    absentOr(a.acknowledgedAt, numberOrNull)
  );
}

function withDefaults(stored: Stored): Attempt {
  return {
    ...stored,
    nonce: stored.nonce ?? null,
    nonceCheck: stored.nonceCheck ?? null,
    acknowledgedAt: stored.acknowledgedAt ?? null,
  };
}

/**
 * The store over the browser's storage for this site, or over `storage` when a
 * test passes one. What the storage will not keep (there is none, or a write
 * throws) is kept in memory for as long as the store lives, and `remembers`
 * turns false.
 */
export function attemptStore(storage: KeyValue | null): AttemptStore {
  const keyOf = (quote: string, taker: string) => `${PREFIX}${quote.toLowerCase()}:${taker.toLowerCase()}`;
  const memory = new Map<string, Attempt[]>();
  let remembers = storage !== null;
  const read = (key: string): Attempt[] => {
    const held = memory.get(key);
    if (held !== undefined) return [...held];
    if (storage === null) return [];
    try {
      const raw = storage.getItem(key);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isStored).map(withDefaults) : [];
    } catch {
      return [];
    }
  };
  return {
    list: (quote, taker) => read(keyOf(quote, taker)),
    save: (attempt) => {
      const key = keyOf(attempt.quote, attempt.taker);
      const others = read(key).filter((kept) => kept.id !== attempt.id);
      // Resolved attempts are dropped oldest first; an unresolved one is never dropped.
      const open = others.filter((kept) => !isResolved(kept));
      const done = others.filter(isResolved).sort((a, b) => a.handoffAt - b.handoffAt);
      const next = [...done.slice(Math.max(0, done.length - (KEEP - open.length - 1))), ...open, attempt];
      if (storage !== null && remembers) {
        try {
          storage.setItem(key, JSON.stringify(next));
          return;
        } catch {
          remembers = false;
        }
      }
      memory.set(key, next);
    },
    remembers: () => remembers,
  };
}

let pageStore: AttemptStore | null = null;

/**
 * The store the page uses. There is one for as long as the page is open, so
 * what it holds in memory, when the browser keeps nothing, is not lost by
 * leaving the take page and coming back to it without a reload.
 */
export function pageAttemptStore(): AttemptStore {
  if (pageStore === null) pageStore = attemptStore(browserStorage());
  return pageStore;
}

/** This site's storage in the browser, or null when the browser will not give it. */
export function browserStorage(): KeyValue | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isResolved(attempt: Attempt): boolean {
  return (
    attempt.status === "declined" ||
    attempt.status === "recorded" ||
    attempt.status === "failed" ||
    attempt.status === "unsent" ||
    attempt.status === "acknowledged"
  );
}

/** The latest unresolved attempt on this quote from this wallet, or null. */
export function openAttempt(store: AttemptStore, quote: string, taker: string): Attempt | null {
  const open = store.list(quote, taker).filter((attempt) => !isResolved(attempt));
  open.sort((a, b) => b.handoffAt - a.handoffAt);
  return open[0] ?? null;
}

function newId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** A new attempt, about to be handed to the wallet. */
export function handoff(args: {
  quote: string;
  taker: string;
  takerDesiredRisk: bigint;
  takerRisk: bigint;
  fillMakerRisk: bigint;
  startMs: number;
  startBlock: number;
  knownFills: string[];
  nonce: TxCount;
  lastCheckAt: number;
  handoffAt: number;
}): Attempt {
  return {
    v: 1,
    id: newId(),
    quote: args.quote.toLowerCase(),
    taker: args.taker.toLowerCase(),
    takerDesiredRisk: args.takerDesiredRisk.toString(),
    takerRisk: args.takerRisk.toString(),
    fillMakerRisk: args.fillMakerRisk.toString(),
    startMs: args.startMs,
    startBlock: args.startBlock,
    knownFills: args.knownFills.map((hash) => hash.toLowerCase()),
    status: "handoff",
    lastCheckAt: args.lastCheckAt,
    handoffAt: args.handoffAt,
    sentAt: null,
    hash: null,
    blockNumber: null,
    minedAt: null,
    matched: null,
    fill: null,
    note: null,
    nonce: args.nonce,
    nonceCheck: null,
    acknowledgedAt: null,
    updatedAt: args.handoffAt,
  };
}

/** The attempt with these fields changed, stamped with the time of the change. */
export function update(attempt: Attempt, patch: Partial<Attempt>, now: number): Attempt {
  return { ...attempt, ...patch, updatedAt: now };
}

/**
 * The fill this attempt made, among this wallet's fills on this quote: the one
 * with the attempt's hash, or, unless the attempt is confirmed under a hash, a
 * fill that was not there before the handoff.
 */
export function fillOf(attempt: Attempt, fills: readonly Fill[]): Fill | null {
  if (attempt.hash !== null) {
    const exact = fills.find((fill) => fill.txHash === attempt.hash);
    if (exact !== undefined) return exact;
    if (attempt.status === "confirmed") return null;
  }
  return fills.find((fill) => !attempt.knownFills.includes(fill.txHash)) ?? null;
}

/** The fill found for an attempt, as the record keeps it. */
export function recorded(attempt: Attempt, fill: Fill, now: number): Attempt {
  return update(
    attempt,
    {
      status: "recorded",
      hash: attempt.hash ?? fill.txHash,
      minedAt: attempt.minedAt ?? parseTimestampMs(fill.filledAt),
      fill: {
        txHash: fill.txHash,
        takerRisk: fill.takerRisk.toString(),
        makerRisk: fill.makerRisk.toString(),
        oddsTick: fill.oddsTick,
        filledAt: fill.filledAt,
      },
    },
    now,
  );
}

/**
 * True when a check found the wallet's transaction count higher than at the
 * handoff, mined or pending: the wallet has sent something since, which may be
 * this take.
 */
export function sentSinceHandoff(attempt: Attempt): boolean {
  const { nonce, nonceCheck } = attempt;
  return nonce !== null && nonceCheck !== null && (nonceCheck.latest > nonce.latest || nonceCheck.pending > nonce.pending);
}

// ── words ──────────────────────────────────────────────────────────────

/** Said while an attempt's outcome is unknown, and again if no fill turns up. */
export const IN_FLIGHT =
  "A transaction for this bet may already be in flight: check your wallet's activity, or your address on " +
  "Polygonscan, and do not take this quote again unless you mean to place a second bet.";

/** Said when an unknown attempt is released because nothing was sent. */
export const UNSENT =
  "Nothing was sent: Polygon shows no transaction from your wallet since this take was handed to it, and Ospex " +
  "lists no fill, so you can take this quote again; if your wallet still shows a request for this take, reject it first.";

/** Said while an unknown attempt stays open because the wallet has sent something since the handoff. */
export const SENT_SINCE =
  "Polygon shows a transaction from your wallet since this take was handed to it, so the take may have been sent: " +
  "the page keeps looking for its fill.";

/** What the person ticks before taking a quote again while an attempt on it is unknown. */
export const SECOND_BET = "I understand this may place a second bet";

/** Said while a take is under way in a browser that did not keep its record. */
export const NO_MEMORY =
  "This browser would not let the page keep a record of this bet, so it cannot remember the bet across a reload: " +
  "do not reload or close this page while the bet is in flight.";

export const PAGE_STOPPED =
  "The page was closed or reloaded while your wallet was asking you to confirm, so it cannot tell whether the take was sent.";

export function walletError(reason: string): string {
  return `Your wallet answered with an error after it was asked to send the take (${reason}), so the page cannot tell whether it was sent.`;
}

function at(ms: number, seconds = true): string {
  return formatEasternMs(ms, seconds) ?? new Date(ms).toISOString();
}

/**
 * True when the take was mined at or after the game's start, as the last check
 * read it. The contract fills a quote until its signed expiry, and a quote can
 * be signed to expire after the start.
 */
export function filledAfterKickoff(attempt: Attempt): boolean {
  return attempt.minedAt !== null && attempt.minedAt >= attempt.startMs;
}

/** Said when a take was mined after the game started, or null when it was not. */
export function kickoffSentence(attempt: Attempt): string | null {
  if (attempt.minedAt === null || !filledAfterKickoff(attempt)) return null;
  return `Filled after kickoff: it was mined ${at(attempt.minedAt)}, after the game's start at ${at(attempt.startMs, false)}.`;
}

/** The times the record holds, as lines: the last check, the handoff, the send and the block. */
export function timeline(attempt: Attempt): string[] {
  const out = [`Last check: ${at(attempt.lastCheckAt)}.`, `Handed to your wallet: ${at(attempt.handoffAt)}.`];
  if (attempt.sentAt !== null) out.push(`Sent: ${at(attempt.sentAt)}.`);
  if (attempt.minedAt !== null) {
    out.push(`Mined: ${at(attempt.minedAt)}${attempt.blockNumber === null ? "" : `, block ${String(attempt.blockNumber)}`}.`);
  }
  return out;
}
