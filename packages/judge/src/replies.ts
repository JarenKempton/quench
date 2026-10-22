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
        : [{ session, position: i + 1, run, exchange: exchangeOf(run, run.reply) }],
    ),
  );
  const unknown = asked.map((a) => a.exchange).filter((e) => !cache.get(e));
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
    replies: asked.map(({ session, position, run, exchange }) => {
      const verdict = cache.get(exchange);
      return {
        sessionId: session.id,
        path: session.path,
        harness: session.harness,
        cwd: session.cwd,
        position,
        run,
        kind: verdict?.kind ?? null,
        ...senderOf(run, verdict),
      };
    }),
  };
}

const exchangeOf = (run: Run, reply: string): Exchange => ({
  assistantSaid: run.assistantSaid ?? "",
  reply,
});

function senderOf(run: Run, verdict: Verdict | undefined): Pick<Reply, "sender" | "senderSource"> {
  if (run.replyOrigin === "typed") return { sender: "person", senderSource: "harness" };
  if (run.replyOrigin === "scheduled") return { sender: "automation", senderSource: "harness" };
  if (run.replySender) return { sender: run.replySender.sender, senderSource: "host" };
  return verdict
    ? { sender: verdict.sender, senderSource: "judge" }
    : { sender: null, senderSource: "unknown" };
}

export type Tally = { replies: number; judged: number; kinds: Record<ReplyKind, number> };

export type Summary = {
  fromPeople: Tally;
  fromAutomation: Tally;
  signals: Signal[];
  latest: Reply[];
  senderSources: Record<Reply["senderSource"], number>;
};

export function summarize(replies: readonly Reply[], examples: number): Summary {
  const senderSources = { harness: 0, host: 0, judge: 0, unknown: 0 };
  for (const reply of replies) senderSources[reply.senderSource] += 1;
  const people = replies.filter((r) => r.sender !== "automation");
  const automated = replies.filter((r) => r.sender === "automation");
  const samples = people.flatMap((r) =>
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
  const latest = people
    .filter((r) => r.kind === "correction")
    .sort((a, b) => (b.run.endedAt?.getTime() ?? 0) - (a.run.endedAt?.getTime() ?? 0))
    .slice(0, examples);
  return {
    fromPeople: tally(people),
    fromAutomation: tally(automated),
    signals: signals(samples),
    latest,
    senderSources,
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
