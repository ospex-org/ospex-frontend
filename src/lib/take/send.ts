/**
 * Sending a take, and following it until Ospex has recorded the fill.
 *
 * `prepareAndSend` follows `@ospex/sdk`'s `matchFromPreview`, which re-reads
 * everything before it sends, however recent the preview. The wallet's chain,
 * address, USDC and approval are read again; the transaction is run as a call,
 * so a take the chain would refuse at that moment is refused here in words
 * instead of costing gas; and its gas is estimated with the SDK's 10% cushion.
 *
 * Then, as the last step before the wallet sees it, the quote and the game are
 * fetched again and put through the same checks as the preview, against the
 * clock as it reads after every one of those awaits, and the amounts must still
 * be the ones the person was shown. A read that is slow, or a clock that
 * crosses the start while the wallet is being read, is caught there rather than
 * at the top.
 *
 * `from` is set, so ethers will not send it from any other account, and
 * `chainId` is set for the wallet to check against the network it is on.
 *
 * Every take is an attempt with a record (`attempts.ts`), written before the
 * wallet is asked and again at each change, and carrying the wallet's
 * transaction count as read just before. An attempt whose outcome is not known
 * blocks the next take until its fill is found, until the count shows that
 * nothing was sent, or until the person ticks that taking the quote again may
 * place a second bet. `followAttempt` takes one step towards knowing it,
 * whether the attempt began on this page or before a reload.
 */

import { ethers } from "ethers";
import { getCommitment, getContest, getFills, type Fill } from "./api";
import {
  IN_FLIGHT,
  PAGE_STOPPED,
  fillOf,
  handoff,
  openAttempt,
  recorded,
  sentSinceHandoff,
  update,
  walletError,
  type Attempt,
  type AttemptStore,
  type TxCount,
} from "./attempts";
import { MATCHING_MODULE, POLYGON_CHAIN_ID, USDC } from "./constants";
import { readWallet, walletProblems, walletReads } from "./checks";
import { assessTake, readContest, readQuote, sameTake, type TakeView } from "./quote";
import {
  describeRevert,
  encodeApprove,
  encodeMatchCommitment,
  findRevertData,
  isUserRejection,
  matchedEvent,
  shortReason,
  type MatchedEvent,
} from "./tx";

const NOTHING_SENT = "Nothing was sent.";

export type Refusal = { ok: false; lines: string[]; view?: TakeView };

/**
 * Fetch the quote and its game again, and assess them as the preview did, at
 * the clock's reading once both have arrived. `checkedAt` is that reading.
 * The taker's fills on the quote are read in the same round, so an attempt can
 * tell its own fill from one that was already there.
 */
export async function reassess(
  hash: string,
  contestId: string,
  requestedRisk: bigint,
  taker: string,
  now: () => number = Date.now,
): Promise<{ ok: true; view: TakeView; checkedAt: number; knownFills: string[] } | Refusal> {
  const [quoteRead, contestRead, fills] = await Promise.all([
    getCommitment(hash),
    getContest(contestId),
    getFills(hash, taker.toLowerCase()),
  ]);
  if (!quoteRead.ok) return { ok: false, lines: [`The quote could not be read again. ${quoteRead.message}`, NOTHING_SENT] };
  if (!contestRead.ok) return { ok: false, lines: [`The game could not be read again. ${contestRead.message}`, NOTHING_SENT] };
  if (fills === null) {
    return {
      ok: false,
      lines: ["Ospex's list of fills could not be read, so the page could not keep track of this bet.", NOTHING_SENT],
    };
  }
  const read = readQuote(quoteRead.body, hash);
  if (read.kind === "withdrawn") return { ok: false, lines: ["The maker has withdrawn this quote.", NOTHING_SENT] };
  if (read.kind === "bad") return { ok: false, lines: [read.reason] };
  const contest = readContest(contestRead.body);
  if (contest === null) return { ok: false, lines: ["Ospex returned this game in a form this page cannot read.", NOTHING_SENT] };
  const checkedAt = now();
  const assessment = assessTake({ quote: read.quote, contest, requestedRisk, nowMs: checkedAt });
  if (!assessment.ok) return { ok: false, lines: [...assessment.lines, NOTHING_SENT] };
  return { ok: true, view: assessment.view, checkedAt, knownFills: fills.map((fill) => fill.txHash) };
}

function refusalFromError(err: unknown, lead: string): string[] {
  const data = findRevertData(err);
  const described = data === null ? null : describeRevert(data);
  if (described !== null) return [described, NOTHING_SENT];
  return [`${lead} (${shortReason(err)}).`, NOTHING_SENT];
}

export type SendResult =
  /** The wallet sent it and returned its hash. */
  | { kind: "sent"; attempt: Attempt }
  /** The wallet was asked and answered with an error: the take may be in flight. */
  | { kind: "unknown"; attempt: Attempt }
  /** Nothing was sent. A `view` means the quote changed: that view is the new preview. */
  | { kind: "refused"; lines: string[]; view?: TakeView };

function refused(from: Refusal): SendResult {
  return from.view === undefined ? { kind: "refused", lines: from.lines } : { kind: "refused", lines: from.lines, view: from.view };
}

/**
 * Check the wallet again, run the take as a call, estimate its gas, then check
 * the quote, the game and the clock one last time, write the attempt down, and
 * hand it to the wallet. Resolves once the wallet has answered.
 *
 * An unresolved attempt on this quote from this wallet, from this page or from
 * before a reload, refuses at once: its transaction may be in flight. The one
 * exception is an attempt whose outcome is unknown and which the person has
 * acknowledged, by ticking that taking the quote again may place a second bet.
 */
export async function prepareAndSend(args: {
  shown: TakeView;
  requestedRisk: bigint;
  taker: string;
  provider: ethers.providers.Web3Provider;
  signer: ethers.providers.JsonRpcSigner;
  attempts: AttemptStore;
  /** Called just before the wallet is asked to confirm. */
  onWallet: () => void;
  /** The clock. A test passes one it can move. */
  now?: () => number;
  /** The id of the unknown attempt the person ticked "may place a second bet" for. */
  acknowledged?: string | undefined;
}): Promise<SendResult> {
  const result = await prepare(args);
  return "kind" in result ? result : refused(result);
}

async function prepare(args: Parameters<typeof prepareAndSend>[0]): Promise<SendResult | Refusal> {
  const { shown, requestedRisk, provider, signer, onWallet, attempts } = args;
  const now = args.now ?? Date.now;
  const taker = args.taker.toLowerCase();
  // Everything before the last check works from the take the person was
  // shown. The last check refuses if the quote no longer gives those amounts.
  const view = shown;

  const open = openAttempt(attempts, view.quote.hash, taker);
  if (open !== null && !(open.status === "unknown" && open.id === args.acknowledged)) {
    return { ok: false, lines: [IN_FLIGHT] };
  }

  let signerAddress: string;
  try {
    signerAddress = (await signer.getAddress()).toLowerCase();
  } catch (err) {
    return { ok: false, lines: [`Your wallet did not say which account is connected (${shortReason(err)}).`, NOTHING_SENT] };
  }
  if (signerAddress !== taker) {
    return { ok: false, lines: ["The account in your wallet changed. Check the page again, then confirm.", NOTHING_SENT] };
  }

  try {
    const state = await readWallet(walletReads(provider), taker, view.quote.commitment.maker);
    const problems = walletProblems(state, {
      takerRisk: view.plan.takerRisk,
      fillMakerRisk: view.plan.fillMakerRisk,
      maker: view.quote.commitment.maker,
    });
    if (problems.length > 0) return { ok: false, lines: [...problems.map((p) => p.text), NOTHING_SENT] };
  } catch (err) {
    return { ok: false, lines: [`Your wallet could not be read just now (${shortReason(err)}).`, NOTHING_SENT] };
  }

  const data = encodeMatchCommitment(view.quote.commitment, view.quote.signature, view.plan.takerDesiredRisk);
  const request = { from: taker, to: MATCHING_MODULE, data };

  try {
    // ethers returns a revert's data as the result of a call. A take returns nothing.
    const result = await provider.call(request);
    if (result !== "0x") {
      return { ok: false, lines: [describeRevert(result) ?? "The contract would refuse this take.", NOTHING_SENT] };
    }
  } catch (err) {
    return { ok: false, lines: refusalFromError(err, "The take could not be checked with the chain") };
  }

  let gasLimit: ethers.BigNumber;
  let startBlock: number;
  try {
    // The SDK's cushion: estimated gas plus 10%.
    gasLimit = (await provider.estimateGas(request)).mul(110).div(100);
    startBlock = await provider.getBlockNumber();
  } catch (err) {
    return { ok: false, lines: refusalFromError(err, "The network fee could not be worked out") };
  }

  let nonce: TxCount;
  try {
    // Kept with the attempt: if the count has not moved when an unknown outcome
    // is looked into, nothing was sent.
    nonce = await txCount(provider, taker);
  } catch (err) {
    return { ok: false, lines: [`Your wallet's transaction count could not be read just now (${shortReason(err)}).`, NOTHING_SENT] };
  }

  // The last check, after every await above and as the final step before the
  // wallet: the quote and the game read again and judged against the clock as
  // it is now. The signed expiry is never touched.
  const fresh = await reassess(view.quote.hash, view.quote.commitment.contestId, requestedRisk, taker, now);
  if (!fresh.ok) return fresh;
  if (!sameTake(view, fresh.view)) {
    return {
      ok: false,
      lines: ["The quote changed since this page showed it. Check the amounts again, then confirm.", NOTHING_SENT],
      view: fresh.view,
    };
  }

  // Written before the wallet is asked, so that a reload from here on finds it,
  // or, in a browser that keeps nothing, so that this page does.
  const handoffAt = now();
  let attempt = handoff({
    quote: view.quote.hash,
    taker,
    takerDesiredRisk: view.plan.takerDesiredRisk,
    takerRisk: view.plan.takerRisk,
    fillMakerRisk: view.plan.fillMakerRisk,
    startMs: fresh.view.startMs,
    startBlock,
    knownFills: fresh.knownFills,
    nonce,
    lastCheckAt: fresh.checkedAt,
    handoffAt,
  });
  // The acknowledged attempt is set aside only now, as the new take goes to the
  // wallet. A refusal before this point leaves it open.
  if (open !== null) attempts.save(update(open, { status: "acknowledged", acknowledgedAt: handoffAt }, handoffAt));
  attempts.save(attempt);

  onWallet();
  try {
    const hash = await signer.sendUncheckedTransaction({ ...request, gasLimit, chainId: POLYGON_CHAIN_ID });
    attempt = update(attempt, { status: "sent", hash: hash.toLowerCase(), sentAt: now() }, now());
    attempts.save(attempt);
    return { kind: "sent", attempt };
  } catch (err) {
    if (isUserRejection(err)) {
      attempts.save(update(attempt, { status: "declined" }, now()));
      return { ok: false, lines: ["You declined in your wallet.", NOTHING_SENT] };
    }
    // Anything else leaves the outcome open: the wallet may have sent it and
    // lost the answer. The attempt stays unresolved until its fill is found.
    attempt = update(attempt, { status: "unknown", note: walletError(shortReason(err)) }, now());
    attempts.save(attempt);
    return { kind: "unknown", attempt };
  }
}

export type Mined =
  /** `minedAt` is the block's time, or null when the block could not be read. */
  | { status: "confirmed"; hash: string; blockNumber: number; minedAt: number | null; matched: MatchedEvent | null }
  /** Definitely not placed: mined and reverted, or replaced by the wallet with something else. */
  | { status: "failed"; hash: string; lines: string[] }
  /** Not followed to an end: the transaction may still be mined. */
  | { status: "lost"; hash: string; lines: string[] };

/**
 * Wait for a sent transaction to be mined. A transaction the wallet sped up
 * (same call, higher fee) is followed to its replacement; one it cancelled or
 * replaced with something else is reported as not placed. One that cannot be
 * followed is reported as lost, not failed: it may still be mined.
 */
export async function waitForMined(args: {
  provider: ethers.providers.Web3Provider;
  hash: string;
  startBlock: number;
  commitmentHash: string | null;
}): Promise<Mined> {
  const { provider, hash, startBlock, commitmentHash } = args;
  let tx: ethers.providers.TransactionResponse | null = null;
  for (let attempt = 0; attempt < 60 && tx === null; attempt += 1) {
    try {
      tx = await provider.getTransaction(hash);
    } catch {
      tx = null;
    }
    if (tx === null) await sleep(2_000);
  }
  if (tx === null) {
    return {
      status: "lost",
      hash,
      lines: ["Your wallet sent the transaction, but Polygon has not shown it for two minutes. Check it on Polygonscan."],
    };
  }
  const response = provider._wrapTransaction(tx, hash, startBlock);
  try {
    const receipt = await response.wait(1);
    return await confirmed(provider, receipt, commitmentHash);
  } catch (err) {
    const e = err as {
      code?: unknown;
      reason?: unknown;
      cancelled?: unknown;
      receipt?: ethers.providers.TransactionReceipt;
      replacement?: { hash?: string };
    };
    if (e.code === ethers.errors.TRANSACTION_REPLACED) {
      if (e.reason === "repriced" && e.receipt !== undefined) {
        if (e.receipt.status === 1) return await confirmed(provider, e.receipt, commitmentHash);
        return failedOnChain(e.receipt.transactionHash);
      }
      return {
        status: "failed",
        hash: (e.replacement?.hash ?? hash).toLowerCase(),
        lines: ["Your wallet cancelled or replaced the transaction. No bet was placed."],
      };
    }
    if (e.code === ethers.errors.CALL_EXCEPTION && e.receipt !== undefined) {
      return failedOnChain(e.receipt.transactionHash);
    }
    return { status: "lost", hash, lines: [`Waiting for the transaction failed (${shortReason(err)}). Check it on Polygonscan.`] };
  }
}

async function confirmed(
  provider: ethers.providers.Web3Provider,
  receipt: ethers.providers.TransactionReceipt,
  commitmentHash: string | null,
): Promise<Mined> {
  let minedAt: number | null = null;
  try {
    minedAt = (await provider.getBlock(receipt.blockNumber)).timestamp * 1000;
  } catch {
    minedAt = null;
  }
  return {
    status: "confirmed",
    hash: receipt.transactionHash.toLowerCase(),
    blockNumber: receipt.blockNumber,
    minedAt,
    matched: commitmentHash === null ? null : matchedEvent(receipt.logs, commitmentHash),
  };
}

function failedOnChain(hash: string): Mined {
  return {
    status: "failed",
    hash: hash.toLowerCase(),
    lines: ["The transaction was mined but failed, so no bet was placed. Only the network fee was spent."],
  };
}

/**
 * Take one step towards knowing how an unresolved attempt ended, save the
 * attempt if the step changed it, and return it.
 *
 *   handoff    only a reload finds one, so the page stopped while the wallet was
 *              asking: the attempt becomes unknown
 *   sent       follow the transaction until it is mined (needs the wallet)
 *   confirmed  look for its fill, under its hash
 *   unknown    look for its fill: under its hash if it has one, otherwise a fill
 *              from this wallet on this quote that was not there at the handoff;
 *              after a round that finds none, read the wallet's transaction
 *              count once: not moved since the handoff, nothing was sent and the
 *              attempt becomes unsent; moved, it stays open
 *
 * A fill appears once its block is final, usually within about fifteen seconds
 * of confirming, so the API is asked every three seconds for up to three
 * minutes. An attempt returned unchanged is still open.
 */
export async function followAttempt(
  attempt: Attempt,
  deps: {
    store: AttemptStore;
    provider: ethers.providers.Web3Provider | null;
    isCancelled: () => boolean;
    now?: () => number;
    fills?: (quote: string, taker: string) => Promise<Fill[] | null>;
    tries?: number;
    intervalMs?: number;
  },
): Promise<Attempt> {
  const now = deps.now ?? Date.now;
  const save = (next: Attempt): Attempt => {
    deps.store.save(next);
    return next;
  };

  if (attempt.status === "handoff") {
    return save(update(attempt, { status: "unknown", note: PAGE_STOPPED }, now()));
  }

  if (attempt.status === "sent") {
    if (deps.provider === null || attempt.hash === null) return attempt;
    const mined = await waitForMined({
      provider: deps.provider,
      hash: attempt.hash,
      startBlock: attempt.startBlock,
      commitmentHash: attempt.quote,
    });
    if (deps.isCancelled()) return attempt;
    if (mined.status === "confirmed") {
      const matched =
        mined.matched === null
          ? null
          : {
              takerRisk: mined.matched.takerRisk.toString(),
              makerRisk: mined.matched.makerRisk.toString(),
              oddsTick: mined.matched.oddsTick,
            };
      return save(
        update(
          attempt,
          { status: "confirmed", hash: mined.hash, blockNumber: mined.blockNumber, minedAt: mined.minedAt, matched },
          now(),
        ),
      );
    }
    if (mined.status === "failed") {
      return save(update(attempt, { status: "failed", hash: mined.hash, note: mined.lines.join(" ") }, now()));
    }
    return save(update(attempt, { status: "unknown", note: mined.lines.join(" ") }, now()));
  }

  if (attempt.status === "confirmed" || attempt.status === "unknown") {
    const read = deps.fills ?? getFills;
    const tries = deps.tries ?? 60;
    let looked = false;
    for (let round = 0; round < tries; round += 1) {
      if (deps.isCancelled()) return attempt;
      const fills = await read(attempt.quote, attempt.taker);
      if (fills !== null) {
        looked = true;
        const fill = fillOf(attempt, fills);
        if (fill !== null) return save(recorded(attempt, fill, now()));
      }
      if (round + 1 < tries) await sleep(deps.intervalMs ?? 3_000);
    }
    // A round of looking found no fill, so a transaction the wallet sent has had
    // that long to show in its count. Read once: a count that has moved keeps
    // the attempt open, and is not read again for it.
    if (attempt.status === "unknown" && attempt.nonce !== null && attempt.nonceCheck === null && looked && deps.provider !== null) {
      const count = await readCount(deps.provider, attempt.taker);
      if (count === null || deps.isCancelled()) return attempt;
      const nonceCheck = { ...count, at: now() };
      const moved = sentSinceHandoff({ ...attempt, nonceCheck });
      return save(update(attempt, moved ? { nonceCheck } : { nonceCheck, status: "unsent" }, now()));
    }
  }
  return attempt;
}

/** The wallet's transaction count: mined, and with pending ones. */
async function txCount(provider: ethers.providers.Web3Provider, address: string): Promise<TxCount> {
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(address, "latest"),
    provider.getTransactionCount(address, "pending"),
  ]);
  return { latest, pending };
}

/**
 * The count again, for telling whether an unknown take was sent, or null when
 * it cannot tell: it could not be read, the wallet is on another network, or
 * the address has code (a smart account, or an account delegated under
 * EIP-7702), which can act through another sender without moving its own count.
 */
async function readCount(provider: ethers.providers.Web3Provider, address: string): Promise<TxCount | null> {
  try {
    const chainId = Number.parseInt(String(await provider.send("eth_chainId", [])), 16);
    if (chainId !== POLYGON_CHAIN_ID) return null;
    if ((await provider.getCode(address)) !== "0x") return null;
    return await txCount(provider, address);
  } catch {
    return null;
  }
}

/** Ask the wallet to approve the PositionModule for `amount` of USDC. Resolves with the hash once sent. */
export async function sendApprove(args: {
  amount: bigint;
  taker: string;
  provider: ethers.providers.Web3Provider;
  signer: ethers.providers.JsonRpcSigner;
}): Promise<{ ok: true; hash: string; startBlock: number } | Refusal> {
  const taker = args.taker.toLowerCase();
  const request = { from: taker, to: USDC, data: encodeApprove(args.amount) };
  let gasLimit: ethers.BigNumber;
  let startBlock: number;
  try {
    const chainId = Number.parseInt(String(await args.provider.send("eth_chainId", [])), 16);
    if (chainId !== POLYGON_CHAIN_ID) {
      return { ok: false, lines: ["Your wallet is not on Polygon. Switch it to Polygon first.", NOTHING_SENT] };
    }
    gasLimit = (await args.provider.estimateGas(request)).mul(110).div(100);
    startBlock = await args.provider.getBlockNumber();
  } catch (err) {
    return { ok: false, lines: refusalFromError(err, "The approval could not be prepared") };
  }
  try {
    const hash = await args.signer.sendUncheckedTransaction({ ...request, gasLimit, chainId: POLYGON_CHAIN_ID });
    return { ok: true, hash: hash.toLowerCase(), startBlock };
  } catch (err) {
    if (isUserRejection(err)) return { ok: false, lines: ["You declined in your wallet.", NOTHING_SENT] };
    return { ok: false, lines: [`Your wallet reported an error (${shortReason(err)}).`] };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
