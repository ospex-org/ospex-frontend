/**
 * `prepareAndSend` and `followAttempt` through the real ethers 5 provider,
 * over a test wallet, against the API's bodies for the live Under 47 quote
 * (kickoff 2026-10-04 13:30 UTC). The clock is the test's, so it can move
 * while the wallet is being read, as a slow node or network would move it.
 * The attempt records go to an in-memory storage that a test can hand to a
 * new store, which is what a reload does.
 */
import { ethers } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import quoteBody from "./fixtures/quote-under-47.json";
import contestBody from "./fixtures/contest-478.json";
import type { Fill } from "../src/lib/take/api";
import {
  IN_FLIGHT,
  PAGE_STOPPED,
  attemptStore,
  handoff,
  kickoffSentence,
  openAttempt,
  timeline,
  walletError,
  type AttemptStore,
} from "../src/lib/take/attempts";
import { COMMITMENT_TYPES, EIP712_DOMAIN, MATCHING_MODULE, SCORERS } from "../src/lib/take/constants";
import { assessTake, readContest, readQuote, type TakeView } from "../src/lib/take/quote";
import { followAttempt, prepareAndSend } from "../src/lib/take/send";
import { encodeMatchCommitment, hashCommitment } from "../src/lib/take/tx";
import { LATE_FILL } from "../src/lib/take/words";
import { TAKER, TX_HASH, fakeWallet, stubApi, type FakeWallet } from "./helpers/wallet";

const LINK_HASH = "0x44cfbdfe8524667942a3d8f9784d212fea27b852459091d7de5a440ad34a2617";
const KICKOFF = Date.UTC(2026, 9, 4, 13, 30, 0);
const GAME = "Indianapolis Colts @ Washington Commanders";
const TEN_OUT = KICKOFF - 10 * 60_000;

/** A fill this wallet made on the quote before the attempt, and the one the attempt made. */
const EARLIER_TX = `0x${"e1".repeat(32)}`;
const THIS_TX = `0x${"e2".repeat(32)}`;

function apiFill(txHash: string, filledAt: string) {
  return {
    speculationId: "994",
    contestId: "478",
    commitmentHash: LINK_HASH,
    maker: "0x5316fa54c170d1927f30d1a497ac9e85e3826a9b",
    taker: TAKER,
    makerPositionType: 0,
    takerPositionType: 1,
    makerRiskAmount: "943300",
    takerRiskAmount: "999898",
    makerRiskUSDC: 0.9433,
    takerRiskUSDC: 0.999898,
    oddsTick: 206,
    filledAt,
    contestStarted: false,
    txHash,
    logIndex: 3,
  };
}

function fill(txHash: string, filledAt: string): Fill {
  return { taker: TAKER, txHash, makerRisk: 943_300n, takerRisk: 999_898n, oddsTick: 206, filledAt };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const kept = new Map<string, string>();
  return {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => {
      kept.set(key, value);
    },
  };
}

function shownAt(nowMs: number): TakeView {
  const read = readQuote(quoteBody, LINK_HASH);
  const contest = readContest(contestBody);
  if (read.kind !== "quote" || contest === null) throw new Error("fixture did not read");
  const assessed = assessTake({ quote: read.quote, contest, requestedRisk: 1_000_000n, nowMs });
  if (!assessed.ok) throw new Error(assessed.lines.join(" "));
  return assessed.view;
}

function send(wallet: FakeWallet, attempts: AttemptStore, now: () => number) {
  return prepareAndSend({
    shown: shownAt(now()),
    requestedRisk: 1_000_000n,
    taker: TAKER,
    provider: wallet.provider,
    signer: wallet.signer,
    attempts,
    onWallet: () => undefined,
    now,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the last check before the wallet", () => {
  it("sends once, with the page's calldata, and records the attempt, when nothing moved", async () => {
    stubApi({ quote: quoteBody, contest: contestBody });
    const attempts = attemptStore(memoryStorage());
    const wallet = fakeWallet();
    const result = await send(wallet, attempts, () => TEN_OUT);
    expect(wallet.sends).toHaveLength(1);
    expect(wallet.sends[0]).toMatchObject({
      from: TAKER,
      to: MATCHING_MODULE.toLowerCase(),
      chainId: "0x89",
      data: encodeMatchCommitment(shownAt(TEN_OUT).quote.commitment, shownAt(TEN_OUT).quote.signature, 1_000_000n),
    });
    expect(result.kind).toBe("sent");
    expect(openAttempt(attempts, LINK_HASH, TAKER)).toMatchObject({
      status: "sent",
      hash: TX_HASH,
      takerDesiredRisk: "1000000",
      takerRisk: "999898",
      fillMakerRisk: "943300",
      startMs: KICKOFF,
      lastCheckAt: TEN_OUT,
      handoffAt: TEN_OUT,
      sentAt: TEN_OUT,
    });
  });

  it("refuses, and sends nothing, when the clock passes kickoff while the gas is estimated", async () => {
    stubApi({ quote: quoteBody, contest: contestBody });
    const attempts = attemptStore(memoryStorage());
    // The page was checked ten minutes out; the node then took eleven to answer.
    let t = TEN_OUT;
    const wallet = fakeWallet({
      onEstimateGas: () => {
        t = KICKOFF + 1_000;
      },
    });
    expect(await send(wallet, attempts, () => t)).toEqual({
      kind: "refused",
      lines: [`${GAME} started Sun Oct 4, 9:30 am ET. No bet is taken on a game under way.`, "Nothing was sent."],
    });
    expect(wallet.sends).toHaveLength(0);
    expect(attempts.list(LINK_HASH, TAKER)).toEqual([]);
  });

  it("refuses when the clock comes within two minutes of the start during the wallet reads", async () => {
    stubApi({ quote: quoteBody, contest: contestBody });
    let t = TEN_OUT;
    const wallet = fakeWallet({
      onEstimateGas: () => {
        t = KICKOFF - 60_000;
      },
    });
    expect(await send(wallet, attemptStore(memoryStorage()), () => t)).toEqual({
      kind: "refused",
      lines: [
        `${GAME} starts Sun Oct 4, 9:30 am ET, less than two minutes from now. That is too close to the start to take a quote.`,
        "Nothing was sent.",
      ],
    });
    expect(wallet.sends).toHaveLength(0);
  });
});

describe("a take whose outcome is lost", () => {
  it("stays open when the wallet takes the transaction and loses the answer, and blocks a second take", async () => {
    stubApi({ quote: quoteBody, contest: contestBody, fills: () => [apiFill(EARLIER_TX, "2026-09-29T06:06:42+00:00")] });
    const attempts = attemptStore(memoryStorage());
    const wallet = fakeWallet({
      onSend: () => {
        throw new Error("Failed to fetch");
      },
    });
    const first = await send(wallet, attempts, () => TEN_OUT);
    expect(wallet.sends).toHaveLength(1);
    expect(first).toMatchObject({
      kind: "unknown",
      attempt: { status: "unknown", hash: null, knownFills: [EARLIER_TX], note: walletError("Failed to fetch") },
    });
    expect(walletError("Failed to fetch")).toBe(
      "Your wallet answered with an error after it was asked to send the take (Failed to fetch), so the page cannot tell whether it was sent.",
    );

    const second = await send(fakeWallet(), attempts, () => TEN_OUT + 5_000);
    expect(second).toEqual({ kind: "refused", lines: [IN_FLIGHT] });
    expect(IN_FLIGHT).toBe(
      "A transaction for this bet may already be in flight: check your wallet's activity, or your address on " +
        "Polygonscan, and do not take this quote again unless you mean to place a second bet.",
    );
  });

  it("is released by a definite no from the wallet", async () => {
    stubApi({ quote: quoteBody, contest: contestBody });
    const attempts = attemptStore(memoryStorage());
    const declining = fakeWallet({
      onSend: () => {
        throw Object.assign(new Error("MetaMask Tx Signature: User denied transaction signature."), { code: 4001 });
      },
    });
    expect(await send(declining, attempts, () => TEN_OUT)).toEqual({
      kind: "refused",
      lines: ["You declined in your wallet.", "Nothing was sent."],
    });
    expect(attempts.list(LINK_HASH, TAKER).map((kept) => kept.status)).toEqual(["declined"]);
    expect(openAttempt(attempts, LINK_HASH, TAKER)).toBeNull();
    const again = fakeWallet();
    expect((await send(again, attempts, () => TEN_OUT + 5_000)).kind).toBe("sent");
    expect(again.sends).toHaveLength(1);
  });

  it("is not handed to the wallet when the browser will not keep its record", async () => {
    stubApi({ quote: quoteBody, contest: contestBody });
    const wallet = fakeWallet();
    expect(await send(wallet, attemptStore(null), () => TEN_OUT)).toEqual({
      kind: "refused",
      lines: [
        "This browser would not let the page keep a record of the bet, so it has not sent one. " +
          "Allow this site to store data, then reload.",
      ],
    });
    expect(wallet.sends).toHaveLength(0);
  });
});

describe("a reload while the outcome is unknown", () => {
  it("finds the attempt again, keeps it open until its own fill appears, then shows that fill", async () => {
    stubApi({ quote: quoteBody, contest: contestBody, fills: () => [apiFill(EARLIER_TX, "2026-09-29T06:06:42+00:00")] });
    const storage = memoryStorage();
    const lost = fakeWallet({
      onSend: () => {
        throw new Error("Failed to fetch");
      },
    });
    await send(lost, attemptStore(storage), () => TEN_OUT);

    // A reload is a new page over the same browser storage.
    const store = attemptStore(storage);
    const found = openAttempt(store, LINK_HASH, TAKER);
    expect(found?.status).toBe("unknown");
    expect(await send(fakeWallet(), store, () => TEN_OUT + 60_000)).toEqual({ kind: "refused", lines: [IN_FLIGHT] });

    const follow = (fills: Fill[]) =>
      followAttempt(found!, { store, provider: null, isCancelled: () => false, fills: async () => fills, tries: 1, intervalMs: 0 });
    // No fill yet, or only the one that was there before: still open.
    expect((await follow([])).status).toBe("unknown");
    expect((await follow([fill(EARLIER_TX, "2026-09-29T06:06:42+00:00")])).status).toBe("unknown");
    expect(openAttempt(store, LINK_HASH, TAKER)?.status).toBe("unknown");

    // The attempt's own fill arrives: shown, and the attempt is resolved.
    const resolved = await follow([fill(EARLIER_TX, "2026-09-29T06:06:42+00:00"), fill(THIS_TX, "2026-10-04T13:21:07+00:00")]);
    expect(resolved).toMatchObject({
      status: "recorded",
      hash: THIS_TX,
      fill: { txHash: THIS_TX, takerRisk: "999898", makerRisk: "943300", oddsTick: 206 },
    });
    expect(openAttempt(attemptStore(storage), LINK_HASH, TAKER)).toBeNull();
  });

  it("treats an attempt the page stopped on mid-handoff as unknown", async () => {
    const store = attemptStore(memoryStorage());
    const stopped = handoff({
      quote: LINK_HASH,
      taker: TAKER,
      takerDesiredRisk: 1_000_000n,
      takerRisk: 999_898n,
      fillMakerRisk: 943_300n,
      startMs: KICKOFF,
      startBlock: 1,
      knownFills: [],
      lastCheckAt: TEN_OUT,
      handoffAt: TEN_OUT,
    });
    store.save(stopped);
    const next = await followAttempt(stopped, { store, provider: null, isCancelled: () => false, now: () => TEN_OUT + 1 });
    expect(next).toMatchObject({ status: "unknown", note: PAGE_STOPPED });
    expect(PAGE_STOPPED).toBe(
      "The page was closed or reloaded while your wallet was asking you to confirm, so it cannot tell whether the take was sent.",
    );
    expect(openAttempt(store, LINK_HASH, TAKER)?.status).toBe("unknown");
  });
});

/**
 * A quote like the live one, but signed to expire an hour after kickoff, by a
 * key made for this test that holds nothing. The contract fills it until then.
 */
async function quoteOutlivingKickoff(): Promise<{ body: Record<string, unknown>; hash: string; maker: string }> {
  const signer = ethers.Wallet.createRandom();
  const message = {
    maker: signer.address.toLowerCase(),
    contestId: "478",
    scorer: SCORERS.total.toLowerCase(),
    lineTicks: 470,
    positionType: 0 as const,
    oddsTick: 206,
    riskAmount: "5000000",
    nonce: "1",
    expiry: String(KICKOFF / 1000 + 3_600),
  };
  const signature = await signer._signTypedData(EIP712_DOMAIN, COMMITMENT_TYPES, message);
  const hash = hashCommitment(message);
  return {
    body: { ...quoteBody, commitmentHash: hash, maker: message.maker, nonce: "1", expiry: "2026-10-04T14:30:00+00:00", signature },
    hash,
    maker: message.maker,
  };
}

/** The CommitmentMatched log a 1 USDC take of that quote writes, from the event as the contract declares it. */
function matchedLog(hash: string, maker: string) {
  const pad = (address: string) => ethers.utils.hexZeroPad(address, 32);
  return {
    address: MATCHING_MODULE,
    topics: [
      ethers.utils.id(
        "CommitmentMatched(bytes32,address,address,uint256,uint256,address,int32,uint8,uint16,uint256,uint256,uint256,uint256,uint256)",
      ),
      hash,
      pad(maker),
      pad(TAKER),
    ],
    data: ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint256", "address", "int32", "uint8", "uint16", "uint256", "uint256", "uint256", "uint256", "uint256"],
      [478, 994, SCORERS.total, 470, 0, 206, 943_300, 999_898, 5_000_000, 1, KICKOFF / 1000 + 3_600],
    ),
  };
}

describe("a quote whose signed expiry is later than the start", () => {
  it("says in the preview that a late confirmation can still fill after the game starts", async () => {
    const quote = await quoteOutlivingKickoff();
    const read = readQuote(quote.body, quote.hash);
    const contest = readContest(contestBody);
    if (read.kind !== "quote" || contest === null) throw new Error("fixture did not read");
    const assessed = assessTake({ quote: read.quote, contest, requestedRisk: 1_000_000n, nowMs: TEN_OUT });
    expect(assessed.ok && assessed.view.preview).toEqual([
      `Under 47.0 — ${GAME}, Sun Oct 4, 9:30 am ET.`,
      "Risk 1.00 USDC to win 0.94 at 1.94.",
      "A combined score of exactly 47 is a push: the stake is returned.",
      "Take it before the game starts, Sun Oct 4, 9:30 am ET. The quote itself expires later than that.",
      "If you confirm late in your wallet, or the network is slow, this bet can still fill after the game starts.",
      "Exact amounts: you pay 0.999898 USDC and win 0.943300 USDC.",
    ]);
    expect(LATE_FILL).toBe(
      "If you confirm late in your wallet, or the network is slow, this bet can still fill after the game starts.",
    );
  });

  it("is not refused when the wallet confirms after kickoff; it records the times and says it filled after kickoff", async () => {
    const quote = await quoteOutlivingKickoff();
    stubApi({ quote: quote.body, contest: contestBody });
    const storage = memoryStorage();
    const store = attemptStore(storage);
    let t = TEN_OUT;
    const wallet = fakeWallet({
      // Ten and a half minutes with the confirmation open in the wallet.
      onSend: () => {
        t = KICKOFF + 30_000;
        return TX_HASH;
      },
      mine: () => ({ blockNumber: 94_700_000, timestampMs: KICKOFF + 34_000, status: 1, logs: [matchedLog(quote.hash, quote.maker)] }),
    });
    const read = readQuote(quote.body, quote.hash);
    const contest = readContest(contestBody);
    if (read.kind !== "quote" || contest === null) throw new Error("fixture did not read");
    const assessed = assessTake({ quote: read.quote, contest, requestedRisk: 1_000_000n, nowMs: TEN_OUT });
    if (!assessed.ok) throw new Error(assessed.lines.join(" "));

    const result = await prepareAndSend({
      shown: assessed.view,
      requestedRisk: 1_000_000n,
      taker: TAKER,
      provider: wallet.provider,
      signer: wallet.signer,
      attempts: store,
      onWallet: () => undefined,
      now: () => t,
    });
    if (result.kind !== "sent") throw new Error(`expected a send, got ${JSON.stringify(result)}`);
    expect(wallet.sends).toHaveLength(1);
    expect(result.attempt).toMatchObject({ status: "sent", startMs: KICKOFF, lastCheckAt: TEN_OUT, handoffAt: TEN_OUT, sentAt: KICKOFF + 30_000 });

    const mined = await followAttempt(result.attempt, { store, provider: wallet.provider, isCancelled: () => false, now: () => t });
    expect(mined).toMatchObject({
      status: "confirmed",
      hash: TX_HASH,
      blockNumber: 94_700_000,
      minedAt: KICKOFF + 34_000,
      matched: { takerRisk: "999898", makerRisk: "943300", oddsTick: 206 },
    });
    expect(kickoffSentence(mined)).toBe(
      "Filled after kickoff: it was mined Sun Oct 4, 9:30:34 am ET, after the game's start at Sun Oct 4, 9:30 am ET.",
    );
    expect(timeline(mined)).toEqual([
      "Last check: Sun Oct 4, 9:20:00 am ET.",
      "Handed to your wallet: Sun Oct 4, 9:20:00 am ET.",
      "Sent: Sun Oct 4, 9:30:30 am ET.",
      "Mined: Sun Oct 4, 9:30:34 am ET, block 94700000.",
    ]);
    // A reload reads back the same record.
    expect(attemptStore(storage).list(quote.hash, TAKER)).toEqual([mined]);
  });

  it("does not say so when the take was mined before the start", async () => {
    const quote = await quoteOutlivingKickoff();
    stubApi({ quote: quote.body, contest: contestBody });
    const store = attemptStore(memoryStorage());
    const wallet = fakeWallet({
      mine: () => ({ blockNumber: 94_699_700, timestampMs: TEN_OUT + 4_000, status: 1, logs: [matchedLog(quote.hash, quote.maker)] }),
    });
    const read = readQuote(quote.body, quote.hash);
    const contest = readContest(contestBody);
    if (read.kind !== "quote" || contest === null) throw new Error("fixture did not read");
    const assessed = assessTake({ quote: read.quote, contest, requestedRisk: 1_000_000n, nowMs: TEN_OUT });
    if (!assessed.ok) throw new Error(assessed.lines.join(" "));
    const result = await prepareAndSend({
      shown: assessed.view,
      requestedRisk: 1_000_000n,
      taker: TAKER,
      provider: wallet.provider,
      signer: wallet.signer,
      attempts: store,
      onWallet: () => undefined,
      now: () => TEN_OUT,
    });
    if (result.kind !== "sent") throw new Error(`expected a send, got ${JSON.stringify(result)}`);
    const mined = await followAttempt(result.attempt, { store, provider: wallet.provider, isCancelled: () => false });
    expect(mined).toMatchObject({ status: "confirmed", minedAt: TEN_OUT + 4_000 });
    expect(kickoffSentence(mined)).toBeNull();
  });
});
