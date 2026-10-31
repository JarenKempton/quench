import type { HarnessId } from "@quench/history";
import { signals, type Run, type Signal } from "@quench/insights";
import type { VerdictCache } from "./cache.ts";
import { ReplyKind, type Exchange, type Judge, type Sender, type Verdict } from "./verdict.ts";

export type SessionRuns = {
  id: string;
  path: string;
  harness: HarnessId;
  cwd: string | null;
  runs: Run[];
};

export type Reply = {
  sessionId: string;
  path: string;
  harness: HarnessId;
  cwd: string | null;
  position: number;
  run: Run;
  kind: ReplyKind | null;
  sender: Sender | null;
  senderSource: "harness" | "host" | "judge" | "unknown";
};

export type Judged = { replies: Reply[]; newlyJudged: number; pending: number; failures: Error[] };

export async function judgeReplies(
  sessions: readonly SessionRuns[],
  cache: VerdictCache,
  judge: Judge | null,
): Promise<Judged> {
  const asked = sessions.flatMap((session) =>
    session.runs.flatMap((run, i) =>
      run.reply === null
        ? []
        : [
            {
              session,
              position: i + 1,
              run,
              exchange: exchangeOf(run, run.reply),
              preset: presetKind(run, run.reply),
            },
          ],
    ),
  );
  const unknown = asked.flatMap((a) => (a.preset || cache.get(a.exchange) ? [] : [a.exchange]));
  const judgments = judge ? await judge.classify(unknown) : [];
  const fresh = unknown.flatMap((exchange, i) => {
    const judgment = judgments[i];
    return judgment && !(judgment instanceof Error) ? [[exchange, judgment] as const] : [];
  });
  await cache.remember(fresh);
  return {
    newlyJudged: fresh.length,
    pending: judge ? 0 : unknown.length,
    failures: judgments.filter((j) => j instanceof Error),
    replies: asked.map(({ session, position, run, exchange, preset }) => {
      const verdict = cache.get(exchange);
      return {
        sessionId: session.id,
        path: session.path,
        harness: session.harness,
        cwd: session.cwd,
        position,
        run,
        kind: preset ?? verdict?.kind ?? null,
        ...senderOf(run, verdict),
      };
    }),
  };
}

const exchangeOf = (run: Run, reply: string): Exchange => ({
  assistantSaid: run.assistantSaid ?? "",
  reply,
});

const t3Notices = [
  /^Update on pull request #\d+ \(https:\/\/github\.com\/[^\s()]+\/pull\/\d+\), which T3 Code is watching for you:\n/,
  /^Note: the T3 server restarted, and this background work was cancelled before it finished\. It will not report back(?: on its own, so resume or restart what you still need and wait for its result)?:(?:\n- [^\n]+)+(?:\n\nContinue where you left off\.)?$/,
  /^Delegated task node:delegated-task:\S+(?: \(.*\))? \[(?:completed|failed|interrupted|cancelled)\]:\n/,
  /^Delegated task (node:delegated-task:\S+) reached a terminal state\. Use task_status with taskId \1 to read the result\.$/,
];

const isT3Notice = (reply: string) => t3Notices.some((notice) => notice.test(reply));

const isSlashCommand = (reply: string) => /^\/[a-z][\w:.-]*(?: [^\n]*)?$/.test(reply.trim());

const fromAutomation = (run: Run) =>
  run.replyOrigin === "scheduled" || run.replySender?.sender === "automation";

function presetKind(run: Run, reply: string): ReplyKind | null {
  if (isT3Notice(reply)) return "info";
  if (isSlashCommand(reply) && !fromAutomation(run)) return "new_request";
  return null;
}

function senderOf(run: Run, verdict: Verdict | undefined): Pick<Reply, "sender" | "senderSource"> {
  if (run.replyOrigin === "typed") return { sender: "person", senderSource: "harness" };
  if (run.replyOrigin === "scheduled") return { sender: "automation", senderSource: "harness" };
  if (run.replySender) return { sender: run.replySender.sender, senderSource: "host" };
  const reply = run.reply ?? "";
  if (isT3Notice(reply)) return { sender: "automation", senderSource: "host" };
  if (isSlashCommand(reply)) return { sender: "person", senderSource: "harness" };
  return verdict
    ? { sender: verdict.sender, senderSource: "judge" }
    : { sender: null, senderSource: "unknown" };
}

export type Tally = { replies: number; judged: number; kinds: Record<ReplyKind, number> };

export type Summary = {
  fromPeople: Tally;
  fromAutomation: Tally;
  fromUnknown: Tally;
  signals: Signal[];
  automationSignals: Signal[];
  latest: Reply[];
  latestAutomation: Reply[];
  senderSources: Record<Reply["senderSource"], number>;
};

export function summarize(replies: readonly Reply[], examples: number): Summary {
  const senderSources = { harness: 0, host: 0, judge: 0, unknown: 0 };
  for (const reply of replies) senderSources[reply.senderSource] += 1;
  const people = senderSummary(
    replies.filter((r) => r.sender === "person"),
    examples,
  );
  const automated = senderSummary(
    replies.filter((r) => r.sender === "automation"),
    examples,
  );
  return {
    fromPeople: people.tally,
    fromAutomation: automated.tally,
    fromUnknown: tally(replies.filter((r) => r.sender === null)),
    signals: people.signals,
    automationSignals: automated.signals,
    latest: people.latest,
    latestAutomation: automated.latest,
    senderSources,
  };
}

function senderSummary(replies: readonly Reply[], examples: number) {
  const samples = replies.flatMap((r) =>
    r.kind === null
      ? []
      : [
          {
            harness: r.harness,
            position: r.position,
            run: r.run,
            corrected: r.kind === "correction",
          },
        ],
  );
  const latest = replies
    .filter((r) => r.kind === "correction")
    .sort((a, b) => (b.run.replyAt?.getTime() ?? 0) - (a.run.replyAt?.getTime() ?? 0))
    .slice(0, examples);
  return {
    tally: tally(replies),
    signals: signals(samples),
    latest,
  };
}

function tally(replies: readonly Reply[]): Tally {
  const kinds = Object.fromEntries(ReplyKind.options.map((k) => [k, 0])) as Record<
    ReplyKind,
    number
  >;
  let judged = 0;
  for (const r of replies) {
    if (r.kind === null) continue;
    kinds[r.kind] += 1;
    judged += 1;
  }
  return { replies: replies.length, judged, kinds };
}
