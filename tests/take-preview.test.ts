/**
 * The preview reads the same as the connector's `prepare_order` preview for
 * the same quote and amount.
 *
 * The live Under 47 lines carry the figures `prepare_order` gave for this
 * link on 9/29 (risk 5.00 to win 4.71 at 1.94, a push at exactly 47, expiring
 * Sun Oct 4, 9:30 am ET, exact amounts 4.999914 and 4.716900). The other cases
 * are built from the literals ospex-core-api's connector tests pin, over the
 * same game, times and prices.
 */
import { describe, expect, it } from "vitest";
import quoteBody from "./fixtures/quote-under-47.json";
import contestBody from "./fixtures/contest-478.json";
import { SCORERS, type Market } from "../src/lib/take/constants";
import { assessTake, readContest, readQuote, type Contest, type Quote } from "../src/lib/take/quote";

const LINK_HASH = "0x44cfbdfe8524667942a3d8f9784d212fea27b852459091d7de5a440ad34a2617";
/** Tue Sep 29 2026, 12:00 UTC: after the quote was posted, days before kickoff. */
const SEP_29_NOON = Date.UTC(2026, 8, 29, 12, 0, 0);

function preview(requestedRisk: bigint, quote: Quote, contest: Contest, nowMs: number): string[] {
  const assessed = assessTake({ quote, contest, requestedRisk, nowMs });
  if (!assessed.ok) throw new Error(assessed.lines.join(" "));
  return assessed.view.preview;
}

describe("the live link: Under 47, 5 USDC", () => {
  it("previews it in the connector's words", () => {
    const read = readQuote(quoteBody, LINK_HASH);
    const contest = readContest(contestBody);
    if (read.kind !== "quote" || contest === null) throw new Error("fixture did not read");
    expect(preview(5_000_000n, read.quote, contest, SEP_29_NOON)).toEqual([
      "Under 47.0 — Indianapolis Colts @ Washington Commanders, Sun Oct 4, 9:30 am ET.",
      "Risk 5.00 USDC to win 4.71 at 1.94.",
      "A combined score of exactly 47 is a push: the stake is returned.",
      "Quote expires Sun Oct 4, 9:30 am ET.",
      "Exact amounts: you pay 4.999914 USDC and win 4.716900 USDC.",
    ]);
  });
});

// The connector tests' game: Tampa Bay Rays @ Philadelphia Phillies, first
// pitch 19:05 UTC on Sun Sep 27, quotes expiring at 18:55, clock at 12:00.
const START = "2026-09-27T19:05:00+00:00";
const EXPIRY_MS = Date.UTC(2026, 8, 27, 18, 55, 0);
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

const rays: Contest = {
  contestId: "481",
  awayTeam: "Tampa Bay Rays",
  homeTeam: "Philadelphia Phillies",
  status: "verified",
  matchTime: START,
  lines: [
    { speculationId: "1001", market: "moneyline", lineTicks: 0, speculationStatus: 0 },
    { speculationId: "1002", market: "total", lineTicks: 70, speculationStatus: 0 },
    { speculationId: "1003", market: "spread", lineTicks: -15, speculationStatus: 0 },
  ],
};

function quote(market: Market, fields: { lineTicks: number; makerPositionType: 0 | 1; oddsTick: number; risk: bigint; expiryMs?: number }): Quote {
  const expiryMs = fields.expiryMs ?? EXPIRY_MS;
  return {
    hash: `0x${"a1".repeat(32)}`,
    commitment: {
      maker: `0x${"11".repeat(20)}`,
      contestId: "481",
      scorer: SCORERS[market].toLowerCase(),
      lineTicks: fields.lineTicks,
      positionType: fields.makerPositionType,
      oddsTick: fields.oddsTick,
      riskAmount: fields.risk.toString(),
      nonce: "1",
      expiry: String(expiryMs / 1000),
    },
    signature: `0x${"22".repeat(65)}`,
    market,
    makerPositionType: fields.makerPositionType,
    remainingMakerRisk: fields.risk,
    expiryMs,
    storedStatus: "open",
    nonceInvalidated: false,
  };
}

describe("the connector's own literals", () => {
  it("Under 7.0, 2 USDC, from a quote posted at 2.05", () => {
    const over = quote("total", { lineTicks: 70, makerPositionType: 0, oddsTick: 205, risk: 5_000_000n });
    expect(preview(2_000_000n, over, rays, NOW)).toEqual([
      "Under 7.0 — Tampa Bay Rays @ Philadelphia Phillies, Sun Sep 27, 3:05 pm ET.",
      "Risk 2.00 USDC to win 1.90 at 1.95.",
      "A combined score of exactly 7 is a push: the stake is returned.",
      "Quote expires Sun Sep 27, 2:55 pm ET.",
      "Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.",
    ]);
  });

  it("the away team on the moneyline, 1 USDC, from a quote posted at 1.60 on the home team", () => {
    const home = quote("moneyline", { lineTicks: 0, makerPositionType: 1, oddsTick: 160, risk: 5_000_000n });
    expect(preview(1_000_000n, home, rays, NOW)).toEqual([
      "Tampa Bay Rays (away) to win — Tampa Bay Rays @ Philadelphia Phillies, Sun Sep 27, 3:05 pm ET.",
      "Risk 1.00 USDC to win 1.66 at 2.67.",
      "A tie is a push: the stake is returned.",
      "Quote expires Sun Sep 27, 2:55 pm ET.",
      "Exact amounts: you pay 0.999960 USDC and win 1.666600 USDC.",
    ]);
  });

  it("the away team at -1.5, 1 USDC, from a quote posted at 2.00: no push on a half point, no exact line", () => {
    const home = quote("spread", { lineTicks: -15, makerPositionType: 1, oddsTick: 200, risk: 4_000_000n });
    expect(preview(1_000_000n, home, rays, NOW)).toEqual([
      "Tampa Bay Rays (away) -1.5 — Tampa Bay Rays @ Philadelphia Phillies, Sun Sep 27, 3:05 pm ET.",
      "Risk 1.00 USDC to win 1.00 at 2.00.",
      "Quote expires Sun Sep 27, 2:55 pm ET.",
    ]);
  });

  it("names the start as the deadline when the quote outlives it", () => {
    const late = quote("spread", {
      lineTicks: -15,
      makerPositionType: 0,
      oddsTick: 200,
      risk: 4_000_000n,
      expiryMs: Date.UTC(2026, 8, 27, 20, 0, 0),
    });
    expect(preview(1_000_000n, late, rays, NOW)).toEqual([
      "Philadelphia Phillies (home) +1.5 — Tampa Bay Rays @ Philadelphia Phillies, Sun Sep 27, 3:05 pm ET.",
      "Risk 1.00 USDC to win 1.00 at 2.00.",
      "Take it before the game starts, Sun Sep 27, 3:05 pm ET. The quote itself expires later than that.",
    ]);
  });

  it("says so when the link asked for more than the quote has left", () => {
    const over = quote("total", { lineTicks: 70, makerPositionType: 0, oddsTick: 205, risk: 5_000_000n });
    // 5_000_000 left * 105 / 100 = 5_250_000 takes it all.
    expect(preview(10_000_000n, over, rays, NOW)).toEqual([
      "Under 7.0 — Tampa Bay Rays @ Philadelphia Phillies, Sun Sep 27, 3:05 pm ET.",
      "Risk 5.25 USDC to win 5.00 at 1.95.",
      "A combined score of exactly 7 is a push: the stake is returned.",
      "Quote expires Sun Sep 27, 2:55 pm ET.",
      "This quote can take 5.25 USDC, not the 10 asked for. The order is for 5.25.",
    ]);
  });
});
