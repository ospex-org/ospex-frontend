/**
 * Reading the live Under 47 quote, binding it to its link, building its take,
 * and the refusals a person sees when a quote or its game cannot be taken.
 */
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import quoteBody from "./fixtures/quote-under-47.json";
import contestBody from "./fixtures/contest-478.json";
import { MATCHING_MODULE_ABI } from "../src/lib/take/constants";
import { assessTake, readContest, readQuote, type Contest, type Quote } from "../src/lib/take/quote";
import { encodeMatchCommitment, hashCommitment, recoverSigner } from "../src/lib/take/tx";

const LINK_HASH = "0x44cfbdfe8524667942a3d8f9784d212fea27b852459091d7de5a440ad34a2617";
const MAKER = "0x5316fa54c170d1927f30d1a497ac9e85e3826a9b";
const SEP_29_NOON = Date.UTC(2026, 8, 29, 12, 0, 0);
/** Kickoff, 2026-10-04 13:30 UTC. */
const KICKOFF = Date.UTC(2026, 9, 4, 13, 30, 0);

/**
 * The calldata @ospex/sdk 0.16.0's `matchFromPreview` built for this quote and
 * a 5 USDC request, taken from the transaction it handed its signer. Nothing
 * was sent.
 */
const SDK_CALLDATA =
  "0x8ae4b105" +
  "0000000000000000000000005316fa54c170d1927f30d1a497ac9e85e3826a9b" +
  "00000000000000000000000000000000000000000000000000000000000001de" +
  "000000000000000000000000b4b1e2a2a75c34e9e4c5d3bb8a432aff973dada0" +
  "00000000000000000000000000000000000000000000000000000000000001d6" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000000000000000000000000000000000000000000ce" +
  "00000000000000000000000000000000000000000000000000000000004c4b40" +
  "000000000000000000000000000000000000000000000000000000006abb37a0" +
  "000000000000000000000000000000000000000000000000000000006ac254d8" +
  "0000000000000000000000000000000000000000000000000000000000000160" +
  "00000000000000000000000000000000000000000000000000000000004c4b40" +
  "0000000000000000000000000000000000000000000000000000000000000041" +
  "060fd48eac697af8c88380cc221061e363f9ddd985bb4f9f842e4a14319fb5dc" +
  "4f3d25b8010e2e312f854053bd4db1919a106e14f2116221f2359dc74cdf745c" +
  "1b00000000000000000000000000000000000000000000000000000000000000";

function liveQuote(body: unknown = quoteBody): Quote {
  const read = readQuote(body, LINK_HASH);
  if (read.kind !== "quote") throw new Error(`fixture did not read: ${JSON.stringify(read)}`);
  return read.quote;
}

function liveContest(overrides: Partial<Record<string, unknown>> = {}): Contest {
  const contest = readContest({ ...contestBody, ...overrides });
  if (contest === null) throw new Error("fixture did not read");
  return contest;
}

describe("the quote the link names", () => {
  it("hashes its nine signed fields to the link's hash, and its signature recovers to its maker", () => {
    const quote = liveQuote();
    expect(hashCommitment(quote.commitment)).toBe(LINK_HASH);
    expect(recoverSigner(quote.commitment, quote.signature)).toBe(MAKER);
    expect(quote.commitment).toEqual({
      maker: MAKER,
      contestId: "478",
      scorer: "0xb4b1e2a2a75c34e9e4c5d3bb8a432aff973dada0",
      lineTicks: 470,
      positionType: 0,
      oddsTick: 206,
      riskAmount: "5000000",
      nonce: "1790654368",
      // 2026-10-04T13:30:00Z
      expiry: "1791120600",
    });
    expect(quote.market).toBe("total");
  });

  it("builds the same calldata as the SDK, carrying the 5 USDC asked for, not the 4.999914 paid", () => {
    const quote = liveQuote();
    const data = encodeMatchCommitment(quote.commitment, quote.signature, 5_000_000n);
    expect(data).toBe(SDK_CALLDATA);
    const decoded = new ethers.utils.Interface(MATCHING_MODULE_ABI).decodeFunctionData("matchCommitment", data);
    expect(decoded.takerDesiredRisk.toString()).toBe("5000000");
    expect(decoded.commitment.riskAmount.toString()).toBe("5000000");
    expect(decoded.signature).toBe(quote.signature);
  });

  it("refuses fields that do not hash to the link, a signature that is not the maker's, and a withdrawn quote", () => {
    expect(readQuote({ ...quoteBody, oddsTick: 205 }, LINK_HASH)).toEqual({
      kind: "bad",
      reason: "This quote's signed fields do not match the quote this link names, so nothing will be sent.",
    });
    // Same r, a different s: a well-formed signature by somebody else, or by nobody.
    const forged = `${quoteBody.signature.slice(0, 66)}${"1".repeat(64)}${quoteBody.signature.slice(130)}`;
    expect(readQuote({ ...quoteBody, signature: forged }, LINK_HASH)).toEqual({
      kind: "bad",
      reason: "This quote's signature does not match its maker, so nothing will be sent.",
    });
    expect(readQuote({ ...quoteBody, commitmentHash: `0x${"ab".repeat(32)}` }, LINK_HASH)).toEqual({
      kind: "bad",
      reason: "Ospex returned a different quote from the one this link names, so nothing will be sent.",
    });
    // The API's body for a quote its maker took off the book: no signed fields.
    const hidden = {
      commitmentHash: LINK_HASH,
      maker: MAKER,
      contestId: "478",
      positionType: 0,
      status: "open",
      storedStatus: "open",
      filledRiskAmount: "0",
      expiry: "2026-10-04T13:30:00+00:00",
      bookVisible: false,
      nonceInvalidated: false,
      redacted: true,
      payloadAvailable: false,
    };
    expect(readQuote(hidden, LINK_HASH)).toEqual({ kind: "withdrawn" });
    // The unaltered body is the control: it reads.
    expect(readQuote(quoteBody, LINK_HASH).kind).toBe("quote");
  });
});

describe("what a person is told when the take cannot go ahead", () => {
  const take = (args: { quote?: Quote; contest?: Contest; risk?: bigint; nowMs?: number }) =>
    assessTake({
      quote: args.quote ?? liveQuote(),
      contest: args.contest ?? liveContest(),
      requestedRisk: args.risk ?? 5_000_000n,
      nowMs: args.nowMs ?? SEP_29_NOON,
    });

  it("goes ahead days before kickoff", () => {
    expect(take({}).ok).toBe(true);
  });

  it("refuses a game under way, and one about to start", () => {
    expect(take({ nowMs: KICKOFF + 1 })).toEqual({
      ok: false,
      lines: ["Indianapolis Colts @ Washington Commanders started Sun Oct 4, 9:30 am ET. No bet is taken on a game under way."],
    });
    expect(take({ nowMs: KICKOFF - 60_000 })).toEqual({
      ok: false,
      lines: [
        "Indianapolis Colts @ Washington Commanders starts Sun Oct 4, 9:30 am ET, less than two minutes from now. " +
          "That is too close to the start to take a quote.",
      ],
    });
    // Two minutes and a second out is still open.
    expect(take({ nowMs: KICKOFF - 121_000 }).ok).toBe(true);
  });

  it("refuses a game that is not verified", () => {
    expect(take({ contest: liveContest({ status: "scored" }) })).toEqual({
      ok: false,
      lines: ["Indianapolis Colts @ Washington Commanders is not open for betting: its contest is scored."],
    });
  });

  it("refuses a quote taken in full or cancelled", () => {
    expect(take({ quote: { ...liveQuote(), storedStatus: "filled" } })).toEqual({
      ok: false,
      lines: ["This quote has been taken in full."],
    });
    expect(take({ quote: { ...liveQuote(), nonceInvalidated: true } })).toEqual({
      ok: false,
      lines: ["The maker has cancelled this quote."],
    });
  });

  it("refuses a quote whose line is not open on-chain, since taking it would charge a fee", () => {
    const noTotal = liveContest({
      speculations: (contestBody.speculations as Array<{ type: string }>).filter((line) => line.type !== "total"),
    });
    expect(take({ contest: noTotal })).toEqual({
      ok: false,
      lines: [
        "Indianapolis Colts @ Washington Commanders has no total line at 47.0 on-chain yet. " +
          "Taking this quote would open the line and charge a fee, so this page will not take it.",
      ],
    });
  });

  it("refuses an amount too small to fill a lot", () => {
    expect(take({ risk: 100n })).toEqual({
      ok: false,
      lines: ["0.0001 USDC is too small to take this quote for Under 47.0. The smallest is 0.000105 USDC."],
    });
  });
});
