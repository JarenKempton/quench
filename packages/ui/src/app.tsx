import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { CorrectionsView } from "./corrections-view.tsx";
import type { CorrectionsResponse } from "./corrections.ts";
import { Fresh } from "./fresh.tsx";
import { HOUSEKEEPING, HousekeepingView } from "./housekeeping-view.tsx";
import { cn } from "./lib/utils.ts";
import { SkillsView } from "./skills-view.tsx";
import type { SkillsReport } from "./skills.ts";
import { useApis, type Load, type State } from "./use-api.ts";

const TABS = [
  ["skills", "Skills"],
  ["corrections", "Corrections"],
  ["housekeeping", "Housekeeping"],
] as const;

type Tab = (typeof TABS)[number][0];

const tabOf = (hash: string): Tab => TABS.find(([id]) => `#${id}` === hash)?.[0] ?? "skills";

const SKILLS = "/api/skills";
const CORRECTIONS = "/api/corrections";

const PATHS: Record<Tab, readonly string[]> = {
  skills: [SKILLS],
  corrections: [CORRECTIONS],
  housekeeping: HOUSEKEEPING,
};

export function App() {
  const [tab, setTab] = useState<Tab>(() => tabOf(location.hash));
  useEffect(() => {
    const follow = () => setTab(tabOf(location.hash));
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
      {tab === "skills" && <SkillsPage state={stateOf<SkillsReport>(SKILLS)} load={load} />}
      {tab === "corrections" && (
        <CorrectionsPage state={stateOf<CorrectionsResponse>(CORRECTIONS)} load={load} />
      )}
      {tab === "housekeeping" && <HousekeepingView states={states} load={load} />}
    </div>
  );
}

type Page<T> = { state: State<T>; load: Load };

function SkillsPage({ state, load }: Page<SkillsReport>) {
  return (
    <Loading state={state} load={() => load(SKILLS)} what="your skills">
      {(report) => (
        <>
          <Days days={report.days}>
            <Fresh state={state} refresh={() => load(SKILLS, true)} />
          </Days>
          {report.skills.length ? (
            <SkillsView report={report} />
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
