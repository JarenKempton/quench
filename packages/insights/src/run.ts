import {
  contextOf,
  startedAt,
  unhandled,
  type Origin,
  type SenderEvidence,
  type Session,
  type Usage,
} from "@quench/history";

export type Run = {
  prompt: string | null;
  promptOrigin: Origin | null;
  promptSender: SenderEvidence | null;
  reply: string | null;
  replyAt: Date | null;
  replyOrigin: Origin | null;
  replySender: SenderEvidence | null;
  assistantSaid: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  model: string | null;
  effort: string | null;
  inferences: number;
  contextStart: number | null;
  contextPeak: number;
  usage: Usage;
  toolCalls: number;
  toolErrors: number;
  compactions: number;
  subagents: number;
};

const emptyRun = (): Run => ({
  prompt: null,
  promptOrigin: null,
  promptSender: null,
  reply: null,
  replyAt: null,
  replyOrigin: null,
  replySender: null,
  assistantSaid: null,
  startedAt: null,
  endedAt: null,
  model: null,
  effort: null,
  inferences: 0,
  contextStart: null,
  contextPeak: 0,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  toolCalls: 0,
  toolErrors: 0,
  compactions: 0,
  subagents: 0,
});

export const durationSeconds = (r: Run): number | null =>
  r.startedAt && r.endedAt
    ? Math.round((r.endedAt.getTime() - r.startedAt.getTime()) / 1000)
    : null;

export function runs(session: Session, children: readonly Session[] = []): Run[] {
  const segments: Run[] = [emptyRun()];
  let run = segments[0] as Run;
  for (const event of session.events) {
    switch (event.type) {
      case "message":
        if (event.author === "user") {
          run.replyAt = event.at;
          run = {
            ...emptyRun(),
            prompt: event.text,
            promptOrigin: event.origin,
            promptSender: event.sender ?? null,
            startedAt: event.at,
          };
          segments.push(run);
        } else if (event.author === "assistant") {
          run.assistantSaid = event.text;
        }
        break;
      case "inference": {
        const context = contextOf(event.usage);
        run.inferences += 1;
        run.contextStart ??= context;
        run.contextPeak = Math.max(run.contextPeak, context);
        run.usage = {
          input: run.usage.input + event.usage.input,
          cacheRead: run.usage.cacheRead + event.usage.cacheRead,
          cacheWrite: run.usage.cacheWrite + event.usage.cacheWrite,
          output: run.usage.output + event.usage.output,
        };
        run.model = event.model ?? run.model;
        run.effort = event.effort ?? run.effort;
        break;
      }
      case "tool_call":
        run.toolCalls += 1;
        break;
      case "tool_result":
        run.toolErrors += event.isError === true ? 1 : 0;
        break;
      case "compaction":
        run.compactions += 1;
        break;
      case "instructions":
      case "skills":
      case "invocation":
      case "mcp_call":
        continue;
      default:
        unhandled(event);
    }
    run.startedAt ??= event.at;
    run.endedAt = event.at ?? run.endedAt;
  }
  segments.forEach((segment, i) => {
    const next = segments[i + 1];
    segment.reply = next?.prompt ?? null;
    segment.replyOrigin = next?.promptOrigin ?? null;
    segment.replySender = next?.promptSender ?? null;
  });
  return linkSubagents(
    segments.filter((s) => s.inferences > 0),
    children.map(startedAt),
  );
}

export function linkSubagents(list: Run[], childStarts: readonly (Date | null)[]): Run[] {
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
