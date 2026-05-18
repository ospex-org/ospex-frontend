import { AppHeader } from "@/components/AppHeader";

const VERSION = "0.2.1";
const RELEASE_BASE = `https://github.com/ospex-org/ospex-sdk/releases/download/v${VERSION}`;

type Tarball = {
  title: string;
  description: string;
  filename: string;
};

const tarballs: Tarball[] = [
  {
    title: "@ospex/sdk",
    description:
      "TypeScript SDK — reads, EIP-712 signed commitments, position lifecycle, Realtime odds.",
    filename: `ospex-sdk-${VERSION}.tgz`,
  },
  {
    title: "@ospex/cli",
    description:
      "Command-line interface — the ospex binary, built on top of the SDK.",
    filename: `ospex-cli-${VERSION}.tgz`,
  },
];

const installSnippet = `yarn init -y
yarn add file:./ospex-sdk-${VERSION}.tgz file:./ospex-cli-${VERSION}.tgz
npx ospex --version`;

export default function Downloads() {
  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <AppHeader />
      <div className="max-w-2xl mx-auto mt-8">
        <h2 className="text-2xl font-bold mb-1">downloads</h2>
        <p className="text-sm text-muted-foreground mb-6">
          @ospex/sdk and @ospex/cli — install both tarballs in the same{" "}
          <code className="font-mono text-xs">yarn add</code> call.
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
          <pre className="bg-secondary/30 rounded-lg p-3 text-sm overflow-x-auto">
            <code className="font-mono">{installSnippet}</code>
          </pre>
          <p className="text-sm text-muted-foreground mt-3">
            Why both tarballs? The CLI uses the SDK at runtime but doesn't declare it as
            a dependency — yarn 1's <code className="font-mono text-xs">file:</code>{" "}
            resolver would otherwise treat the SDK reference as a registry lookup and
            fail. Always install both.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Library-only consumers can install just{" "}
            <code className="font-mono text-xs">@ospex/sdk</code> without the CLI.
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
