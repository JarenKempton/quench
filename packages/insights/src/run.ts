import {
  commandShape,
  contextOf,
  knownUsage,
  sumOf,
  failedCall,
  startedAt,
  unhandled,
  type Event,
  type FailureKind,
  type Origin,
  type SenderEvidence,
  type Session,
  type ShellCommand,
  type CommandShape,
  type Usage,
} from "@quench/history";

export type ToolCall = {
  tool: string;
  server: string | null;
  ok: boolean | null;
  resultChars: number | null;
  inScript: boolean;
  loadedTools?: string[];
  failure?: { kind: FailureKind; what: string | null; error: string | null };
};

export type RunCommand = ShellCommand & { call: number };

export type CommandRecord = CommandShape & { error: string | null };

export type FollowUp = Pick<
  Run,
  | "agentLines"
  | "assistantSaid"
  | "reply"
  | "replyAt"
  | "replyLine"
  | "replyOrigin"
  | "replySender"
  | "replyCommand"
>;

export type Run = {
  prompt: string | null;
  promptLine: number | null;
  agentLines: [number, number] | null;
  replyLine: number | null;
  promptOrigin: Origin | null;
  promptSender: SenderEvidence | null;
  promptCommand: boolean;
  reply: string | null;
  replyAt: Date | null;
  replyOrigin: Origin | null;
  replySender: SenderEvidence | null;
  replyCommand: boolean;
  followUps: FollowUp[];
  assistantSaid: string | null;
  outcome: string | null;
  steering: string[];
  commands: RunCommand[];
  filesRead: string[];
  startedAt: Date | null;
  endedAt: Date | null;
  model: string | null;
  effort: string | null;
  inferences: number;
  contextStart: number | null;
  contextPeak: number | null;
  usage: Usage;
  toolCalls: number;
  calls: ToolCall[];
  toolErrors: number;
  compactions: number;
  subagents: number;
};

const emptyRun = (): Run => ({
  prompt: null,
  promptLine: null,
  agentLines: null,
  replyLine: null,
  promptOrigin: null,
  promptSender: null,
  promptCommand: false,
  reply: null,
  replyAt: null,
  replyOrigin: null,
  replySender: null,
  replyCommand: false,
  followUps: [],
  assistantSaid: null,
  outcome: null,
  steering: [],
  commands: [],
  filesRead: [],
  startedAt: null,
  endedAt: null,
  model: null,
  effort: null,
  inferences: 0,
  contextStart: null,
  contextPeak: 0,
  usage: knownUsage(0, 0, 0, 0),
  toolCalls: 0,
  calls: [],
  toolErrors: 0,
  compactions: 0,
  subagents: 0,
});

export const durationSeconds = (r: Run): number | null =>
  r.startedAt && r.endedAt
    ? Math.round((r.endedAt.getTime() - r.startedAt.getTime()) / 1000)
    : null;

export const commandRecords = (run: Run): CommandRecord[] =>
  run.commands.map(({ command, call }) => ({
    ...(command === null ? { program: "other command", subcommand: null } : commandShape(command)),
    error: run.calls[call - 1]!.failure?.error ?? null,
  }));

export const IDLE_MS = 10 * 60 * 1000;

export function runs(
  session: Session,
  children: readonly Session[] = [],
  options: { turns?: boolean } = {},
): Run[] {
  const kept: Run[] = [];
  for (const segment of splitRuns(session, options.turns ?? false)) {
    if (segment.inferences > 0) kept.push(segment);
    else if (segment.reply !== null) {
      const run = kept.at(-1);
      if (run) run.followUps.push(followUpOf(segment, run.followUps.at(-1) ?? run));
    }
  }
  return linkSubagents(kept, children.map(startedAt));
}

const followUpOf = (segment: Run, before: FollowUp): FollowUp => ({
  agentLines:
    before.agentLines && segment.agentLines
      ? [before.agentLines[0], segment.agentLines[1]]
      : (segment.agentLines ?? before.agentLines),
  assistantSaid: segment.assistantSaid ?? before.assistantSaid,
  reply: segment.reply,
  replyAt: segment.replyAt,
  replyLine: segment.replyLine,
  replyOrigin: segment.replyOrigin,
  replySender: segment.replySender,
  replyCommand: segment.replyCommand,
});

export function splitRuns(session: Session, turns: boolean): Run[] {
  const segments: Run[] = [emptyRun()];
  const saidLine = new Map<Run, number | undefined>();
  const inherited = new Set<Run>();
  let run = segments[0] as Run;
  const byId = new Map<string, ToolCall>();
  const recorded = new Map<string, Extract<Event, { type: "tool_call" }>>();
  const mcpById = new Map<string, { server: string; tool: string }>();
  for (const e of session.events)
    if (e.type === "mcp_call" && e.id !== null && !e.inScript && !mcpById.has(e.id))
      mcpById.set(e.id, { server: e.server, tool: e.tool });
  const idle = (at: Date | null) =>
    at !== null && run.endedAt !== null && at.getTime() - run.endedAt.getTime() >= IDLE_MS;
  for (const event of session.events) {
    if (turns && idle(event.at) && !(event.type === "message" && event.author === "user")) {
      run = { ...emptyRun(), startedAt: event.at };
      segments.push(run);
      byId.clear();
      recorded.clear();
    }
    const fromUser =
      (event.type === "message" && event.author === "user") ||
      (event.type === "invocation" && event.by === "user");
    if (event.line !== undefined && !fromUser)
      run.agentLines = [run.agentLines?.[0] ?? event.line, event.line];
    switch (event.type) {
      case "message":
        if (
          event.author === "user" &&
          turns &&
          run.prompt !== null &&
          run.outcome === null &&
          !idle(event.at)
        ) {
          run.steering.push(event.text);
        } else if (event.author === "user") {
          run.replyAt = event.at;
          const before = run;
          run = {
            ...emptyRun(),
            assistantSaid: event.queued ? before.assistantSaid : null,
            prompt: event.text,
            promptLine: event.line ?? null,
            promptOrigin: event.origin,
            promptSender: event.sender ?? null,
            startedAt: event.at,
          };
          segments.push(run);
          if (event.queued && before.assistantSaid !== null) {
            saidLine.set(run, saidLine.get(before));
            inherited.add(run);
          }
          if (turns) {
            byId.clear();
            recorded.clear();
          }
        } else if (event.author === "assistant") {
          run.assistantSaid = event.text;
          saidLine.set(run, event.line);
          inherited.delete(run);
          if (event.text.trim()) run.outcome = event.text;
        }
        break;
      case "inference": {
        const context = contextOf(event.usage);
        if (run.inferences === 0) run.contextStart = context;
        run.inferences += 1;
        run.contextPeak =
          run.contextPeak === null || context === null ? null : Math.max(run.contextPeak, context);
        run.usage = {
          context: sumOf(run.usage.context, event.usage.context),
          input: sumOf(run.usage.input, event.usage.input),
          cacheRead: sumOf(run.usage.cacheRead, event.usage.cacheRead),
          cacheWrite: sumOf(run.usage.cacheWrite, event.usage.cacheWrite),
          output: sumOf(run.usage.output, event.usage.output),
        };
        run.model = event.model ?? run.model;
        run.effort = event.effort ?? run.effort;
        break;
      }
      case "tool_call": {
        const mcp = event.id === null ? undefined : mcpById.get(event.id);
        const call: ToolCall = {
          tool: mcp?.tool ?? event.name,
          server: mcp?.server ?? null,
          ok: null,
          resultChars: null,
          inScript: false,
        };
        run.toolCalls += 1;
        run.calls.push(call);
        run.outcome = null;
        run.commands.push(...(event.shell ?? []).map((c) => ({ ...c, call: run.calls.length })));
        if (event.fileRead) run.filesRead.push(event.fileRead.path);
        if (event.id !== null) {
          byId.set(event.id, call);
          recorded.set(event.id, event);
        }
        break;
      }
      case "mcp_call":
        if (event.inScript)
          run.calls.push({
            tool: event.tool,
            server: event.server,
            ok: null,
            resultChars: null,
            inScript: true,
          });
        continue;
      case "tool_result": {
        run.toolErrors += event.isError === true ? 1 : 0;
        const call = event.callId === null ? undefined : byId.get(event.callId);
        if (call) {
          call.ok = event.isError === null ? null : !event.isError;
          call.resultChars = event.chars;
          if (event.loadedTools) call.loadedTools = event.loadedTools;
          const failed = event.failure && failedCall(event.failure, recorded.get(event.callId!));
          if (failed) call.failure = failed;
        }
        break;
      }
      case "compaction":
        run.compactions += 1;
        break;
      case "invocation":
        run.promptCommand ||= event.by === "user";
        continue;
      case "instructions":
      case "skills":
      case "prompt":
      case "deferred_tools":
      case "mcp_instructions":
        continue;
      default:
        unhandled(event);
    }
    run.startedAt ??= event.at;
    run.endedAt = event.at ?? run.endedAt;
  }
  segments.forEach((segment, i) => {
    const from = inherited.has(segment) ? saidLine.get(segment) : undefined;
    if (from !== undefined) segment.agentLines = [from, segment.agentLines?.[1] ?? from];
    const next = segments[i + 1];
    segment.reply = next?.prompt ?? null;
    segment.replyLine = next?.promptLine ?? null;
    segment.replyOrigin = next?.promptOrigin ?? null;
    segment.replySender = next?.promptSender ?? null;
    segment.replyCommand = next?.promptCommand ?? false;
  });
  return segments;
}

export function linkSubagents<R extends Run>(
  list: R[],
  childStarts: readonly (Date | null)[],
): R[] {
  for (const run of list) run.subagents = childStarts.filter((at) => within(at, run)).length;
  return list;
}

function within(at: Date | null, run: Run): boolean {
  return (
    at !== null &&
    run.startedAt !== null &&
    run.endedAt !== null &&
    run.startedAt <= at &&
    at <= run.endedAt
  );
}
