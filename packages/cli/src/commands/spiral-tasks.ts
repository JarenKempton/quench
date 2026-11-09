import { judgedTasks, segments, segmentSignals } from "@quench/insights";
import type { Reply } from "@quench/judge";
import type { BranchedRuns } from "./session-runs.ts";

const sessionKey = (s: { harness: string; sessionId: string }) => `${s.harness}\0${s.sessionId}`;

const turns = (replies: readonly Reply[], kind: Reply["kind"], shift: number) =>
  new Set(replies.flatMap((r) => (r.kind === kind ? [r.position - shift] : [])));

export function spiralTasks(sessions: readonly BranchedRuns[], replies: readonly Reply[]) {
  const bySession = Map.groupBy(replies, sessionKey);
  const judged = judgedTasks(
    sessions.flatMap((s) => {
      const own = bySession.get(sessionKey({ harness: s.harness, sessionId: s.id })) ?? [];
      const corrected = turns(own, "correction", 1);
      return segments({ ...s, parent: null }, s.runs, turns(own, "new_request", 0)).map(
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
    failed: failed.length,
    task: (reply: Reply) =>
      members
        .get(sessionKey(reply))
        ?.find((m) => m.firstTurn <= reply.position - 1 && reply.position - 1 <= m.lastTurn)
        ?.taskId ?? null,
  };
}
