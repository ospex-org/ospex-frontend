/**
 * The words the take page's preview is written in. They are the connector's
 * words (the `prepare_order` tool on api.ospex.org/mcp that writes take links),
 * so a person reads the same sentences in their chat and on this page.
 *
 * ## Sides
 *
 * On chain a position is Upper (0) or Lower (1):
 *
 *     moneyline, spread   Upper = the AWAY team    Lower = the HOME team
 *     total               Upper = OVER             Lower = UNDER
 *
 * A quote records the side its MAKER holds, and whoever takes it gets the
 * other one.
 *
 * A spread's stored line is the AWAY team's handicap, times ten. Every label
 * that says "home" or "away" also names the team.
 *
 * Pure: no I/O, no clock.
 */

import type { Market } from "./constants";
import {
  formatOddsTick,
  formatUsdcCents,
  formatUsdcCentsDown,
  formatUsdcExact,
  formatUsdcShort,
  isWholeCents,
  type TakePlan,
} from "./math";

export type Side = "away" | "home" | "over" | "under";

export interface Teams {
  away: string;
  home: string;
}

/** The side a position type is, in this market. */
export function sideOf(market: Market, positionType: 0 | 1): Side {
  if (market === "total") return positionType === 0 ? "over" : "under";
  return positionType === 0 ? "away" : "home";
}

/** Line ticks as a line with one decimal place: `70` is `7.0`, `-35` is `-3.5`. */
export function formatLine(lineTicks: number): string {
  const negative = lineTicks < 0;
  const magnitude = Math.abs(lineTicks);
  return `${negative ? "-" : ""}${String(Math.trunc(magnitude / 10))}.${String(magnitude % 10)}`;
}

/** A handicap with its sign always written: `+1.5`, `-3.5`, and `+0.0` for a pick'em. */
export function formatHandicap(lineTicks: number): string {
  const ticks = lineTicks === 0 ? 0 : lineTicks;
  return ticks < 0 ? formatLine(ticks) : `+${formatLine(ticks)}`;
}

/** A spread's stored line, as the handicap of the given side. */
export function handicapFor(side: "away" | "home", lineTicks: number): number {
  const ticks = side === "away" ? lineTicks : -lineTicks;
  return ticks === 0 ? 0 : ticks;
}

const NAME_MAX_LENGTH = 80;

/** A team's name as one line of plain text: invisible characters dropped, runs of space folded. */
export function cleanName(name: string): string {
  const oneLine = name
    .replace(/[\p{Cf}\p{Cs}]/gu, "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  return [...oneLine].slice(0, NAME_MAX_LENGTH).join("").trimEnd();
}

export function teamsOf(contest: { awayTeam: string; homeTeam: string }): Teams {
  const away = cleanName(contest.awayTeam);
  const home = cleanName(contest.homeTeam);
  return { away: away === "" ? "Away team" : away, home: home === "" ? "Home team" : home };
}

export function matchupLabel(teams: Teams): string {
  return `${teams.away} @ ${teams.home}`;
}

/** A team with its role: `Washington Commanders (home)`. */
export function teamLabel(side: "away" | "home", teams: Teams): string {
  return `${side === "away" ? teams.away : teams.home} (${side})`;
}

/**
 * What a bettor on `side` is backing:
 *
 *     total       Under 47.0
 *     moneyline   Washington Commanders (home) to win
 *     spread      Washington Commanders (home) -1.5
 */
export function backingLabel(market: Market, side: Side, lineTicks: number, teams: Teams): string {
  if (side === "over" || side === "under") {
    return `${side === "over" ? "Over" : "Under"} ${formatLine(Math.abs(lineTicks))}`;
  }
  if (market === "spread") return `${teamLabel(side, teams)} ${formatHandicap(handicapFor(side, lineTicks))}`;
  return `${teamLabel(side, teams)} to win`;
}

const PUSH_RETURNS = "the stake is returned.";

/**
 * When this bet is a push, or `null` when it cannot be one. Follows the scorer
 * contracts: level scores push a moneyline; a whole-number spread or total
 * pushes when the score lands on it.
 */
export function pushSentence(market: Market, lineTicks: number, teams: Teams): string | null {
  if (market === "moneyline") return `A tie is a push: ${PUSH_RETURNS}`;
  if (lineTicks % 10 !== 0) return null;
  const points = Math.abs(lineTicks) / 10;
  if (market === "total") return `A combined score of exactly ${String(points)} is a push: ${PUSH_RETURNS}`;
  if (lineTicks === 0) return `A tie is a push: ${PUSH_RETURNS}`;
  const giver = lineTicks < 0 ? teams.away : teams.home;
  return `${giver} winning by exactly ${String(points)} is a push: ${PUSH_RETURNS}`;
}

// ── times ──────────────────────────────────────────────────────────────

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/**
 * An RFC 3339 timestamp with a zone, as the API writes them, in epoch
 * milliseconds, or `null` for anything else. Stricter than `Date.parse`, which
 * reads `2026-02-30` as March 2 and a time with no zone in the viewer's own.
 * Fractions of a millisecond are dropped, which moves an instant earlier by
 * less than a millisecond; the page only compares these against the clock
 * with a two-minute margin, and earlier is the cautious direction there.
 */
export function parseTimestampMs(text: string): number | null {
  const m = RFC3339.exec(text);
  if (m === null) return null;
  const [, yS, moS, dS, hS, miS, sS, fracS, zulu, sign, offHS, offMS] = m;
  const y = Number(yS);
  const mo = Number(moS);
  const d = Number(dS);
  const h = Number(hS);
  const mi = Number(miS);
  const s = Number(sS);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const baseMs = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(baseMs);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const ms = fracS === undefined ? 0 : Number(fracS.slice(0, 3).padEnd(3, "0"));
  let total = baseMs + ms;
  if (zulu === undefined) {
    const offH = Number(offHS);
    const offM = Number(offMS);
    if (offH > 23 || offM > 59) return null;
    const offset = (offH * 60 + offM) * 60_000;
    total += sign === "-" ? offset : -offset;
  }
  return total;
}

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

/**
 * An instant as US Eastern wall-clock time, `Sun Oct 4, 9:30 am ET`, wherever
 * the reader is, because that is how the connector writes it. Assembled from
 * the formatter's parts, since its finished string varies between runtimes.
 */
export function formatEasternMs(epochMs: number, seconds = false): string | null {
  if (!Number.isFinite(epochMs)) return null;
  const parts = new Map<string, string>();
  for (const part of EASTERN.formatToParts(new Date(epochMs))) parts.set(part.type, part.value);
  const weekday = parts.get("weekday");
  const month = parts.get("month");
  const day = parts.get("day");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  const second = parts.get("second");
  const period = parts.get("dayPeriod");
  if (!weekday || !month || !day || !hour || !minute || !second || !period) return null;
  const clock = seconds ? `${hour}:${minute}:${second}` : `${hour}:${minute}`;
  return `${weekday} ${month} ${day}, ${clock} ${period.toLowerCase()} ET`;
}

// ── the preview ────────────────────────────────────────────────────────

export interface PreviewInput {
  market: Market;
  takerSide: Side;
  lineTicks: number;
  teams: Teams;
  startMs: number;
  expiryMs: number;
  plan: TakePlan;
}

/**
 * The preview, line for line as the connector's `prepare_order` writes it for
 * the same quote and amount:
 *
 *     Under 47.0 — Indianapolis Colts @ Washington Commanders, Sun Oct 4, 9:30 am ET.
 *     Risk 5.00 USDC to win 4.71 at 1.94.
 *     A combined score of exactly 47 is a push: the stake is returned.
 *     Quote expires Sun Oct 4, 9:30 am ET.
 *     Exact amounts: you pay 4.999914 USDC and win 4.716900 USDC.
 *
 * The paid amount is rounded to the cent and the won amount rounded DOWN, so
 * the headline never promises more than the chain pays; the exact line follows
 * whenever either differs from its cents.
 */
export function previewLines(input: PreviewInput): string[] {
  const { market, takerSide, lineTicks, teams, startMs, expiryMs, plan } = input;
  const startsAt = formatEasternMs(startMs) ?? new Date(startMs).toISOString();
  const out = [
    `${backingLabel(market, takerSide, lineTicks, teams)} — ${matchupLabel(teams)}, ${startsAt}.`,
    `Risk ${formatUsdcCents(plan.takerRisk)} USDC to win ${formatUsdcCentsDown(plan.fillMakerRisk)} at ${formatOddsTick(plan.takerOddsTick)}.`,
  ];
  const push = pushSentence(market, lineTicks, teams);
  if (push !== null) out.push(push);
  out.push(
    expiryMs > startMs
      ? `Take it before the game starts, ${startsAt}. The quote itself expires later than that.`
      : `Quote expires ${formatEasternMs(expiryMs) ?? new Date(expiryMs).toISOString()}.`,
  );
  if (!isWholeCents(plan.takerRisk) || !isWholeCents(plan.fillMakerRisk)) {
    out.push(
      `Exact amounts: you pay ${formatUsdcExact(plan.takerRisk)} USDC and win ${formatUsdcExact(plan.fillMakerRisk)} USDC.`,
    );
  }
  if (plan.reduced) {
    out.push(
      `This quote can take ${formatUsdcShort(plan.takerDesiredRisk)} USDC, not the ` +
        `${formatUsdcShort(plan.requestedTakerRisk)} asked for. The order is for ${formatUsdcShort(plan.takerDesiredRisk)}.`,
    );
  }
  return out;
}
