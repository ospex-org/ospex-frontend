import { useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { cn } from "@/lib/utils";

const VERSION = "0.4.0";
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
      "Optional unbundled library for programmatic consumers writing code against @ospex/sdk — reads, EIP-712 signed commitments, position lifecycle, streaming odds. CLI users do not need this.",
    filename: sdkTarball,
  },
];

type InstallTab = {
  id: string;
  label: string;
  snippet: string;
};

const installTabs: InstallTab[] = [
  {
    id: "npm",
    label: "npm",
    snippet: `npm install -g ${RELEASE_BASE}/${cliTarball}
ospex --version`,
  },
  {
    id: "yarn",
    label: "yarn",
    snippet: `yarn global add ${RELEASE_BASE}/${cliTarball}
ospex --version`,
  },
];

export default function Downloads() {
  const [activeTab, setActiveTab] = useState(installTabs[0].id);
  const active = installTabs.find((t) => t.id === activeTab) ?? installTabs[0];

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
                  {t.primary ? (
                    <span className="ml-2 inline-block rounded-full bg-primary/15 px-2 py-0.5 text-xs font-normal text-primary align-middle">
                      recommended
                    </span>
                  ) : (
                    <span className="ml-2 inline-block rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted-foreground align-middle">
                      optional · library
                    </span>
                  )}
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
          <pre className="bg-secondary/30 rounded-lg p-3 text-sm overflow-x-auto">
            <code className="font-mono">{active.snippet}</code>
          </pre>
          <p className="text-sm text-muted-foreground mt-3">
            One global install, nothing else to resolve — every dependency is inlined into
            the bundle, so there's no second tarball to add and no registry lookup. After it
            installs, <code className="font-mono text-xs">ospex</code> is on your PATH.
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
