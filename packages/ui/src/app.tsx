import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { CorrectionsView } from "./corrections-view.tsx";
import type { CorrectionsResponse } from "./corrections.ts";
import { Fresh } from "./fresh.tsx";
import { HOUSEKEEPING, HousekeepingView } from "./housekeeping-view.tsx";
import { cn } from "./lib/utils.ts";
import { OverviewView } from "./overview-view.tsx";
import type { Report } from "./report.ts";
import { SkillsView } from "./skills-view.tsx";
import type { Harness, SkillsReport } from "./skills.ts";
import { TasksView } from "./tasks-view.tsx";
import type { TasksReport } from "./tasks.ts";
import { useApis, type Load, type State } from "./use-api.ts";

const TABS = [
  ["overview", "Overview"],
  ["tasks", "Tasks"],
  ["skills", "Skills"],
  ["corrections", "Corrections"],
  ["housekeeping", "Housekeeping"],
] as const;

type Tab = (typeof TABS)[number][0];

const routeOf = (hash: string) => {
  const [path = "", query = ""] = hash.split("?");
  const tab = TABS.find(([id]) => `#${id}` === path)?.[0] ?? "overview";
  return { tab, agent: new URLSearchParams(query).get("agent") };
};

const REPORT = "/api/report";
const SKILLS = "/api/skills";
const CORRECTIONS = "/api/corrections";
const TASKS = "/api/tasks";

const PATHS: Record<Tab, readonly string[]> = {
  overview: [REPORT],
  tasks: [TASKS],
  skills: [SKILLS],
  corrections: [CORRECTIONS],
  housekeeping: HOUSEKEEPING,
};

export function App() {
  const [{ tab, agent }, setRoute] = useState(() => routeOf(location.hash));
  useEffect(() => {
    const follow = () => setRoute(routeOf(location.hash));
    addEventListener("hashchange", follow);
    return () => removeEventListener("hashchange", follow);
  }, []);
  const { states, load, ensure } = useApis();
  useEffect(() => PATHS[tab].forEach(ensure), [ensure, tab]);
  const stateOf = <T,>(path: string) => (states[path] ?? { status: "loading" }) as State<T>;

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
        <span className="font-mono text-xs text-muted-foreground">read-only</span>
      </header>
      {tab === "overview" && <OverviewPage state={stateOf<Report>(REPORT)} load={load} />}
      {tab === "tasks" && <TasksPage state={stateOf<TasksReport>(TASKS)} load={load} />}
      {tab === "skills" && (
        <SkillsPage
          state={stateOf<SkillsReport>(SKILLS)}
          load={load}
          agent={agent as Harness | null}
        />
      )}
      {tab === "corrections" && (
        <CorrectionsPage state={stateOf<CorrectionsResponse>(CORRECTIONS)} load={load} />
      )}
      {tab === "housekeeping" && <HousekeepingView states={states} load={load} />}
    </div>
  );
}

type Page<T> = { state: State<T>; load: Load };

function OverviewPage({ state, load }: Page<Report>) {
  return (
    <Loading state={state} load={() => load(REPORT)} what="your sessions">
      {(report) => (
        <>
          <Days days={report.days}>
            <Fresh state={state} refresh={() => load(REPORT, true)} />
          </Days>
          {report.harnesses.length ? (
            <OverviewView report={report} />
          ) : (
            <Message title="No sessions found">
              No agent session started in the last {report.days} days. Run quench ui --days 90 to
              look further back.
            </Message>
          )}
        </>
      )}
    </Loading>
  );
}

function TasksPage({ state, load }: Page<TasksReport>) {
  return (
    <Loading state={state} load={() => load(TASKS)} what="your tasks">
      {(report) => (
        <>
          <Days days={report.days}>
            <Fresh state={state} refresh={() => load(TASKS, true)} />
          </Days>
          {report.tasks.length ? (
            <TasksView report={report} />
          ) : (
            <Message title="No tasks found">
              No agent session started in the last {report.days} days. Run quench ui --days 90 to
              look further back.
            </Message>
          )}
        </>
      )}
    </Loading>
  );
}

function SkillsPage({ state, load, agent }: Page<SkillsReport> & { agent: Harness | null }) {
  return (
    <Loading state={state} load={() => load(SKILLS)} what="your skills">
      {(report) => (
        <>
          <Days days={report.days}>
            <Fresh state={state} refresh={() => load(SKILLS, true)} />
          </Days>
          {report.skills.length ? (
            <SkillsView key={agent} report={report} agent={agent} />
          ) : (
            <Message title="No skills found">
              None of your agents have skills on disk, and no session in the last {report.days} days
              listed one. Add a skill, or run quench ui --days 90.
            </Message>
          )}
        </>
      )}
    </Loading>
  );
}

function CorrectionsPage({ state, load }: Page<CorrectionsResponse>) {
  return (
    <Loading state={state} load={() => load(CORRECTIONS)} what="your corrections">
      {(report) =>
        report.judge === null ? (
          <Message title="Reply classification is off">
            No judge is set, so no reply has been judged. Pick one with quench setup judge, then run
            quench corrections.
          </Message>
        ) : (
          <>
            <Days days={report.days}>
              <Fresh state={state} refresh={() => load(CORRECTIONS, true)} />
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
        The first run reads every session and can take a minute. Later visits show the last result
        at once.
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
    <div className="-mt-3 mb-5 flex flex-wrap items-center gap-3 font-mono text-xs text-muted-foreground">
      <span>last {days} days ·</span>
      {children}
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
