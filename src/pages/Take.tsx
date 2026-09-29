import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { useWeb3 } from "@/lib/wallet/web3Onboard";
import { getCommitment, getContest, getFills, type Fill } from "@/lib/take/api";
import {
  IN_FLIGHT,
  attemptStore,
  browserStorage,
  isResolved,
  openAttempt,
  type Attempt,
} from "@/lib/take/attempts";
import { readWallet, walletProblems, walletReads, type Problem } from "@/lib/take/checks";
import { POLYGONSCAN_TX_URL, POLYGON_CHAIN_ID } from "@/lib/take/constants";
import { hasInjectedWallet, metamaskDappLink } from "@/lib/take/deeplink";
import { formatOddsTick, formatUsdcExact, parseUsdc, takerOddsTick } from "@/lib/take/math";
import { assessTake, readContest, readQuote, type TakeView } from "@/lib/take/quote";
import { followAttempt, prepareAndSend, sendApprove, waitForMined } from "@/lib/take/send";
import { formatEasternMs, parseTimestampMs } from "@/lib/take/words";

type Load = { status: "loading" } | { status: "refused"; lines: string[] } | { status: "ready"; view: TakeView };

type Checks =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; problems: Problem[]; usdc: bigint; earlier: Fill[] }
  | { status: "error"; message: string };

/** Before the wallet is handed a take. From the handoff on, the attempt's record says where it stands. */
type Action = { status: "idle" } | { status: "checking" } | { status: "wallet" } | { status: "refused"; lines: string[] };

type Approval = { status: "idle" } | { status: "wallet" } | { status: "sent"; hash: string } | { status: "failed"; lines: string[] };

const HASH = /^0x[0-9a-fA-F]{64}$/;

const panel = "rounded-lg bg-secondary/30 p-4 text-sm space-y-1";
const primary = "bg-foreground text-background hover:bg-foreground/90";

function readLink(
  hash: string | undefined,
  risk: string | null,
): { ok: true; hash: string; risk: bigint } | { ok: false; lines: string[] } {
  if (hash === undefined || !HASH.test(hash)) {
    return { ok: false, lines: ["This is not a take link: it does not name a quote. Ask for the link again."] };
  }
  if (risk === null) {
    return { ok: false, lines: ["This take link does not say how much to risk. Ask for the link again."] };
  }
  const amount = parseUsdc(risk);
  if (!amount.ok) {
    return { ok: false, lines: [`This take link asks to risk "${risk}", which is not an amount of USDC this page can use.`] };
  }
  return { ok: true, hash: hash.toLowerCase(), risk: amount.baseUnits };
}

async function loadView(hash: string, risk: bigint): Promise<Load> {
  const quoteRead = await getCommitment(hash);
  if (!quoteRead.ok) {
    return {
      status: "refused",
      lines: [quoteRead.notFound ? "Ospex has no quote with this link's hash." : `The quote could not be read. ${quoteRead.message}`],
    };
  }
  const read = readQuote(quoteRead.body, hash);
  if (read.kind === "withdrawn") return { status: "refused", lines: ["The maker has withdrawn this quote."] };
  if (read.kind === "bad") return { status: "refused", lines: [read.reason] };
  const contestRead = await getContest(read.quote.commitment.contestId);
  if (!contestRead.ok) {
    return { status: "refused", lines: [`The game this quote is on could not be read. ${contestRead.message}`] };
  }
  const contest = readContest(contestRead.body);
  if (contest === null) return { status: "refused", lines: ["Ospex returned this quote's game in a form this page cannot read."] };
  const assessment = assessTake({ quote: read.quote, contest, requestedRisk: risk, nowMs: Date.now() });
  return assessment.ok ? { status: "ready", view: assessment.view } : { status: "refused", lines: assessment.lines };
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function when(timestamp: string): string {
  const ms = parseTimestampMs(timestamp);
  return (ms === null ? null : formatEasternMs(ms, true)) ?? timestamp;
}

function amounts(fill: { takerRisk: bigint | string; makerRisk: bigint | string; oddsTick: number }): string {
  return (
    `You risked ${formatUsdcExact(BigInt(fill.takerRisk))} USDC to win ${formatUsdcExact(BigInt(fill.makerRisk))} USDC ` +
    `at ${formatOddsTick(takerOddsTick(fill.oddsTick))}.`
  );
}

function Lines({ lines, className }: { lines: string[]; className?: string }) {
  return (
    <div className={className}>
      {lines.map((line, index) => (
        <p key={`${String(index)}:${line}`} className="leading-relaxed">
          {line}
        </p>
      ))}
    </div>
  );
}

function TxLink({ hash }: { hash: string }) {
  return (
    <a
      href={`${POLYGONSCAN_TX_URL}${hash}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs break-all underline underline-offset-2 hover:text-foreground"
    >
      {hash}
    </a>
  );
}

/**
 * Where a handed-off take stands, from its record. While its outcome is not
 * known, the page says so, looks for its fill, and offers no take.
 */
function AttemptPanel({ attempt, following, onCheckAgain }: { attempt: Attempt; following: boolean; onCheckAgain: () => void }) {
  const { status } = attempt;
  const open = status === "handoff" || status === "unknown";
  return (
    <section aria-label="your take" className={panel}>
      {open && <p className="font-medium leading-relaxed">{IN_FLIGHT}</p>}
      {attempt.hash !== null && (
        <p>
          Transaction: <TxLink hash={attempt.hash} />
        </p>
      )}
      {status === "sent" && <p className="text-muted-foreground">Sent. Waiting for Polygon to confirm it…</p>}
      {status === "confirmed" && (
        <>
          <p className="font-medium">Confirmed on Polygon.</p>
          {attempt.matched !== null && <p>{amounts(attempt.matched)}</p>}
          <p className="text-muted-foreground">
            {following
              ? `In block ${String(attempt.blockNumber)}. Waiting for Ospex to record the fill…`
              : "Ospex has not listed the fill yet. It usually takes about fifteen seconds."}
          </p>
        </>
      )}
      {status === "recorded" && attempt.fill !== null && (
        <>
          <p className="font-medium">Filled.</p>
          <p>{amounts(attempt.fill)}</p>
          <p className="text-muted-foreground">
            Ospex recorded the fill at {when(attempt.fill.filledAt)}. Ask the assistant that gave you this link whether it
            filled, and it will find it.
          </p>
        </>
      )}
      {status === "failed" && (
        <>
          {attempt.note !== null && <p>{attempt.note}</p>}
          <p className="text-muted-foreground">Reload this page to check the quote again.</p>
        </>
      )}
      {open && (
        <>
          {attempt.note !== null && <p className="text-muted-foreground">{attempt.note}</p>}
          <p className="text-muted-foreground">
            {following
              ? "Looking for this bet among Ospex's fills from your wallet on this quote…"
              : "Ospex lists no fill from your wallet on this quote since then."}
          </p>
        </>
      )}
      {(open || status === "confirmed") && !following && (
        <button
          type="button"
          onClick={onCheckAgain}
          className="block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Check again
        </button>
      )}
      {open && (
        <div className="pt-2">
          <Button className={primary} disabled>
            Take this bet
          </Button>
        </div>
      )}
    </section>
  );
}

export default function Take() {
  const { commitmentHash } = useParams();
  const [searchParams] = useSearchParams();
  const link = readLink(commitmentHash, searchParams.get("risk"));
  const linkHash = link.ok ? link.hash : null;
  const linkRisk = link.ok ? link.risk : null;

  const { isConnected, address, provider, signer, connectWallet, walletChainId, switchToPolygon } = useWeb3();

  const store = useMemo(() => attemptStore(browserStorage()), []);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [checks, setChecks] = useState<Checks>({ status: "idle" });
  const [action, setAction] = useState<Action>({ status: "idle" });
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [following, setFollowing] = useState(false);
  const [followRound, setFollowRound] = useState(0);
  const [approval, setApproval] = useState<Approval>({ status: "idle" });
  const [checkRound, setCheckRound] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (linkHash === null || linkRisk === null) return;
    let current = true;
    setLoad({ status: "loading" });
    void loadView(linkHash, linkRisk).then((next) => {
      if (current) setLoad(next);
    });
    return () => {
      current = false;
    };
  }, [linkHash, linkRisk]);

  const view = load.status === "ready" ? load.view : null;
  const onPolygon = walletChainId === POLYGON_CHAIN_ID;

  // The wallet checks, through the wallet, whenever the quote, the account or
  // the network changes, and again when asked.
  useEffect(() => {
    if (view === null || address === null || provider === null || !onPolygon) {
      setChecks({ status: "idle" });
      return;
    }
    let current = true;
    setChecks({ status: "checking" });
    const maker = view.quote.commitment.maker;
    void (async () => {
      try {
        const [state, earlier] = await Promise.all([
          readWallet(walletReads(provider), address, maker),
          getFills(view.quote.hash, address),
        ]);
        const problems = walletProblems(state, {
          takerRisk: view.plan.takerRisk,
          fillMakerRisk: view.plan.fillMakerRisk,
          maker,
        });
        if (current) setChecks({ status: "done", problems, usdc: state.usdc, earlier: earlier ?? [] });
      } catch {
        if (current) {
          setChecks({ status: "error", message: "Your wallet could not be read just now. Check it is unlocked, then check again." });
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [view, address, provider, onPolygon, checkRound]);

  const recheck = useCallback(() => setCheckRound((round) => round + 1), []);

  // An unresolved attempt on this quote from this wallet, found in the
  // browser's record, from before a reload or from another tab.
  useEffect(() => {
    setAttempt(linkHash !== null && address !== null ? openAttempt(store, linkHash, address) : null);
  }, [store, linkHash, address]);

  // Follow an unresolved attempt one step at a time. A step that changes the
  // attempt saves it, and the new record runs the next step.
  useEffect(() => {
    if (attempt === null || isResolved(attempt)) return;
    if (attempt.status === "sent" && provider === null) return;
    let current = true;
    setFollowing(true);
    void followAttempt(attempt, { store, provider, isCancelled: () => !current }).then((next) => {
      if (!current) return;
      setFollowing(false);
      if (next !== attempt) setAttempt(next);
    });
    return () => {
      current = false;
    };
  }, [attempt, provider, store, followRound]);

  const followAgain = useCallback(() => setFollowRound((round) => round + 1), []);

  const confirm = useCallback(async () => {
    if (view === null || linkRisk === null || address === null || provider === null || signer === null) return;
    setAction({ status: "checking" });
    const result = await prepareAndSend({
      shown: view,
      requestedRisk: linkRisk,
      taker: address,
      provider,
      signer,
      attempts: store,
      onWallet: () => {
        if (alive.current) setAction({ status: "wallet" });
      },
    });
    if (!alive.current) return;
    if (result.kind === "refused") {
      if (result.view !== undefined) setLoad({ status: "ready", view: result.view });
      setAction({ status: "refused", lines: result.lines });
      // The refusal may be an attempt already open in another tab: show it.
      setAttempt(openAttempt(store, view.quote.hash, address));
      return;
    }
    setAction({ status: "idle" });
    setAttempt(result.attempt);
  }, [view, linkRisk, address, provider, signer, store]);

  const approve = useCallback(async () => {
    if (view === null || address === null || provider === null || signer === null) return;
    setApproval({ status: "wallet" });
    const sent = await sendApprove({ amount: view.plan.takerRisk, taker: address, provider, signer });
    if (!alive.current) return;
    if (!sent.ok) {
      setApproval({ status: "failed", lines: sent.lines });
      return;
    }
    setApproval({ status: "sent", hash: sent.hash });
    const mined = await waitForMined({ provider, hash: sent.hash, startBlock: sent.startBlock, commitmentHash: null });
    if (!alive.current) return;
    if (mined.status !== "confirmed") {
      setApproval({ status: "failed", lines: mined.lines });
      return;
    }
    setApproval({ status: "idle" });
    recheck();
  }, [view, address, provider, signer, recheck]);

  const busy = action.status === "checking" || action.status === "wallet";
  const approving = approval.status === "wallet" || approval.status === "sent";
  const ready = view !== null && checks.status === "done" && checks.problems.length === 0 && !busy && !approving;
  const needsApproval = checks.status === "done" && checks.problems.some((problem) => problem.code === "allowance_short");

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <AppHeader />
      <div className="max-w-2xl mx-auto mt-8 space-y-6">
        <div>
          <h2 className="text-2xl font-bold mb-1">take a quote</h2>
          <p className="text-sm text-muted-foreground">Nothing is placed until you confirm in your wallet.</p>
        </div>

        {!link.ok && <Lines lines={link.lines} className={panel} />}
        {link.ok && load.status === "loading" && <p className="text-sm text-muted-foreground">Reading the quote…</p>}
        {link.ok && load.status === "refused" && <Lines lines={load.lines} className={panel} />}

        {view !== null && (
          <section aria-label="preview" className={panel}>
            <Lines lines={view.preview} className="space-y-1" />
          </section>
        )}

        {attempt !== null && <AttemptPanel attempt={attempt} following={following} onCheckAgain={followAgain} />}

        {view !== null && (
          <>
            {attempt === null && (
              <section aria-label="wallet" className="space-y-3 text-sm">
                {!isConnected &&
                  (hasInjectedWallet() ? (
                    <div className="space-y-2">
                      <p className="text-muted-foreground">Connect your wallet to check it can take this bet.</p>
                      <Button className={primary} onClick={() => void connectWallet()}>
                        Connect wallet
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-muted-foreground">
                        There is no wallet in this browser. On a phone, open this page in the MetaMask app:
                      </p>
                      <Button asChild className={primary}>
                        <a href={metamaskDappLink(window.location)}>Open in MetaMask</a>
                      </Button>
                    </div>
                  ))}

                {isConnected && !onPolygon && (
                  <div className="space-y-2">
                    <p>
                      Your wallet is on another network
                      {walletChainId === null ? "" : ` (chain ${String(walletChainId)})`}. This bet is on Polygon.
                    </p>
                    <Button variant="secondary" onClick={() => void switchToPolygon()}>
                      Switch to Polygon
                    </Button>
                  </div>
                )}

                {isConnected && onPolygon && address !== null && (
                  <p className="text-muted-foreground">
                    Wallet {short(address)} on Polygon
                    {checks.status === "done" ? `, holding ${formatUsdcExact(checks.usdc)} USDC.` : "."}
                  </p>
                )}
                {isConnected && onPolygon && provider === null && (
                  <p className="text-muted-foreground">Waiting for your wallet…</p>
                )}

                {checks.status === "checking" && <p className="text-muted-foreground">Checking your wallet…</p>}
                {checks.status === "error" && <p>{checks.message}</p>}
                {checks.status === "done" && checks.problems.length > 0 && (
                  <Lines lines={checks.problems.map((problem) => problem.text)} className="space-y-1" />
                )}
                {checks.status === "done" && checks.earlier.length > 0 && (
                  <p>
                    This wallet has already taken this quote:{" "}
                    {checks.earlier.map((fill) => `${formatUsdcExact(fill.takerRisk)} USDC on ${when(fill.filledAt)}`).join("; ")}.
                    Taking it again places another bet.
                  </p>
                )}

                {needsApproval && (
                  <div className="space-y-2">
                    <Button variant="secondary" disabled={approving} onClick={() => void approve()}>
                      Approve {formatUsdcExact(view.plan.takerRisk)} USDC
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Lets the Ospex PositionModule move this bet's USDC from your wallet, and no more.
                    </p>
                    {approval.status === "wallet" && <p className="text-muted-foreground">Confirm the approval in your wallet…</p>}
                    {approval.status === "sent" && (
                      <p className="text-muted-foreground">
                        Approval sent: <TxLink hash={approval.hash} />. Waiting for Polygon…
                      </p>
                    )}
                    {approval.status === "failed" && <Lines lines={approval.lines} className="space-y-1" />}
                  </div>
                )}

                {isConnected && onPolygon && (checks.status === "done" || checks.status === "error") && (
                  <button
                    type="button"
                    onClick={recheck}
                    className="block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  >
                    Check again
                  </button>
                )}

                {isConnected && (
                  <div className="pt-2">
                    <Button className={primary} disabled={!ready} onClick={() => void confirm()}>
                      {action.status === "wallet" ? "Confirm in your wallet…" : action.status === "checking" ? "Checking…" : "Take this bet"}
                    </Button>
                  </div>
                )}
                {action.status === "refused" && <Lines lines={action.lines} className="space-y-1" />}
              </section>
            )}

            <section aria-label="details" className="text-xs text-muted-foreground space-y-1 break-all">
              <p>Quote {view.quote.hash}</p>
              <p>
                Contest {view.quote.commitment.contestId} · maker {view.quote.commitment.maker}
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
