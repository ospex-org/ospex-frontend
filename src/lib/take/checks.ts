/**
 * The wallet checks before a take, read through the wallet itself. The API
 * that accepted the quote checks none of these. A take sent without enough
 * USDC or approval on either side reverts, and costs gas for nothing.
 *
 * `PositionModule.recordFill` pulls USDC from BOTH sides: the taker's risk
 * from the taker and the maker's risk from the maker, each through its owner's
 * approval of the PositionModule. So the maker's funding is checked too, as
 * `@ospex/sdk`'s `checkCommitmentFillability` does.
 */

import { ethers } from "ethers";
import { POLYGON_CHAIN_ID, POSITION_MODULE, USDC } from "./constants";
import { formatUsdcExact } from "./math";
import { decodeUint, encodeAllowance, encodeBalanceOf } from "./tx";

export interface WalletState {
  chainId: number;
  /** Lowercase. */
  taker: string;
  polWei: bigint;
  usdc: bigint;
  allowance: bigint;
  makerUsdc: bigint;
  makerAllowance: bigint;
}

export type ProblemCode = "wrong_chain" | "self_match" | "no_pol" | "usdc_short" | "allowance_short" | "maker_short";

export interface Problem {
  code: ProblemCode;
  text: string;
}

/**
 * What stands between this wallet and the take, in plain words. Empty when
 * nothing does. `takerRisk` is what the take pulls from the taker and
 * `fillMakerRisk` what it pulls from the maker.
 */
export function walletProblems(
  state: WalletState,
  need: { takerRisk: bigint; fillMakerRisk: bigint; maker: string },
): Problem[] {
  if (state.chainId !== POLYGON_CHAIN_ID) {
    return [
      {
        code: "wrong_chain",
        text: `Your wallet is on another network (chain ${String(state.chainId)}). This bet is on Polygon: switch your wallet to Polygon.`,
      },
    ];
  }
  if (state.taker === need.maker.toLowerCase()) {
    return [
      {
        code: "self_match",
        text: "This quote was posted from the wallet you are connected with. Taking it would bet against yourself.",
      },
    ];
  }
  const problems: Problem[] = [];
  if (state.polWei === 0n) {
    problems.push({ code: "no_pol", text: "Your wallet has no POL. Polygon needs a little POL to pay the network fee." });
  }
  if (state.usdc < need.takerRisk) {
    problems.push({
      code: "usdc_short",
      text:
        `Your wallet has ${formatUsdcExact(state.usdc)} USDC on Polygon, and this bet needs ${formatUsdcExact(need.takerRisk)}. ` +
        "Only native USDC counts (the token at 0x3c49…3359), not bridged USDC.e.",
    });
  }
  if (state.allowance < need.takerRisk) {
    problems.push({
      code: "allowance_short",
      text:
        `Ospex is approved to move ${formatUsdcExact(state.allowance)} of your USDC, and this bet needs ${formatUsdcExact(need.takerRisk)}. ` +
        "Approve it, then take the bet.",
    });
  }
  if (state.makerUsdc < need.fillMakerRisk || state.makerAllowance < need.fillMakerRisk) {
    problems.push({
      code: "maker_short",
      text:
        "The quote's maker does not have the USDC behind it right now, so the take would fail and only cost gas. " +
        "Try again later, or ask for another quote.",
    });
  }
  return problems;
}

/** The reads `walletProblems` needs, so a test can answer them. */
export interface ChainReads {
  chainId(): Promise<number>;
  polBalance(address: string): Promise<bigint>;
  usdcBalance(address: string): Promise<bigint>;
  usdcAllowance(owner: string, spender: string): Promise<bigint>;
}

/** The reads, through the connected wallet's own provider. */
export function walletReads(provider: ethers.providers.Web3Provider): ChainReads {
  const call = async (data: string): Promise<bigint> => decodeUint(await provider.call({ to: USDC, data }));
  return {
    chainId: async () => Number.parseInt(String(await provider.send("eth_chainId", [])), 16),
    polBalance: async (address) => BigInt((await provider.getBalance(address)).toString()),
    usdcBalance: (address) => call(encodeBalanceOf(address)),
    usdcAllowance: (owner, spender) => call(encodeAllowance(owner, spender)),
  };
}

/** Read everything `walletProblems` looks at. On the wrong chain, nothing else is read. */
export async function readWallet(reads: ChainReads, taker: string, maker: string): Promise<WalletState> {
  const chainId = await reads.chainId();
  const state: WalletState = {
    chainId,
    taker: taker.toLowerCase(),
    polWei: 0n,
    usdc: 0n,
    allowance: 0n,
    makerUsdc: 0n,
    makerAllowance: 0n,
  };
  if (chainId !== POLYGON_CHAIN_ID) return state;
  const [polWei, usdc, allowance, makerUsdc, makerAllowance] = await Promise.all([
    reads.polBalance(taker),
    reads.usdcBalance(taker),
    reads.usdcAllowance(taker, POSITION_MODULE),
    reads.usdcBalance(maker),
    reads.usdcAllowance(maker, POSITION_MODULE),
  ]);
  return { ...state, polWei, usdc, allowance, makerUsdc, makerAllowance };
}
