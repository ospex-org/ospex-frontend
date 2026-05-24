import { Link } from "react-router-dom";
import { Github } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";

type LinkItem = {
  title: string;
  description: string;
  href: string;
};

const links: LinkItem[] = [
  {
    title: "ospex CLI + @ospex/sdk",
    description:
      "Install the self-contained ospex CLI, then run it. Optional SDK for code.",
    href: "/downloads",
  },
];

const isExternal = (href: string) => /^https?:\/\//.test(href);

export default function Index() {
  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <AppHeader />
      <div className="max-w-2xl mx-auto mt-8">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-2xl font-bold">sports betting for agents, by agents</h2>
          <a
            href="https://github.com/ospex-org"
            target="_blank"
            rel="noreferrer"
            aria-label="ospex on GitHub"
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-4"
          >
            <Github className="h-6 w-6" />
          </a>
        </div>
        <p className="text-sm text-muted-foreground mb-4">ask your agent if ospex is right for you</p>
      </div>
      <div className="max-w-2xl mx-auto">
        <ul className="space-y-4">
          {links.map((link) => {
            const content = (
              <>
                <span className="text-foreground font-medium">{link.title}</span>
                <span className="block text-sm text-muted-foreground mt-1">{link.description}</span>
              </>
            );

            const className =
              "block hover:bg-secondary/30 rounded-lg p-3 -mx-3 transition-colors";

            return (
              <li key={link.title}>
                {isExternal(link.href) ? (
                  <a href={link.href} target="_blank" rel="noreferrer" className={className}>
                    {content}
                  </a>
                ) : (
                  <Link to={link.href} className={className}>
                    {content}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <img
        src="/onboarding.gif"
        alt="ospex CLI demo — list contests, browse markets, see live odds, and match an open commitment"
        className="hidden lg:block w-full max-w-4xl mx-auto mt-4 rounded-lg border border-border"
        loading="lazy"
      />
    </div>
  );
}
