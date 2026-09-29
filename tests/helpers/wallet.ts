/**
 * A wallet for tests: an EIP-1193 `request` function answering the JSON-RPC
 * calls a take makes, under the real ethers 5 `Web3Provider`, so every call
 * goes through the same ethers code the page runs. It can also mine what it
 * sends, into a block at a given time. And a stub for the API.
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

export interface Mining {
  blockNumber: number;
  timestampMs: number;
  status: 0 | 1;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

const BASE_BLOCK = 0x5a3f1c0;
const hex = (value: number) => `0x${value.toString(16)}`;
const blockHash = (n: number) => ethers.utils.hexZeroPad(hex(n), 32);

export function fakeWallet(
  hooks: {
    /** Runs inside `eth_estimateGas`, before it answers. */
    onEstimateGas?: () => void;
    /** Answers `eth_sendTransaction`. Throw to be a wallet or node that failed to answer. */
    onSend?: (tx: Record<string, string>) => Promise<string> | string;
    /** Mines a sent transaction at once, into this block. */
    mine?: (tx: Record<string, string>) => Mining;
  } = {},
): FakeWallet {
  const sends: Array<Record<string, string>> = [];
  const chain = new Map<string, { tx: Record<string, string>; mined: Mining | null }>();
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
        return hex(BASE_BLOCK);
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
        const hash = hooks.onSend !== undefined ? await hooks.onSend(tx) : TX_HASH;
        chain.set(hash, { tx, mined: hooks.mine?.(tx) ?? null });
        return hash;
      }
      case "eth_getTransactionByHash": {
        const entry = chain.get(String(params[0]));
        if (entry === undefined) return null;
        const n = entry.mined?.blockNumber ?? null;
        return {
          hash: params[0],
          type: "0x2",
          blockHash: n === null ? null : blockHash(n),
          blockNumber: n === null ? null : hex(n),
          transactionIndex: n === null ? null : "0x0",
          from: entry.tx.from,
          to: entry.tx.to,
          gas: entry.tx.gas,
          maxFeePerGas: "0x1",
          maxPriorityFeePerGas: "0x1",
          value: "0x0",
          nonce: "0x7",
          input: entry.tx.data,
          chainId: "0x89",
          accessList: [],
          v: "0x1",
          r: `0x${"11".repeat(32)}`,
          s: `0x${"22".repeat(32)}`,
        };
      }
      case "eth_getTransactionReceipt": {
        const entry = chain.get(String(params[0]));
        if (entry === undefined || entry.mined === null) return null;
        const { blockNumber, status, logs } = entry.mined;
        return {
          transactionHash: params[0],
          transactionIndex: "0x0",
          blockHash: blockHash(blockNumber),
          blockNumber: hex(blockNumber),
          from: entry.tx.from,
          to: entry.tx.to,
          cumulativeGasUsed: "0x30d40",
          gasUsed: "0x30d40",
          effectiveGasPrice: "0x1",
          contractAddress: null,
          logsBloom: `0x${"00".repeat(256)}`,
          status: hex(status),
          type: "0x2",
          logs: logs.map((log, index) => ({
            ...log,
            blockNumber: hex(blockNumber),
            blockHash: blockHash(blockNumber),
            transactionHash: params[0],
            transactionIndex: "0x0",
            logIndex: hex(index),
          })),
        };
      }
      case "eth_getBlockByNumber": {
        const n = Number.parseInt(String(params[0]), 16);
        const mined = [...chain.values()].find((entry) => entry.mined?.blockNumber === n)?.mined;
        return {
          hash: blockHash(n),
          parentHash: blockHash(n - 1),
          number: hex(n),
          timestamp: hex(Math.floor((mined?.timestampMs ?? 0) / 1000)),
          nonce: "0x0000000000000000",
          difficulty: "0x0",
          gasLimit: "0x1c9c380",
          gasUsed: "0x0",
          miner: `0x${"00".repeat(20)}`,
          extraData: "0x",
          transactions: [],
          baseFeePerGas: "0x1",
        };
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
