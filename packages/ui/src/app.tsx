import { useEffect, useState } from "react";
import { cn } from "./lib/utils.ts";
import { href, parseRoute, type Route } from "./route.ts";
import { TABS } from "./tabs.ts";

const IDS = TABS.map((t) => t.id);

function useRoute(tabs: readonly string[]): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const changed = () => setHash(window.location.hash);
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return parseRoute(hash, tabs);
}

export function App() {
  const route = useRoute(IDS);
  const query = route.params.toString();
  const [opened, setOpened] = useState<Record<string, string>>({});
  if (opened[route.tab] !== query) setOpened({ ...opened, [route.tab]: query });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-border">
        <div className="flex items-center gap-6">
          <span className="pb-3 text-base font-semibold tracking-tight">Quench</span>
          <nav aria-label="Views" className="flex gap-4">
            {TABS.map((t) => (
              <a
                key={t.id}
                href={href(t.id)}
                aria-current={t.id === route.tab ? "page" : undefined}
                className={cn(
                  "-mb-px border-b-2 border-transparent pb-3 text-sm text-muted-foreground hover:text-foreground",
                  t.id === route.tab && "border-foreground font-medium text-foreground",
                )}
              >
                {t.label}
              </a>
            ))}
          </nav>
        </div>
        <span className="pb-3 font-mono text-xs text-muted-foreground">read-only</span>
      </header>
      {TABS.filter((t) => t.id in opened).map(({ id, label, Page }) => (
        <section key={id} hidden={id !== route.tab} aria-label={label}>
          <Page params={new URLSearchParams(opened[id])} />
        </section>
      ))}
    </div>
  );
}
