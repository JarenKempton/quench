import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { HousekeepingView } from "./housekeeping-view.tsx";
import { cn } from "./lib/utils.ts";
import { SkillsView } from "./skills-view.tsx";
import type { SkillsReport } from "./skills.ts";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; report: SkillsReport };

const TABS = [
  ["skills", "Skills"],
  ["housekeeping", "Housekeeping"],
] as const;

type Tab = (typeof TABS)[number][0];

const tabOf = (hash: string): Tab => (hash === "#housekeeping" ? "housekeeping" : "skills");

export function App() {
  const [tab, setTab] = useState<Tab>(() => tabOf(location.hash));
  useEffect(() => {
    const follow = () => setTab(tabOf(location.hash));
    addEventListener("hashchange", follow);
    return () => removeEventListener("hashchange", follow);
  }, []);
  const [state, setState] = useState<State>({ status: "loading" });
  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const response = await fetch("/api/skills");
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      setState({ status: "ready", report: (await response.json()) as SkillsReport });
    } catch (error) {
      setState({ status: "error", message: (error as Error).message });
    }
  }, []);
  const skillsAsked = useRef(false);
  useEffect(() => {
    if (tab !== "skills" || skillsAsked.current) return;
    skillsAsked.current = true;
    void load();
  }, [tab, load]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <span className="text-base font-semibold tracking-tight">Quench</span>
          <nav className="flex gap-3 text-sm">
            {TABS.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                aria-current={tab === id ? "page" : undefined}
                className={cn(
                  "text-muted-foreground hover:text-foreground",
                  tab === id && "text-foreground",
                )}
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
        {tab === "skills" && state.status === "ready" && (
          <span className="font-mono text-xs text-muted-foreground">
            last {state.report.days} days · read-only
          </span>
        )}
      </header>
      {tab === "housekeeping" && <HousekeepingView />}
      {tab === "skills" && state.status === "loading" && (
        <Message title="Reading your session history…">
          The first run reads every session and can take a minute. Later runs use the cache.
        </Message>
      )}
      {tab === "skills" && state.status === "error" && (
        <Message title="Couldn't load your skills">
          <span className="font-mono text-xs">{state.message}</span>
          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={load}>
              Try again
            </Button>
          </div>
        </Message>
      )}
      {tab === "skills" &&
        state.status === "ready" &&
        (state.report.skills.length ? (
          <SkillsView report={state.report} />
        ) : (
          <Message title="No skills found">
            None of your agents have skills on disk, and no session in the last {state.report.days}{" "}
            days listed one. Add a skill, or run quench ui --days 90.
          </Message>
        ))}
    </div>
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <div className="mt-1 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
