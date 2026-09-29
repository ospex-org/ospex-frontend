/**
 * Everything the take page does with ethers that is not a network call:
 * the EIP-712 hash of a quote, the signer it recovers to, the calldata of a
 * take and of an approval, reading a take back out of its receipt, and saying
 * in plain words why a transaction would fail.
 *
 * The calldata is `MatchingModule.matchCommitment(commitment, signature,
 * takerDesiredRisk)` built from the same arguments `@ospex/sdk`'s
 * `matchFromPreview` passes: the nine signed fields exactly as signed (the
 * full `riskAmount`, not what is left of it; the expiry in unix seconds), the
 * signature, and the amount to risk in USDC base units.
 */

import { ethers } from "ethers";
import {
  COMMITMENT_TYPES,
  EIP712_DOMAIN,
  ERC20_ABI,
  MATCHING_MODULE,
  MATCHING_MODULE_ABI,
  POSITION_MODULE,
} from "./constants";

/** A quote's nine signed fields, in the form ethers encodes. */
export interface SignedCommitment {
  /** Lowercase. */
  maker: string;
  /** Decimal digits. */
  contestId: string;
  /** Lowercase. */
  scorer: string;
  lineTicks: number;
  positionType: 0 | 1;
  oddsTick: number;
  /** Decimal digits: the whole amount signed for. */
  riskAmount: string;
  /** Decimal digits. */
  nonce: string;
  /** Unix seconds, decimal digits. */
  expiry: string;
}

const matching = new ethers.utils.Interface(MATCHING_MODULE_ABI);
const erc20 = new ethers.utils.Interface(ERC20_ABI);

function asMessage(c: SignedCommitment): Record<string, string | number> {
  return {
    maker: c.maker,
    contestId: c.contestId,
    scorer: c.scorer,
    lineTicks: c.lineTicks,
    positionType: c.positionType,
    oddsTick: c.oddsTick,
    riskAmount: c.riskAmount,
    nonce: c.nonce,
    expiry: c.expiry,
  };
}

/** The quote's EIP-712 hash, lowercase: what `MatchingModule.getCommitmentHash` returns. */
export function hashCommitment(c: SignedCommitment): string {
  return ethers.utils._TypedDataEncoder.hash(EIP712_DOMAIN, COMMITMENT_TYPES, asMessage(c)).toLowerCase();
}

/** The address that signed these fields, lowercase, or `null` when the signature cannot be read. */
export function recoverSigner(c: SignedCommitment, signature: string): string | null {
  try {
    return ethers.utils.verifyTypedData(EIP712_DOMAIN, COMMITMENT_TYPES, asMessage(c), signature).toLowerCase();
  } catch {
    return null;
  }
}

/** Calldata for `matchCommitment`. `takerDesiredRisk` is the amount the preview was worked out from. */
export function encodeMatchCommitment(c: SignedCommitment, signature: string, takerDesiredRisk: bigint): string {
  return matching.encodeFunctionData("matchCommitment", [
    [c.maker, c.contestId, c.scorer, c.lineTicks, c.positionType, c.oddsTick, c.riskAmount, c.nonce, c.expiry],
    signature,
    takerDesiredRisk.toString(),
  ]);
}

/** Calldata for USDC `approve(PositionModule, amount)`. */
export function encodeApprove(amount: bigint): string {
  return erc20.encodeFunctionData("approve", [POSITION_MODULE, amount.toString()]);
}

export function encodeBalanceOf(owner: string): string {
  return erc20.encodeFunctionData("balanceOf", [owner]);
}

export function encodeAllowance(owner: string, spender: string): string {
  return erc20.encodeFunctionData("allowance", [owner, spender]);
}

/** A `uint256` return value as a bigint. */
export function decodeUint(data: string): bigint {
  return BigInt(ethers.BigNumber.from(ethers.utils.defaultAbiCoder.decode(["uint256"], data)[0]).toString());
}

export interface MatchedEvent {
  taker: string;
  makerRisk: bigint;
  takerRisk: bigint;
  oddsTick: number;
}

/** The `CommitmentMatched` this quote emitted in a receipt, or `null` when there is none. */
export function matchedEvent(
  logs: ReadonlyArray<{ address: string; topics: string[]; data: string }>,
  commitmentHash: string,
): MatchedEvent | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== MATCHING_MODULE.toLowerCase()) continue;
    let parsed: ethers.utils.LogDescription;
    try {
      parsed = matching.parseLog(log);
    } catch {
      continue;
    }
    if (parsed.name !== "CommitmentMatched") continue;
    if (String(parsed.args.commitmentHash).toLowerCase() !== commitmentHash.toLowerCase()) continue;
    return {
      taker: String(parsed.args.taker).toLowerCase(),
      makerRisk: BigInt(parsed.args.makerRisk.toString()),
      takerRisk: BigInt(parsed.args.takerRisk.toString()),
      oddsTick: Number(parsed.args.oddsTick),
    };
  }
  return null;
}

// ── why a transaction would fail ───────────────────────────────────────

const REFUSALS: Record<string, string> = {
  MatchingModule__CommitmentCancelled: "The maker has cancelled this quote on-chain.",
  MatchingModule__NonceTooLow: "The maker has cancelled this quote on-chain.",
  MatchingModule__CommitmentExpired: "This quote has expired.",
  MatchingModule__CommitmentFullyFilled: "This quote has been taken in full.",
  MatchingModule__InvalidFillMakerRisk:
    "This quote no longer has enough left for this amount. Someone may have taken part of it.",
  MatchingModule__ContestAlreadyScored: "This game has been scored or voided, so it takes no more bets.",
  PositionModule__ContestAlreadyScored: "This game has been scored or voided, so it takes no more bets.",
  MatchingModule__ContestPastCooldown: "This game is past the time the contract takes bets on it.",
  PositionModule__SpeculationNotOpen: "This market is closed to new bets.",
  MatchingModule__InvalidSignature: "This quote's signature does not match its maker.",
  ECDSAInvalidSignature: "This quote's signature cannot be read.",
  ECDSAInvalidSignatureLength: "This quote's signature cannot be read.",
  ECDSAInvalidSignatureS: "This quote's signature cannot be read.",
  SafeERC20FailedOperation:
    "A USDC transfer would fail. Your wallet or the quote's maker may be short of USDC or of the approval.",
};

const ERROR_STRING = "0x08c379a0";
const PANIC = "0x4e487b71";

/**
 * Plain words for a revert's data, or `null` when the data is not a revert
 * this page knows. A USDC transfer that fails reverts with a string, which is
 * quoted.
 */
export function describeRevert(data: string): string | null {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) return null;
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === ERROR_STRING) {
    try {
      const [reason] = ethers.utils.defaultAbiCoder.decode(["string"], `0x${data.slice(10)}`);
      return `A transfer would fail: "${String(reason)}". Your wallet or the quote's maker may be short of USDC or of the approval.`;
    } catch {
      return null;
    }
  }
  if (selector === PANIC) return "The contract stopped on an internal check.";
  let name: string;
  try {
    name = matching.getError(selector).name;
  } catch {
    return null;
  }
  return REFUSALS[name] ?? `The contract refused this take (${name}).`;
}

/** The first revert data anywhere inside a thrown error, as ethers and wallets nest it. */
export function findRevertData(err: unknown): string | null {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): string | null => {
    if (depth > 8 || value === null || value === undefined || seen.has(value)) return null;
    if (typeof value === "string") {
      if (/^0x[0-9a-fA-F]{8,}$/.test(value) && describeRevert(value) !== null) return value;
      if (value.startsWith("{")) {
        try {
          return visit(JSON.parse(value), depth + 1);
        } catch {
          return null;
        }
      }
      return null;
    }
    if (typeof value !== "object") return null;
    seen.add(value);
    for (const key of Object.keys(value)) {
      const found = visit((value as Record<string, unknown>)[key], depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(err, 0);
}

/** True when a wallet reports that its user said no. */
export function isUserRejection(err: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 6 || value === null || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const o = value as Record<string, unknown>;
    if (o.code === 4001 || o.code === "ACTION_REJECTED") return true;
    if (typeof o.message === "string" && /user (rejected|denied)/i.test(o.message)) return true;
    return visit(o.error, depth + 1) || visit(o.cause, depth + 1) || visit(o.data, depth + 1);
  };
  return visit(err, 0);
}

/** A short, readable reason from a thrown error, for when nothing better is known. */
export function shortReason(err: unknown): string {
  const o = err as { reason?: unknown; shortMessage?: unknown; message?: unknown } | null;
  const text = [o?.reason, o?.shortMessage, o?.message].find((v): v is string => typeof v === "string" && v !== "");
  if (text === undefined) return "no reason given";
  const firstLine = text.split("\n")[0] ?? text;
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}
