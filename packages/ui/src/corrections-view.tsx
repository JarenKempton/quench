import { ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";
import { Badge } from "./components/ui/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.tsx";
import { CopyButton } from "./copy-button.tsx";
import {
  judgeCommand,
  percent,
  rate,
  shownFiles,
  type CorrectionsReport,
  type FileHistory,
  type Loaded,
  type VersionCounts,
} from "./corrections.ts";
import { cn } from "./lib/utils.ts";
import { RateChart } from "./rate-chart.tsx";

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const num = "text-right font-mono text-xs tabular-nums";

const span = (first: string | null, last: string | null) =>
  first === null ? "–" : first === last ? first : `${first} → ${last}`;

export function CorrectionsView({ report }: { report: CorrectionsReport }) {
  const { context } = report;
  const people = report.fromPeople;
  const agents = report.fromAutomation;
  return (
    <div className="space-y-10">
      <section className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
        <Stat
          label="Corrections from people"
          value={percent(rate(people.kinds.correction, people.judged))}
          detail={`${people.kinds.correction} of ${people.judged} judged replies`}
        />
        <Stat
          label="Corrections from agents / automation"
          value={percent(rate(agents.kinds.correction, agents.judged))}
          detail={`${agents.kinds.correction} of ${agents.judged} judged replies`}
        />
        <Stat
          label="Not judged yet"
          value={String(report.pending)}
          detail="replies left out of every rate here"
        />
      </section>
      {report.pending > 0 && <Pending report={report} />}

      <section className="space-y-3">
        <Heading title="Correction rate over time" />
        {report.weekly.length ? (
          <>
            <RateChart weeks={report.weekly} />
            <WeeklyTable report={report} />
          </>
        ) : (
          <Empty>No judged replies in the last {report.days} days.</Empty>
        )}
      </section>

      <section className="space-y-3">
        <Heading
          title="Recurring corrections"
          note={`${context.recurring.length} behaviours corrected in 2+ sessions · ${context.singleSession} in one session · ${context.withoutBehaviour} of ${context.corrections} corrections had no recorded behaviour`}
        />
        {context.recurring.length ? (
          <RecurringTable recurring={context.recurring} />
        ) : (
          <Empty>No behaviour was corrected in more than one session.</Empty>
        )}
      </section>

      <section className="space-y-3">
        <Heading
          title="Skill and instruction files in context"
          note={`${shownFiles(context.history).length} of ${context.history.files.length} files with ${context.history.floor}+ sessions · split at each content change`}
        />
        <FilesTable report={report} />
      </section>

      <p className="text-xs text-muted-foreground">
        Rates count only replies already judged by {report.judge}; this page never calls a judge.
        Counts, dates and locations only: no message text. Every pattern here is{" "}
        {context.history.basis}.
      </p>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="bg-background px-5 py-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function Pending({ report }: { report: CorrectionsReport }) {
  const command = judgeCommand(report.days);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm">
      <span>
        {report.pending} replies are not judged yet. Opening this page never spends money; to judge
        them ({report.calls} requests to {report.judge}), run
      </span>
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{command}</code>
      <CopyButton text={command} label="Copy" />
    </div>
  );
}

function Heading({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-sm font-medium">{title}</h2>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-border px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function WeeklyTable({ report }: { report: CorrectionsReport }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">Show as a table</summary>
      <div className="mt-2 rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Week of</TableHead>
              <TableHead className="text-right">People</TableHead>
              <TableHead className="text-right">Agents / automation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.weekly.map((w) => (
              <TableRow key={w.week}>
                <TableCell className="font-mono text-xs">{w.week}</TableCell>
                {[w.fromPeople, w.fromAutomation].map((c, i) => (
                  <TableCell key={i} className={num}>
                    {percent(rate(c.corrections, c.judged))} · {c.corrections} of {c.judged}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </details>
  );
}

function useOpen() {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return [open, toggle] as const;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
    />
  );
}

function RecurringTable({ recurring }: { recurring: CorrectionsReport["context"]["recurring"] }) {
  const [open, toggle] = useOpen();
  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-6" />
            <TableHead>Behaviour before the correction</TableHead>
            <TableHead className="text-right">Corrections</TableHead>
            <TableHead className="text-right">Sessions</TableHead>
            <TableHead className="text-right">People</TableHead>
            <TableHead className="text-right">Agents</TableHead>
            <TableHead>Dates</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recurring.map((r) => {
            const isOpen = open.has(r.behaviour);
            return (
              <Fragment key={r.behaviour}>
                <TableRow
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => toggle(r.behaviour)}
                >
                  <TableCell className="pr-0">
                    <Chevron open={isOpen} />
                  </TableCell>
                  <TableCell className="font-medium">
                    <button type="button" aria-expanded={isOpen} className="text-left">
                      {r.behaviour}
                    </button>
                  </TableCell>
                  <TableCell className={num}>{r.corrections}</TableCell>
                  <TableCell className={num}>{r.sessions}</TableCell>
                  <TableCell className={num}>{r.fromPeople}</TableCell>
                  <TableCell className={num}>{r.fromAutomation}</TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">
                    {span(r.first, r.last)}
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell />
                    <TableCell colSpan={6}>
                      <div className="grid gap-6 py-2 lg:grid-cols-2">
                        <InContext title="Skills loaded" rows={r.skills} />
                        <InContext title="Instruction files in context" rows={r.files} />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

const FIRST = 8;

function InContext({ title, rows }: { title: string; rows: Loaded[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, FIRST);
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {rows.length ? (
        <ul className="space-y-1">
          {shown.map((l) => (
            <li key={l.name} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate font-mono" title={l.name}>
                {l.name}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                {count(l.sessions, "session")} · {count(l.corrections, "correction")}
              </span>
            </li>
          ))}
          {rows.length > FIRST && (
            <li>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setAll(!all)}
              >
                {all ? "Show fewer" : `Show all ${rows.length}`}
              </button>
            </li>
          )}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">None recorded.</p>
      )}
    </div>
  );
}

const corrected = (c: VersionCounts) =>
  `${c.withHumanCorrection} of ${c.judged} (${percent(rate(c.withHumanCorrection, c.judged))})`;

const size = (bytes: number | null) => (bytes === null ? "–" : `${bytes.toLocaleString()} B`);

function FilesTable({ report }: { report: CorrectionsReport }) {
  const { history } = report.context;
  const files = shownFiles(history);
  const [open, toggle] = useOpen();
  if (!files.length)
    return (
      <Empty>
        No skill or instruction file was in context for {history.floor}+ sessions. Files outside git
        get a history once quench corrections --context has recorded them.
      </Empty>
    );
  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-6" />
            <TableHead>File</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead className="text-right">Sessions</TableHead>
            <TableHead className="text-right">Versions</TableHead>
            <TableHead>Flags</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((f) => {
            const isOpen = open.has(f.path);
            const grew = f.changes.filter((c) => c.grewWithoutDrop);
            return (
              <Fragment key={f.path}>
                <TableRow
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => toggle(f.path)}
                >
                  <TableCell className="pr-0">
                    <Chevron open={isOpen} />
                  </TableCell>
                  <TableCell className="max-w-md">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      className="block max-w-full truncate text-left font-mono text-xs"
                      title={f.path}
                    >
                      {f.path}
                    </button>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    {f.kind === "skill" ? `skill ${f.name}` : "instructions"}
                  </TableCell>
                  <TableCell className={num}>{f.sessions}</TableCell>
                  <TableCell className={num}>{f.versions.length}</TableCell>
                  <TableCell>
                    {grew.length > 0 && (
                      <Badge variant="warn">Grew with no drop · {history.basis}</Badge>
                    )}
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell />
                    <TableCell colSpan={5}>
                      <Versions file={f} basis={history.basis} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function Versions({ file, basis }: { file: FileHistory; basis: string }) {
  const versions = file.versions.filter((v) => v.loaded.sessions || v.without.sessions);
  return (
    <div className="space-y-3 py-2">
      <p className="text-xs text-muted-foreground">
        Versions from {file.source === "git" ? "git commits" : "snapshots Quench recorded"}.
        Corrected means a session with a correction from a person, of sessions with a judged reply.
      </p>
      {versions.length ? (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="text-left">
              <th className="py-1 pr-4 font-normal">Version</th>
              <th className="py-1 pr-4 text-right font-normal">Size</th>
              <th className="py-1 pr-4 text-right font-normal">Sessions loaded</th>
              <th className="py-1 pr-4 text-right font-normal">Corrected when loaded</th>
              <th className="py-1 text-right font-normal">Corrected in other sessions</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {versions.map((v) => (
              <tr key={`${v.treeHash}${v.from}`} className="border-t border-border">
                <td className="py-1 pr-4 whitespace-nowrap">
                  {v.from.slice(0, 10)} → {v.to ? v.to.slice(0, 10) : "now"}
                </td>
                <td className="py-1 pr-4 text-right">{size(v.bytes)}</td>
                <td className="py-1 pr-4 text-right">{v.loaded.sessions}</td>
                <td className="py-1 pr-4 text-right">{corrected(v.loaded)}</td>
                <td className="py-1 text-right">{corrected(v.without)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-muted-foreground">No version was in context in this window.</p>
      )}
      {file.changes
        .filter((c) => c.grewWithoutDrop)
        .map((c) => (
          <p key={c.at} className="text-xs text-warn">
            Grew {c.grewBy} B on {c.at.slice(0, 10)} with no drop in correction rate (
            {percent(c.rates.before)} → {percent(c.rates.after)}); {basis}.
          </p>
        ))}
    </div>
  );
}
