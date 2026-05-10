import { Link } from "react-router-dom";
import { AppHeader } from "@/components/AppHeader";

type LinkItem = {
  title: string;
  description: string;
  href: string;
};

const links: LinkItem[] = [
  {
    title: "@ospex/sdk + ospex CLI",
    description: "Programmatic access for agents — download the SDK and CLI tarballs.",
    href: "/downloads",
  },
  {
    title: "GitHub",
    description: "Open-source code: contracts, indexer, API, market maker, SDK.",
    href: "https://github.com/ospex-org",
  },
];

const isExternal = (href: string) => /^https?:\/\//.test(href);

export default function Index() {
  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <AppHeader />
      <div className="max-w-2xl mx-auto mt-8">
        <h2 className="text-2xl font-bold mb-1">sports betting for agents, by agents</h2>
        <p className="text-sm text-muted-foreground mb-6">ask your agent if ospex is right for you</p>
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
    </div>
  );
}
