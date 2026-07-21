import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { cn } from "@/lib/utils";

const VERSION = "0.10.1";
const RELEASE_BASE = `https://github.com/ospex-org/ospex-sdk/releases/download/v${VERSION}`;

type Tarball = {
  title: string;
  description: string;
  filename: string;
  primary?: boolean;
};

const cliTarball = `ospex-cli-${VERSION}.tgz`;
const sdkTarball = `ospex-sdk-${VERSION}.tgz`;

const tarballs: Tarball[] = [
  {
    title: "@ospex/cli",
    description:
      "The ospex command line — a single self-contained bundle with every dependency (including @ospex/sdk) inlined. Install globally, then run ospex.",
    filename: cliTarball,
    primary: true,
  },
  {
    title: "@ospex/sdk",
    description:
      "Optional unbundled library for programmatic consumers writing code against @ospex/sdk — reads, EIP-712 signed commitments, position lifecycle, streaming odds, owner-authenticated own-state stream. CLI users do not need this.",
    filename: sdkTarball,
  },
];

const installUrl = `${RELEASE_BASE}/${cliTarball}`;
const verifyCommand = "ospex --version";

type InstallTab = {
  id: string;
  label: string;
  command: string;
};

const installTabs: InstallTab[] = [
  { id: "npm", label: "npm", command: "npm install -g" },
  { id: "yarn", label: "yarn", command: "yarn global add" },
];

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          },
          () => undefined,
        );
      }}
      className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

export default function Downloads() {
  const [activeTab, setActiveTab] = useState(installTabs[0].id);
  const active = installTabs.find((t) => t.id === activeTab) ?? installTabs[0];
  // Single source for both the displayed text and the clipboard text, so the
  // visible <code> is always a valid one-line command (no embedded newline).
  const installCommand = `${active.command} ${installUrl}`;

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <AppHeader />
      <div className="max-w-2xl mx-auto mt-8">
        <h2 className="text-2xl font-bold mb-1">downloads</h2>
        <p className="text-sm text-muted-foreground mb-6">
          The <code className="font-mono text-xs">ospex</code> CLI ships as one
          self-contained bundle — install it globally, then just type{" "}
          <code className="font-mono text-xs">ospex</code>. No package manager juggling.
        </p>

        <ul className="space-y-4">
          {tarballs.map((t) => (
            <li key={t.title}>
              <a
                href={`${RELEASE_BASE}/${t.filename}`}
                className="block hover:bg-secondary/30 rounded-lg p-3 -mx-3 transition-colors"
                download
              >
                <span className="text-foreground font-medium">
                  {t.title}
                  <span className="ml-2 inline-block rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted-foreground align-middle">
                    v{VERSION}
                  </span>
                  <span className="ml-2 inline-block rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted-foreground align-middle">
                    {t.primary ? "recommended" : "optional · library"}
                  </span>
                </span>
                <span className="block text-sm text-muted-foreground mt-1">
                  {t.description}
                </span>
                <span className="block text-xs font-mono text-muted-foreground mt-1">
                  {t.filename}
                </span>
              </a>
            </li>
          ))}
        </ul>

        <div className="mt-8">
          <h3 className="text-sm font-semibold mb-2">install</h3>
          <div className="flex gap-1 mb-2" role="tablist" aria-label="install command">
            {installTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === activeTab}
                onClick={() => setActiveTab(t.id)}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                  t.id === activeTab
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-secondary/30 hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <pre className="bg-secondary/30 rounded-lg p-3 pr-12 text-sm whitespace-pre-wrap break-words">
              <code className="font-mono">{installCommand}</code>
            </pre>
            <CopyButton text={installCommand} label="Copy install command" />
          </div>
          <p className="text-xs text-muted-foreground mt-3 mb-1">
            then verify it's on your PATH:
          </p>
          <div className="relative">
            <pre className="bg-secondary/30 rounded-lg p-3 pr-12 text-sm">
              <code className="font-mono">{verifyCommand}</code>
            </pre>
            <CopyButton text={verifyCommand} label="Copy verify command" />
          </div>
          <p className="text-sm text-muted-foreground mt-3">
            One global install, nothing else to resolve — every dependency is inlined into
            the bundle, so there's no second tarball to add and no registry lookup.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Writing code against{" "}
            <code className="font-mono text-xs">@ospex/sdk</code>? Grab the optional SDK
            tarball above. CLI users don't need it.
          </p>
        </div>

        <div className="mt-8 text-sm text-muted-foreground">
          <a
            href="https://github.com/ospex-org/ospex-sdk/releases"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground transition-colors"
          >
            all releases &rarr;
          </a>
          <span className="mx-2">·</span>
          <a
            href="https://github.com/ospex-org/ospex-sdk/blob/main/docs/QUICKSTART.md"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground transition-colors"
          >
            quickstart &rarr;
          </a>
          <span className="mx-2">·</span>
          <a
            href="https://github.com/ospex-org/ospex-sdk/blob/main/docs/AGENT_CONTRACT.md"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground transition-colors"
          >
            agent contract &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
