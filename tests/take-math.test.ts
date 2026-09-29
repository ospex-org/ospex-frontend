/**
 * The page's take arithmetic, against the SDK's.
 *
 * The vectors were produced by `buildMatchPreview` in @ospex/sdk 0.16.0, one
 * call per row, so none of their answers came from the code under test. The
 * literal cases after them were worked by hand from the contract's rule:
 *
 *     profit ticks = maker tick - 100
 *     fill         = ceil(asked * 100 / profit ticks), rounded DOWN to a multiple of 100
 *     pays         = floor(fill * profit ticks / 100), and never more than asked
 *     wins         = fill
 */
import { describe, expect, it } from "vitest";
import vectors from "./fixtures/take-math-vectors.json";
import { maxTakerRisk, minTakerRisk, parseUsdc, planTake, simulateMatch, takerOddsTick } from "../src/lib/take/math";

type Row = [number, string, string, 0 | 1, string?, string?, number?, (0 | 1)?];

describe("take arithmetic against @ospex/sdk's buildMatchPreview", () => {
  const rows = vectors.rows as unknown as Row[];

  it("agrees on every vector, amounts and refusals both", () => {
    expect(rows).toHaveLength(367);
    let accepted = 0;
    let refused = 0;
    for (const [oddsTick, remaining, desired, ok, fill, taker, takerTick, partial] of rows) {
      const got = simulateMatch({
        oddsTick,
        remainingMakerRisk: BigInt(remaining),
        takerDesiredRisk: BigInt(desired),
      });
      if (ok === 1) {
        accepted += 1;
        expect(got, `tick ${String(oddsTick)} left ${remaining} asked ${desired}`).toEqual({
          accepted: true,
          fillMakerRisk: BigInt(fill as string),
          takerRisk: BigInt(taker as string),
        });
        expect(takerOddsTick(oddsTick)).toBe(takerTick);
        expect(BigInt(fill as string) < BigInt(remaining)).toBe(partial === 1);
      } else {
        refused += 1;
        expect(got.accepted, `tick ${String(oddsTick)} left ${remaining} asked ${desired}`).toBe(false);
      }
    }
    // Both kinds of row are there, so neither branch above is idle.
    expect(accepted).toBe(178);
    expect(refused).toBe(189);
  });
});

describe("the live Under 47 quote: posted at 2.06 for 5 USDC of maker risk", () => {
  it("takes 5 USDC: pays 4.999914, wins 4.716900, at 1.94", () => {
    // 106 profit ticks. ceil(500_000_000 / 106) = 4_716_982, down to 4_716_900.
    // floor(4_716_900 * 106 / 100) = 4_999_914.
    expect(planTake({ oddsTick: 206, remainingMakerRisk: 5_000_000n, requestedTakerRisk: 5_000_000n })).toEqual({
      ok: true,
      plan: {
        requestedTakerRisk: 5_000_000n,
        takerDesiredRisk: 5_000_000n,
        fillMakerRisk: 4_716_900n,
        takerRisk: 4_999_914n,
        reduced: false,
        takerOddsTick: 194,
      },
    });
  });

  it("cuts a request larger than the quote to everything left, 5.30, rather than let it revert", () => {
    // 5_000_000 left * 106 / 100 = 5_300_000, which fills the 5_000_000 exactly.
    expect(maxTakerRisk(206, 5_000_000n)).toBe(5_300_000n);
    expect(planTake({ oddsTick: 206, remainingMakerRisk: 5_000_000n, requestedTakerRisk: 10_000_000n })).toEqual({
      ok: true,
      plan: {
        requestedTakerRisk: 10_000_000n,
        takerDesiredRisk: 5_300_000n,
        fillMakerRisk: 5_000_000n,
        takerRisk: 5_300_000n,
        reduced: true,
        takerOddsTick: 194,
      },
    });
    // The request as asked would revert on-chain.
    expect(simulateMatch({ oddsTick: 206, remainingMakerRisk: 5_000_000n, takerDesiredRisk: 10_000_000n })).toEqual({
      accepted: false,
      reason: "exceeds_remaining",
    });
  });

  it("refuses an amount below one lot, and names the smallest that fills one", () => {
    // 105 fills one lot: ceil(10_500 / 106) = 100. 104 does not: ceil(10_400 / 106) = 99, down to 0.
    expect(minTakerRisk(206)).toBe(105n);
    expect(planTake({ oddsTick: 206, remainingMakerRisk: 5_000_000n, requestedTakerRisk: 104n })).toEqual({
      ok: false,
      reason: "too_small",
      minTakerRisk: 105n,
    });
    expect(planTake({ oddsTick: 206, remainingMakerRisk: 5_000_000n, requestedTakerRisk: 105n }).ok).toBe(true);
  });
});

describe("the amount in a link", () => {
  it("reads plain decimals into base units without a float", () => {
    expect(parseUsdc("5")).toEqual({ ok: true, baseUnits: 5_000_000n });
    expect(parseUsdc("2.5")).toEqual({ ok: true, baseUnits: 2_500_000n });
    expect(parseUsdc("0.000001")).toEqual({ ok: true, baseUnits: 1n });
    // 0.1 + 0.2 is not 0.3 in a float; here it is exact.
    expect(parseUsdc("0.3")).toEqual({ ok: true, baseUnits: 300_000n });
  });

  it("refuses anything else", () => {
    expect(parseUsdc("0.0000001")).toEqual({ ok: false, reason: "too_many_decimals" });
    expect(parseUsdc("1e3")).toEqual({ ok: false, reason: "not_a_decimal" });
    expect(parseUsdc(" 5")).toEqual({ ok: false, reason: "not_a_decimal" });
    expect(parseUsdc("")).toEqual({ ok: false, reason: "not_a_decimal" });
    expect(parseUsdc("0")).toEqual({ ok: false, reason: "not_positive" });
    expect(parseUsdc("-5")).toEqual({ ok: false, reason: "not_positive" });
    expect(parseUsdc("1000000.000001")).toEqual({ ok: false, reason: "too_large" });
    expect(parseUsdc("1000000")).toEqual({ ok: true, baseUnits: 1_000_000_000_000n });
  });
});
