import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { CorrectionsView } from "./corrections-view.tsx";
import type { CorrectionsResponse } from "./corrections.ts";
import { cn } from "./lib/utils.ts";
import { SkillsView } from "./skills-view.tsx";
import type { SkillsReport } from "./skills.ts";
import { useApis, type Load, type State } from "./use-api.ts";

const TABS = [
  { route: "#/", label: "Skills" },
  { route: "#/corrections", label: "Corrections" },
] as const;

type Route = (typeof TABS)[number]["route"];

const routeOf = (hash: string): Route => TABS.find((t) => t.route === hash)?.route ?? "#/";

const PATHS: Record<Route, string> = { "#/": "/api/skills", "#/corrections": "/api/corrections" };

export function App() {
  const [route, setRoute] = useState(() => routeOf(location.hash));
  useEffect(() => {
    const changed = () => setRoute(routeOf(location.hash));
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  const { states, load, ensure } = useApis();
  const path = PATHS[route];
  useEffect(() => ensure(path), [ensure, path]);
  const state = states[path] ?? { status: "loading" };
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
      {route === "#/corrections" ? (
        <CorrectionsPage state={state as State<CorrectionsResponse>} load={load} />
      ) : (
        <SkillsPage state={state as State<SkillsReport>} load={load} />
      )}
    </div>
  );
}

type Page<T> = { state: State<T>; load: Load };

function SkillsPage({ state, load }: Page<SkillsReport>) {
  return (
    <Loading state={state} load={() => load("/api/skills")} what="your skills">
      {(report) =>
        report.skills.length ? (
          <>
            <Days days={report.days}>
              <Fresh state={state} refresh={() => load("/api/skills", true)} />
            </Days>
            <SkillsView report={report} />
          </>
        ) : (
          <>
            <Days days={report.days}>
              <Fresh state={state} refresh={() => load("/api/skills", true)} />
            </Days>
            <Message title="No skills found">
              None of your agents have skills on disk, and no session in the last {report.days} days
              listed one. Add a skill, or run quench ui --days 90.
            </Message>
          </>
        )
      }
    </Loading>
  );
}

function CorrectionsPage({ state, load }: Page<CorrectionsResponse>) {
  return (
    <Loading state={state} load={() => load("/api/corrections")} what="your corrections">
      {(report) =>
        report.judge === null ? (
          <Message title="Reply classification is off">
            No judge is set, so no reply has been judged. Pick one with quench setup judge, then run
            quench corrections.
          </Message>
        ) : (
          <>
            <Days days={report.days}>
              <Fresh state={state} refresh={() => load("/api/corrections", true)} />
            </Days>
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

function Days({ days, children }: { days: number; children?: React.ReactNode }) {
  return (
    <div className="-mt-3 mb-5 flex items-center gap-3 font-mono text-xs text-muted-foreground">
      <span>last {days} days</span>
      {children}
    </div>
  );
}

const ago = (at: Date, now: number) => {
  const minutes = Math.floor((now - at.getTime()) / 60_000);
  return minutes < 1 ? "just now" : minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
};

function Fresh<T>({ state, refresh }: { state: State<T>; refresh: () => void }) {
  if (state.status !== "ready" || !state.computedAt) return null;
  return (
    <>
      <Age at={state.computedAt} refreshing={state.refreshing} refresh={refresh} />
      {state.error && (
        <span role="alert" className="text-warn">
          Refresh failed: {state.error}
        </span>
      )}
    </>
  );
}

function Age({ at, refreshing, refresh }: { at: Date; refreshing: boolean; refresh: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);
  return (
    <>
      <span>· computed {ago(at, now)}</span>
      <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
        <RefreshCw className={cn(refreshing && "animate-spin")} />
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
    </>
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
