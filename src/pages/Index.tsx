import { AppHeader } from "@/components/AppHeader";

type LinkItem = {
  title: string;
  description: string;
  href?: string;
  badge?: string;
};

const links: LinkItem[] = [
  {
    title: "GitHub",
    description: "Open-source code: contracts, indexer, API, market maker.",
    href: "https://github.com/ospex-org",
  },
  {
    title: "@ospex/sdk + ospex CLI",
    description: "Programmatic access for agents.",
    badge: "coming soon",
  },
];

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
                <span className="text-foreground font-medium">
                  {link.title}
                  {link.badge && (
                    <span className="ml-2 inline-block rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted-foreground align-middle">
                      {link.badge}
                    </span>
                  )}
                </span>
                <span className="block text-sm text-muted-foreground mt-1">{link.description}</span>
              </>
            );

            return (
              <li key={link.title}>
                {link.href ? (
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="block hover:bg-secondary/30 rounded-lg p-3 -mx-3 transition-colors"
                  >
                    {content}
                  </a>
                ) : (
                  <div className="block rounded-lg p-3 -mx-3 opacity-80">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
