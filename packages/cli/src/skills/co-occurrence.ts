import type { Reply } from "@quench/judge";
import { sessionKey, type SessionContext } from "../commands/context.ts";

export const MIN_SESSIONS = 5;
export const BASIS = "co-occurrence, not cause";

export type CoOccurrence = {
  basis: typeof BASIS;
  sessionsLoaded: number;
  withHumanCorrection: number | null;
  unjudgedSessions: number | null;
};

type Outcome = "human" | "unknown" | "none";

export function coOccurrence(
  replies: readonly Reply[],
  contexts: ReadonlyMap<string, SessionContext>,
  since: Date,
): (skill: string) => CoOccurrence {
  const outcomes = new Map<string, Outcome>();
  for (const reply of replies) {
    if (!reply.run.replyAt || reply.run.replyAt < since) continue;
    const key = sessionKey(reply);
    const outcome: Outcome =
      reply.kind === "correction" && reply.sender === "person"
        ? "human"
        : reply.kind === null || (reply.kind === "correction" && reply.sender === null)
          ? "unknown"
          : "none";
    const known = outcomes.get(key);
    if (known === "human" || (known === "unknown" && outcome === "none")) continue;
    outcomes.set(key, outcome);
  }
  const sessionsBySkill = new Map<string, string[]>();
  for (const [key, context] of contexts)
    for (const skill of context.skills ?? [])
      sessionsBySkill.set(skill, [...(sessionsBySkill.get(skill) ?? []), key]);
  return (skill) => {
    const sessions = sessionsBySkill.get(skill) ?? [];
    const shown = sessions.length >= MIN_SESSIONS;
    const count = (outcome: Outcome) =>
      shown ? sessions.filter((key) => outcomes.get(key) === outcome).length : null;
    return {
      basis: BASIS,
      sessionsLoaded: sessions.length,
      withHumanCorrection: count("human"),
      unjudgedSessions: count("unknown"),
    };
  };
}
