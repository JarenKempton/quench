import type { Reply } from "@quench/judge";
import { sessionKey, type SessionContext } from "../commands/context.ts";

export const MIN_SESSIONS = 5;
export const BASIS = "co-occurrence, not cause";

export type CoOccurrence = {
  basis: typeof BASIS;
  sessionsLoaded: number;
  withHumanCorrection: number | null;
  unjudgedSessions: number;
  noFollowUp: number;
};

type Outcome = "human" | "unknown" | "judged" | "silent";

const RANK: Record<Outcome, number> = { silent: 0, judged: 1, unknown: 2, human: 3 };

function outcomeOf(reply: Reply): Outcome {
  if (reply.sender === "automation") return "silent";
  if (reply.kind === null || !reply.run.replyAt) return "unknown";
  if (reply.kind === "correction") return reply.sender === "person" ? "human" : "unknown";
  return reply.sender === "person" ? "judged" : "silent";
}

export function coOccurrence(
  replies: readonly Reply[],
  contexts: ReadonlyMap<string, SessionContext>,
  since: Date,
): (skill: string, sessions: readonly string[]) => CoOccurrence {
  const outcomes = new Map<string, Outcome>();
  for (const reply of replies) {
    if (reply.run.replyAt && reply.run.replyAt < since) continue;
    const outcome = outcomeOf(reply);
    const key = sessionKey(reply);
    if (RANK[outcome] > RANK[outcomes.get(key) ?? "silent"]) outcomes.set(key, outcome);
  }
  return (skill, sessions) => {
    const loaded = [...new Set(sessions)].filter((key) =>
      contexts.get(key)?.skills?.includes(skill),
    );
    const of = (outcome: Outcome) =>
      loaded.filter((key) => (outcomes.get(key) ?? "silent") === outcome).length;
    const human = of("human");
    return {
      basis: BASIS,
      sessionsLoaded: loaded.length,
      withHumanCorrection: human + of("judged") >= MIN_SESSIONS ? human : null,
      unjudgedSessions: of("unknown"),
      noFollowUp: of("silent"),
    };
  };
}
