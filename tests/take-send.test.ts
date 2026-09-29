/**
 * `prepareAndSend` through the real ethers 5 provider, over a test wallet,
 * against the API's bodies for the live Under 47 quote (kickoff 2026-10-04
 * 13:30 UTC). The clock is the test's, so it can move while the wallet is
 * being read, as a slow node or a slow network would move it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import quoteBody from "./fixtures/quote-under-47.json";
import contestBody from "./fixtures/contest-478.json";
import { MATCHING_MODULE } from "../src/lib/take/constants";
import { assessTake, readContest, readQuote, type TakeView } from "../src/lib/take/quote";
import { prepareAndSend } from "../src/lib/take/send";
import { encodeMatchCommitment } from "../src/lib/take/tx";
import { TAKER, TX_HASH, fakeWallet, stubApi } from "./helpers/wallet";

const LINK_HASH = "0x44cfbdfe8524667942a3d8f9784d212fea27b852459091d7de5a440ad34a2617";
const KICKOFF = Date.UTC(2026, 9, 4, 13, 30, 0);
const GAME = "Indianapolis Colts @ Washington Commanders";

function shownAt(nowMs: number): TakeView {
  const read = readQuote(quoteBody, LINK_HASH);
  const contest = readContest(contestBody);
  if (read.kind !== "quote" || contest === null) throw new Error("fixture did not read");
  const assessed = assessTake({ quote: read.quote, contest, requestedRisk: 1_000_000n, nowMs });
  if (!assessed.ok) throw new Error(assessed.lines.join(" "));
  return assessed.view;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the last check before the wallet", () => {
  it("sends once, with the page's calldata, when nothing moved", async () => {
    stubApi({ quote: quoteBody, contest: contestBody });
    const t = KICKOFF - 10 * 60_000;
    const shown = shownAt(t);
    const wallet = fakeWallet();
    const result = await prepareAndSend({
      shown,
      requestedRisk: 1_000_000n,
      taker: TAKER,
      provider: wallet.provider,
      signer: wallet.signer,
      onWallet: () => undefined,
      now: () => t,
    });
    expect(result).toMatchObject({ ok: true, hash: TX_HASH });
    expect(wallet.sends).toHaveLength(1);
    expect(wallet.sends[0]).toMatchObject({
      from: TAKER,
      to: MATCHING_MODULE.toLowerCase(),
      chainId: "0x89",
      data: encodeMatchCommitment(shown.quote.commitment, shown.quote.signature, 1_000_000n),
    });
  });

  it("refuses, and sends nothing, when the clock passes kickoff while the gas is estimated", async () => {
    stubApi({ quote: quoteBody, contest: contestBody });
    // The page was checked ten minutes out; the node then took eleven to answer.
    let t = KICKOFF - 10 * 60_000;
    const wallet = fakeWallet({
      onEstimateGas: () => {
        t = KICKOFF + 1_000;
      },
    });
    const result = await prepareAndSend({
      shown: shownAt(t),
      requestedRisk: 1_000_000n,
      taker: TAKER,
      provider: wallet.provider,
      signer: wallet.signer,
      onWallet: () => undefined,
      now: () => t,
    });
    expect(result).toEqual({
      ok: false,
      lines: [`${GAME} started Sun Oct 4, 9:30 am ET. No bet is taken on a game under way.`, "Nothing was sent."],
    });
    expect(wallet.sends).toHaveLength(0);
  });

  it("refuses when the clock comes within two minutes of the start during the wallet reads", async () => {
    stubApi({ quote: quoteBody, contest: contestBody });
    let t = KICKOFF - 10 * 60_000;
    const wallet = fakeWallet({
      onEstimateGas: () => {
        t = KICKOFF - 60_000;
      },
    });
    const result = await prepareAndSend({
      shown: shownAt(t),
      requestedRisk: 1_000_000n,
      taker: TAKER,
      provider: wallet.provider,
      signer: wallet.signer,
      onWallet: () => undefined,
      now: () => t,
    });
    expect(result).toEqual({
      ok: false,
      lines: [
        `${GAME} starts Sun Oct 4, 9:30 am ET, less than two minutes from now. That is too close to the start to take a quote.`,
        "Nothing was sent.",
      ],
    });
    expect(wallet.sends).toHaveLength(0);
  });
});
