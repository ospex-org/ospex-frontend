/**
 * The three reads the take page makes from the Ospex API, each bounded by a
 * timeout: a request that never answers is abandoned, and its socket closed,
 * rather than left to hold the page.
 */

import { OSPEX_API_URL } from "./constants";

const TIMEOUT_MS = 12_000;

export type ApiRead = { ok: true; body: unknown } | { ok: false; notFound: boolean; message: string };

async function getJson(path: string): Promise<ApiRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${OSPEX_API_URL}${path}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 404) return { ok: false, notFound: true, message: "Ospex has no record of it." };
    if (!response.ok) {
      return { ok: false, notFound: false, message: `Ospex answered with an error (${String(response.status)}). Try again in a moment.` };
    }
    return { ok: true, body: (await response.json()) as unknown };
  } catch {
    return { ok: false, notFound: false, message: "Ospex could not be reached. Check your connection and try again." };
  } finally {
    clearTimeout(timer);
  }
}

export function getCommitment(hash: string): Promise<ApiRead> {
  return getJson(`/v1/commitments/${encodeURIComponent(hash)}`);
}

export function getContest(contestId: string): Promise<ApiRead> {
  return getJson(`/v1/contests/${encodeURIComponent(contestId)}`);
}

export interface Fill {
  taker: string;
  txHash: string;
  makerRisk: bigint;
  takerRisk: bigint;
  oddsTick: number;
  filledAt: string;
}

/** Fills on one quote by one wallet, oldest first, or `null` when they could not be read. */
export async function getFills(commitmentHash: string, taker: string): Promise<Fill[] | null> {
  const query = new URLSearchParams({ commitmentHash, taker });
  const read = await getJson(`/v1/fills?${query.toString()}`);
  if (!read.ok) return null;
  const body = read.body as { fills?: unknown };
  if (!Array.isArray(body.fills)) return null;
  const fills: Fill[] = [];
  for (const row of body.fills as unknown[]) {
    const r = row as Record<string, unknown>;
    if (
      typeof r.taker !== "string" ||
      typeof r.txHash !== "string" ||
      typeof r.makerRiskAmount !== "string" ||
      typeof r.takerRiskAmount !== "string" ||
      typeof r.oddsTick !== "number" ||
      typeof r.filledAt !== "string" ||
      !/^\d+$/.test(r.makerRiskAmount) ||
      !/^\d+$/.test(r.takerRiskAmount)
    ) {
      continue;
    }
    fills.push({
      taker: r.taker.toLowerCase(),
      txHash: r.txHash.toLowerCase(),
      makerRisk: BigInt(r.makerRiskAmount),
      takerRisk: BigInt(r.takerRiskAmount),
      oddsTick: r.oddsTick,
      filledAt: r.filledAt,
    });
  }
  return fills;
}
