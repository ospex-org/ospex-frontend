/**
 * Sending a take, and following it until Ospex has recorded the fill.
 *
 * `prepareAndSend` follows `@ospex/sdk`'s `matchFromPreview`, which re-reads
 * everything before it sends, however recent the preview: the quote and the
 * game are fetched again and put through the same checks as the preview, the
 * amounts must be the ones the person was shown, and the wallet's chain,
 * address, USDC and approval are read again. Then the transaction is run as a
 * call, so a take the chain would refuse at that moment is refused here in
 * words instead of costing gas, and its gas is estimated with the SDK's 10%
 * cushion.
 *
 * Only then does the wallet see it. `from` is set, so ethers will not send it
 * from any other account, and `chainId` is set for the wallet to check against
 * the network it is on.
 */

import { ethers } from "ethers";
import { getCommitment, getContest, getFills, type Fill } from "./api";
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

/** Fetch the quote and its game again, and assess them as the preview did. */
export async function reassess(
  hash: string,
  contestId: string,
  requestedRisk: bigint,
): Promise<{ ok: true; view: TakeView } | Refusal> {
  const [quoteRead, contestRead] = await Promise.all([getCommitment(hash), getContest(contestId)]);
  if (!quoteRead.ok) return { ok: false, lines: [`The quote could not be read again. ${quoteRead.message}`, NOTHING_SENT] };
  if (!contestRead.ok) return { ok: false, lines: [`The game could not be read again. ${contestRead.message}`, NOTHING_SENT] };
  const read = readQuote(quoteRead.body, hash);
  if (read.kind === "withdrawn") return { ok: false, lines: ["The maker has withdrawn this quote.", NOTHING_SENT] };
  if (read.kind === "bad") return { ok: false, lines: [read.reason] };
  const contest = readContest(contestRead.body);
  if (contest === null) return { ok: false, lines: ["Ospex returned this game in a form this page cannot read.", NOTHING_SENT] };
  const assessment = assessTake({ quote: read.quote, contest, requestedRisk, nowMs: Date.now() });
  if (!assessment.ok) return { ok: false, lines: [...assessment.lines, NOTHING_SENT] };
  return { ok: true, view: assessment.view };
}

function refusalFromError(err: unknown, lead: string): string[] {
  const data = findRevertData(err);
  const described = data === null ? null : describeRevert(data);
  if (described !== null) return [described, NOTHING_SENT];
  return [`${lead} (${shortReason(err)}).`, NOTHING_SENT];
}

/**
 * Check the quote, the game and the wallet again, run the take as a call, and
 * hand it to the wallet. Resolves once the wallet has sent it, with its hash,
 * or with the reason it was not sent. A refusal carrying a `view` means the
 * quote changed: that view is the new preview, to be confirmed again.
 */
export async function prepareAndSend(args: {
  shown: TakeView;
  requestedRisk: bigint;
  taker: string;
  provider: ethers.providers.Web3Provider;
  signer: ethers.providers.JsonRpcSigner;
  /** Called just before the wallet is asked to confirm. */
  onWallet: () => void;
}): Promise<{ ok: true; hash: string; startBlock: number } | Refusal> {
  const { shown, requestedRisk, provider, signer, onWallet } = args;
  const taker = args.taker.toLowerCase();

  const fresh = await reassess(shown.quote.hash, shown.quote.commitment.contestId, requestedRisk);
  if (!fresh.ok) return fresh;
  if (!sameTake(shown, fresh.view)) {
    return {
      ok: false,
      lines: ["The quote changed since this page showed it. Check the amounts again, then confirm.", NOTHING_SENT],
      view: fresh.view,
    };
  }
  const view = fresh.view;

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

  onWallet();
  try {
    const hash = await signer.sendUncheckedTransaction({ ...request, gasLimit, chainId: POLYGON_CHAIN_ID });
    return { ok: true, hash: hash.toLowerCase(), startBlock };
  } catch (err) {
    if (isUserRejection(err)) return { ok: false, lines: ["You declined in your wallet.", NOTHING_SENT] };
    return {
      ok: false,
      lines: [
        `Your wallet reported an error (${shortReason(err)}).`,
        "If your wallet shows a pending transaction, wait for it before trying again.",
      ],
    };
  }
}

export type Mined =
  | { status: "confirmed"; hash: string; blockNumber: number; matched: MatchedEvent | null }
  | { status: "failed"; hash: string; lines: string[] };

/**
 * Wait for a sent transaction to be mined. A transaction the wallet sped up
 * (same call, higher fee) is followed to its replacement; one it cancelled or
 * replaced with something else is reported as not placed.
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
      status: "failed",
      hash,
      lines: ["Your wallet sent the transaction, but Polygon has not shown it for two minutes. Check it on Polygonscan."],
    };
  }
  const response = provider._wrapTransaction(tx, hash, startBlock);
  try {
    const receipt = await response.wait(1);
    return confirmed(receipt, commitmentHash);
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
        if (e.receipt.status === 1) return confirmed(e.receipt, commitmentHash);
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
    return { status: "failed", hash, lines: [`Waiting for the transaction failed (${shortReason(err)}). Check it on Polygonscan.`] };
  }
}

function confirmed(receipt: ethers.providers.TransactionReceipt, commitmentHash: string | null): Mined {
  return {
    status: "confirmed",
    hash: receipt.transactionHash.toLowerCase(),
    blockNumber: receipt.blockNumber,
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
 * Ask the API for the fill this transaction made, every three seconds for up
 * to three minutes. It appears once its block is final, usually within about
 * fifteen seconds of confirming.
 */
export async function waitForFill(args: {
  commitmentHash: string;
  taker: string;
  txHash: string;
  isCancelled: () => boolean;
}): Promise<Fill | null> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (args.isCancelled()) return null;
    const fills = await getFills(args.commitmentHash, args.taker.toLowerCase());
    const fill = fills?.find((candidate) => candidate.txHash === args.txHash.toLowerCase());
    if (fill !== undefined) return fill;
    await sleep(3_000);
  }
  return null;
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
