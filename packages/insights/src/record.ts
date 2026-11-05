import {
  knownTool,
  shellReads,
  type FailureKind,
  type HarnessId,
  type Origin,
  type Session,
  type Usage,
} from "@quench/history";
import {
  commandRecords,
  IDLE_MS,
  linkSubagents,
  splitRuns,
  type CommandRecord,
  type Run,
  type RunCommand,
} from "./run.ts";

export type RunRecord = {
  id: string;
  session: string;
  parentSession: string | null;
  harness: HarnessId;
  path: string;
  cwd: string | null;
  branch: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  open: boolean;
  prompt: string | null;
  promptOrigin: Origin | null;
  steering: string[];
  outcome: string | null;
  model: string | null;
  effort: string | null;
  inferences: number;
  contextStart: number | null;
  contextPeak: number | null;
  usage: Usage;
  toolCalls: number;
  toolErrors: number;
  compactions: number;
  subagents: number;
  commands: CommandRecord[];
  failures: {
    tool: string;
    kind: FailureKind;
    what: string | null;
    error: string | null;
  }[];
  filesRead: string[];
  prLinks: string[];
};

const PR_LINK = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

export function runRecords(
  session: Session,
  childStarts: readonly (Date | null)[],
  now: Date,
): RunRecord[] {
  const all = splitRuns(session, true);
  const last = all.at(-1);
  const list = linkSubagents(
    all.filter((s) => s.inferences > 0),
    childStarts,
  );
  return list.map((run, i) => ({
    id: `${session.id}:${i + 1}`,
    session: session.id,
    parentSession: session.parent,
    harness: session.harness,
    path: session.path,
    cwd: session.cwd,
    branch: session.branch,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    open: run === last && !closedByIdle(run, now),
    prompt: run.prompt,
    promptOrigin: run.promptOrigin,
    steering: run.steering,
    outcome: run.outcome,
    model: run.model,
    effort: run.effort,
    inferences: run.inferences,
    contextStart: run.contextStart,
    contextPeak: run.contextPeak,
    usage: run.usage,
    toolCalls: run.toolCalls,
    toolErrors: run.toolErrors,
    compactions: run.compactions,
    subagents: run.subagents,
    commands: commandRecords(run),
    failures: run.calls.flatMap((c) =>
      c.failure ? [{ tool: knownTool(c.tool), ...c.failure }] : [],
    ),
    filesRead: unique([...run.filesRead, ...shellFilesRead(run.commands, session.cwd)]),
    prLinks: unique(run.commands.flatMap((c) => c.command?.match(PR_LINK) ?? [])),
  }));
}

const closedByIdle = (run: Run, now: Date) =>
  run.endedAt !== null && now.getTime() - run.endedAt.getTime() >= IDLE_MS;

const shellFilesRead = (commands: RunCommand[], sessionFolder: string | null) =>
  commands.flatMap(({ command, workdir }) =>
    command === null
      ? []
      : shellReads(command, { workdir, sessionFolder, home: null })
          .filter((r) => r.kind === "read" || r.kind === "script-read")
          .map((r) => r.path ?? r.written),
  );

const unique = (list: string[]) => [...new Set(list)];
