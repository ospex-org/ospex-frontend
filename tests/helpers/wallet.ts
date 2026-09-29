/**
 * A wallet for tests: an EIP-1193 `request` function answering the JSON-RPC
 * calls a take makes, under the real ethers 5 `Web3Provider`, so every call
 * goes through the same ethers code the page runs. And a stub for the API.
 */
import { ethers } from "ethers";
import { vi } from "vitest";
import { USDC } from "../../src/lib/take/constants";

export const TAKER = "0x00000000000000000000000000000000000c0ffe";
export const TX_HASH = `0x${"cd".repeat(32)}`;

export interface FakeWallet {
  provider: ethers.providers.Web3Provider;
  signer: ethers.providers.JsonRpcSigner;
  /** The transactions handed to `eth_sendTransaction`, in order. */
  sends: Array<Record<string, string>>;
}

export function fakeWallet(
  hooks: {
    /** Runs inside `eth_estimateGas`, before it answers. */
    onEstimateGas?: () => void;
    /** Answers `eth_sendTransaction`. Throw to be a wallet or node that failed to answer. */
    onSend?: (tx: Record<string, string>) => Promise<string> | string;
  } = {},
): FakeWallet {
  const sends: Array<Record<string, string>> = [];
  const plenty = ethers.utils.defaultAbiCoder.encode(["uint256"], ["1000000000000"]);
  const request = async ({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> => {
    switch (method) {
      case "eth_chainId":
        return "0x89";
      case "net_version":
        return "137";
      case "eth_accounts":
        return [TAKER];
      case "eth_blockNumber":
        return "0x5a3f1c0";
      case "eth_getBalance":
        return "0xde0b6b3a7640000";
      case "eth_call": {
        // USDC balances and allowances are plentiful; the take itself succeeds.
        const [tx] = params as [{ to: string }];
        return tx.to.toLowerCase() === USDC.toLowerCase() ? plenty : "0x";
      }
      case "eth_estimateGas":
        hooks.onEstimateGas?.();
        return "0x30d40";
      case "eth_sendTransaction": {
        const [tx] = params as [Record<string, string>];
        sends.push(tx);
        return hooks.onSend !== undefined ? await hooks.onSend(tx) : TX_HASH;
      }
      default:
        throw new Error(`the test wallet was not expecting ${method}`);
    }
  };
  const provider = new ethers.providers.Web3Provider({ request }, { chainId: 137, name: "Polygon" });
  provider.network.ensAddress = undefined;
  return { provider, signer: provider.getSigner(), sends };
}

/** Serve the quote, the contest and a list of fills in place of the API. */
export function stubApi(bodies: { quote: unknown; contest: unknown; fills?: () => unknown[] }): void {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/commitments/")) return json(bodies.quote);
    if (url.includes("/v1/contests/")) return json(bodies.contest);
    if (url.includes("/v1/fills?")) return json({ fills: bodies.fills?.() ?? [], nextCursor: null, hasMore: false });
    return new Response("not found", { status: 404 });
  });
}
