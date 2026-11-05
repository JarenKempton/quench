import type { Reply } from "@quench/judge";
import { sessionKey, type SessionContext } from "../commands/context.ts";

export const MIN_SESSIONS = 5;
export const BASIS = "co-occurrence, not cause";

export type CoOccurrence = {
  basis: typeof BASIS;
  sessionsLoaded: number;
  withHumanCorrection: number | null;
  unjudgedSessions: number;
};

type Outcome = "human" | "unknown" | "none";

const RANK: Record<Outcome, number> = { none: 0, unknown: 1, human: 2 };

export function coOccurrence(
  replies: readonly Reply[],
  contexts: ReadonlyMap<string, SessionContext>,
  since: Date,
): (skill: string, sessions: readonly string[]) => CoOccurrence {
  const outcomes = new Map<string, Outcome>();
  for (const reply of replies) {
    if (reply.run.replyAt && reply.run.replyAt < since) continue;
    const outcome: Outcome = !reply.run.replyAt
      ? "unknown"
      : reply.kind === "correction" && reply.sender === "person"
        ? "human"
        : reply.kind === null || (reply.kind === "correction" && reply.sender === null)
          ? "unknown"
          : "none";
    const key = sessionKey(reply);
    if (RANK[outcome] > RANK[outcomes.get(key) ?? "none"]) outcomes.set(key, outcome);
  }
  return (skill, sessions) => {
    const loaded = [...new Set(sessions)].filter((key) =>
      contexts.get(key)?.skills?.includes(skill),
    );
    const of = (outcome: Outcome) =>
      loaded.filter((key) => (outcomes.get(key) ?? "none") === outcome).length;
    const unjudged = of("unknown");
    return {
      basis: BASIS,
      sessionsLoaded: loaded.length,
      withHumanCorrection: loaded.length - unjudged >= MIN_SESSIONS ? of("human") : null,
      unjudgedSessions: unjudged,
    };
  };
}
