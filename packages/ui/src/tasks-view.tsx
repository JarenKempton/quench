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
import { cn } from "./lib/utils.ts";
import { HARNESS_LABELS } from "./skills.ts";
import { Filter } from "./skills-view.tsx";
import {
  duration,
  evidenceOf,
  REASON_LABELS,
  SHOW,
  shortId,
  tokens,
  type Guidance,
  type Judgment,
  type TaskRow,
  type TasksReport,
} from "./tasks.ts";

const ALL = "all";
const num = "text-right font-mono text-xs tabular-nums";

export function TasksView({ report }: { report: TasksReport }) {
  const harnesses = [...new Set(report.tasks.flatMap((t) => t.harnesses))];
  const [harness, setHarness] = useState(ALL);
  const [show, setShow] = useState(ALL);
  const [open, setOpen] = useState<string | null>(null);
  const byHarness = report.tasks.filter(
    (t) => harness === ALL || t.harnesses.includes(harness as TaskRow["harnesses"][number]),
  );
  const test = SHOW.find(([id]) => id === show)?.[2];
  const shown = test ? byHarness.filter(test) : byHarness;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Filter
          label="Agent"
          value={harness}
          onChange={setHarness}
          options={harnesses.map((h) => [h, HARNESS_LABELS[h]])}
        />
        <Filter
          label="Show"
          value={show}
          onChange={setShow}
          options={SHOW.map(([id, label, test]) => [
            id,
            `${label} (${byHarness.filter(test).length})`,
          ])}
        />
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {shown.length} of {report.tasks.length} tasks
        </span>
      </div>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-6" />
              <TableHead>Started</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
              <TableHead className="text-right">Turns</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead>Landed</TableHead>
              <TableHead>Spiral</TableHead>
              <TableHead>Efficiency</TableHead>
              <TableHead>Guidance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((t) => {
              const isOpen = open === t.taskId;
              return (
                <Fragment key={t.taskId}>
                  <TableRow
                    data-state={isOpen ? "open" : "closed"}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setOpen(isOpen ? null : t.taskId)}
                  >
                    <TableCell className="pr-0 text-muted-foreground">
                      <ChevronRight
                        className={cn("size-3.5 transition-transform", isOpen && "rotate-90")}
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      <button type="button" aria-expanded={isOpen} className="text-left">
                        {t.startedAt.slice(0, 16).replace("T", " ")}
                      </button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {t.harnesses.map((h) => HARNESS_LABELS[h]).join(" + ")}
                    </TableCell>
                    <TableCell className={num}>{t.sessions}</TableCell>
                    <TableCell className={num}>{t.runs}</TableCell>
                    <TableCell className={num}>{tokens(t.tokens)}</TableCell>
                    <TableCell>
                      <Verdict judgment={t.landed} />
                    </TableCell>
                    <TableCell>
                      <Verdict judgment={t.spiral} />
                    </TableCell>
                    <TableCell>
                      <Verdict judgment={t.efficiency} />
                    </TableCell>
                    <TableCell>
                      <GuidanceBadge guidance={t.guidance} />
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell />
                      <TableCell colSpan={9}>
                        <Detail task={t} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
        {!shown.length && (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No tasks match these filters.
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        A task is one goal, split at a branch, PR or ticket id, a new request or an idle gap. Landed
        reads GitHub's PR state when gh can reach the repo
        {report.offline ? ` (${report.offline} repos unreachable, those use the transcript)` : ""}.
        Efficiency compares tokens and time with landed tasks on the same agents. Guidance shows
        cached judgments only; unjudged gaps show unknown.
      </p>
    </div>
  );
}

function Verdict({ judgment }: { judgment: Judgment }) {
  return (
    <Badge
      variant={
        judgment.verdict === "fail" ? "warn" : judgment.verdict === "pass" ? "default" : "outline"
      }
    >
      {REASON_LABELS[judgment.reason] ?? judgment.reason}
    </Badge>
  );
}

function GuidanceBadge({ guidance }: { guidance: Guidance }) {
  return <Badge variant={guidance === "kept" ? "default" : "outline"}>{guidance}</Badge>;
}

function Detail({ task }: { task: TaskRow }) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 py-2 text-sm">
      <dt className="text-muted-foreground">Sessions</dt>
      <dd className="space-y-0.5 font-mono text-xs">
        {task.members.map((m) => (
          <div key={`${m.harness}:${m.sessionId}:${m.firstTurn}`} title={m.sessionId}>
            {HARNESS_LABELS[m.harness]} {shortId(m.sessionId)} ·{" "}
            {m.firstTurn === m.lastTurn
              ? `turn ${m.firstTurn + 1}`
              : `turns ${m.firstTurn + 1}–${m.lastTurn + 1}`}
          </div>
        ))}
      </dd>
      <dt className="text-muted-foreground">Markers</dt>
      <dd>
        <Ids ids={task.markers} empty={`none · ${task.split} split`} />
      </dd>
      <dt className="text-muted-foreground">Landed</dt>
      <dd>
        <Ids ids={task.landed.evidence} empty="no evidence" />
      </dd>
      <dt className="text-muted-foreground">Spiral</dt>
      <dd>
        <Ids ids={task.spiral.evidence} empty="no evidence" />
      </dd>
      <dt className="text-muted-foreground">Efficiency</dt>
      <dd className="font-mono text-xs">
        {tokens(task.tokens)} tokens · {duration(task.seconds)}
        {task.efficiency.evidence.length
          ? ` · compared with ${task.efficiency.evidence.length} landed tasks`
          : ""}
      </dd>
      <dt className="text-muted-foreground">Guidance</dt>
      <dd className="font-mono text-xs">
        {task.guidance} · {task.guidanceTurns} turns judged · ${task.guidanceCost.toFixed(4)}
      </dd>
    </dl>
  );
}

function Ids({ ids, empty }: { ids: string[]; empty: string }) {
  if (!ids.length) return <span className="font-mono text-xs text-muted-foreground">{empty}</span>;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs">
      {ids.map((id) => {
        const e = evidenceOf(id);
        return e.href ? (
          <a
            key={id}
            href={e.href}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {e.label}
          </a>
        ) : (
          <span key={id} title={id}>
            {e.label}
          </span>
        );
      })}
    </div>
  );
}
