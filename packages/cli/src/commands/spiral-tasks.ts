import { judgedTasks, segments, segmentSignals } from "@quench/insights";
import type { Reply } from "@quench/judge";
import { repoOf } from "./github-pulls.ts";
import type { BranchedRuns } from "./session-runs.ts";

const sessionKey = (s: { harness: string; sessionId: string }) => `${s.harness}\0${s.sessionId}`;

const turns = (replies: readonly Reply[], kind: Reply["kind"], shift: number) =>
  new Set(replies.flatMap((r) => (r.kind === kind ? [r.position - shift] : [])));

export async function spiralTasks(sessions: readonly BranchedRuns[], replies: readonly Reply[]) {
  const bySession = Map.groupBy(replies, sessionKey);
  const repos = new Map<string | null, Promise<string | null>>();
  const repoFor = (cwd: string | null) => repos.get(cwd) ?? repos.set(cwd, repoOf(cwd)).get(cwd)!;
  const known = await Promise.all(sessions.map((s) => repoFor(s.cwd)));
  const judged = judgedTasks(
    sessions.flatMap((s, i) => {
      const own = bySession.get(sessionKey({ harness: s.harness, sessionId: s.id })) ?? [];
      const corrected = turns(own, "correction", 1);
      return segments({ ...s, parent: null }, s.runs, turns(own, "new_request", 0), known[i]).map(
        (segment) => ({ ...segment, signals: segmentSignals(s.runs, segment, corrected) }),
      );
    }),
  );
  const failed = judged.filter((t) => t.spiral.verdict === "fail");
  const members = Map.groupBy(
    failed.flatMap((t) => t.members.map((m) => ({ ...m, taskId: t.taskId }))),
    sessionKey,
  );
  return {
    failed: failed.map((t) => ({ taskId: t.taskId, reason: t.spiral.reason })),
    task: (reply: Reply) =>
      members
        .get(sessionKey(reply))
        ?.find((m) => m.firstTurn <= reply.position - 1 && reply.position - 1 <= m.lastTurn)
        ?.taskId ?? null,
  };
}
