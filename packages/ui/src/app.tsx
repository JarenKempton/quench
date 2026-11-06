import { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { CorrectionsView } from "./corrections-view.tsx";
import type { CorrectionsResponse } from "./corrections.ts";
import { cn } from "./lib/utils.ts";
import { SkillsView } from "./skills-view.tsx";
import type { SkillsReport } from "./skills.ts";

type State<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; report: T };

const TABS = [
  { route: "#/", label: "Skills" },
  { route: "#/corrections", label: "Corrections" },
] as const;

type Route = (typeof TABS)[number]["route"];

const routeOf = (hash: string): Route => TABS.find((t) => t.route === hash)?.route ?? "#/";

function useApi<T>(path: string) {
  const [state, setState] = useState<State<T>>({ status: "loading" });
  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      setState({ status: "ready", report: (await response.json()) as T });
    } catch (error) {
      setState({ status: "error", message: (error as Error).message });
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return [state, load] as const;
}

export function App() {
  const [route, setRoute] = useState(() => routeOf(location.hash));
  useEffect(() => {
    const changed = () => setRoute(routeOf(location.hash));
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-baseline gap-5">
        <span className="text-base font-semibold tracking-tight">Quench</span>
        <nav className="flex items-baseline gap-4 text-sm">
          {TABS.map((t) => (
            <a
              key={t.route}
              href={t.route}
              aria-current={route === t.route ? "page" : undefined}
              className={cn(
                "text-muted-foreground hover:text-foreground",
                route === t.route && "font-medium text-foreground",
              )}
            >
              {t.label}
            </a>
          ))}
        </nav>
        <span className="ml-auto font-mono text-xs text-muted-foreground">read-only</span>
      </header>
      {route === "#/corrections" ? <CorrectionsPage /> : <SkillsPage />}
    </div>
  );
}

function SkillsPage() {
  const [state, load] = useApi<SkillsReport>("/api/skills");
  return (
    <Loading state={state} load={load} what="your skills">
      {(report) =>
        report.skills.length ? (
          <>
            <Days days={report.days} />
            <SkillsView report={report} />
          </>
        ) : (
          <Message title="No skills found">
            None of your agents have skills on disk, and no session in the last {report.days} days
            listed one. Add a skill, or run quench ui --days 90.
          </Message>
        )
      }
    </Loading>
  );
}

function CorrectionsPage() {
  const [state, load] = useApi<CorrectionsResponse>("/api/corrections");
  return (
    <Loading state={state} load={load} what="your corrections">
      {(report) =>
        report.judge === null ? (
          <Message title="Reply classification is off">
            No judge is set, so no reply has been judged. Pick one with quench setup judge, then run
            quench corrections.
          </Message>
        ) : (
          <>
            <Days days={report.days} />
            <CorrectionsView report={report} />
          </>
        )
      }
    </Loading>
  );
}

function Loading<T>({
  state,
  load,
  what,
  children,
}: {
  state: State<T>;
  load: () => void;
  what: string;
  children: (report: T) => React.ReactNode;
}) {
  if (state.status === "ready") return children(state.report);
  if (state.status === "loading")
    return (
      <Message title="Reading your session history…">
        The first run reads every session and can take a minute. Later runs use the cache.
      </Message>
    );
  return (
    <Message title={`Couldn't load ${what}`}>
      <span className="font-mono text-xs">{state.message}</span>
      <div className="mt-4">
        <Button variant="outline" size="sm" onClick={load}>
          Try again
        </Button>
      </div>
    </Message>
  );
}

function Days({ days }: { days: number }) {
  return <p className="-mt-3 mb-5 font-mono text-xs text-muted-foreground">last {days} days</p>;
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <div className="mt-1 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
