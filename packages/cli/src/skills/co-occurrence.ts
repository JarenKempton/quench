import { BASIS, type VersionCounts } from "@quench/fleet";
import { skillFolder } from "@quench/history";
import type { Reply } from "@quench/judge";
import { sessionKey, type SessionContext } from "../commands/context.ts";

export { BASIS };
export const MIN_SESSIONS = 5;

export type CoOccurrence = {
  basis: typeof BASIS;
  sessionsLoaded: number | null;
  withHumanCorrection: number | null;
  unjudgedSessions: number | null;
  noFollowUp: number | null;
};

type Outcome = "human" | "unknown" | "judged" | "silent";

const slashed = (path: string) => path.replaceAll("\\", "/");

const RANK: Record<Outcome, number> = { silent: 0, judged: 1, unknown: 2, human: 3 };

function outcomeOf(reply: Reply): Outcome {
  if (reply.sender === "automation") return "silent";
  if (reply.kind === null || !reply.run.replyAt) return "unknown";
  if (reply.kind === "correction") return reply.sender === "person" ? "human" : "unknown";
  return reply.sender === "person" ? "judged" : "silent";
}

export function sessionOutcomes(replies: readonly Reply[], since: Date) {
  const outcomes = new Map<string, Outcome>();
  for (const reply of replies) {
    if (reply.run.replyAt && reply.run.replyAt < since) continue;
    const outcome = outcomeOf(reply);
    const key = sessionKey(reply);
    if (RANK[outcome] > RANK[outcomes.get(key) ?? "silent"]) outcomes.set(key, outcome);
  }
  return (key: string): Outcome => outcomes.get(key) ?? "silent";
}

export function tally(keys: readonly string[], outcome: (key: string) => Outcome): VersionCounts {
  const of = (o: Outcome) => keys.filter((key) => outcome(key) === o).length;
  const human = of("human");
  return {
    sessions: keys.length,
    judged: human + of("judged"),
    withHumanCorrection: human,
    unjudged: of("unknown"),
    noFollowUp: of("silent"),
  };
}

export const loadedFrom =
  (contexts: ReadonlyMap<string, SessionContext>, skill: string, folders: readonly string[]) =>
  (key: string) => {
    const here = new Set(folders.map(slashed));
    return (
      contexts
        .get(key)
        ?.loads?.some(
          (l) => l.name === skill && (l.path === null || here.has(slashed(skillFolder(l.path)))),
        ) ?? false
    );
  };

export const loadedAnywhere =
  (contexts: ReadonlyMap<string, SessionContext>, skill: string) => (key: string) =>
    contexts.get(key)?.loads?.some((l) => l.name === skill) ?? false;

export function coOccurrence(
  replies: readonly Reply[],
  contexts: ReadonlyMap<string, SessionContext>,
  since: Date,
): (skill: string, sessions: readonly string[], folders: readonly string[]) => CoOccurrence {
  const outcome = sessionOutcomes(replies, since);
  return (skill, sessions, folders) => {
    const recorded = [...new Set(sessions)].filter((key) => contexts.get(key)?.skills);
    if (!recorded.length)
      return {
        basis: BASIS,
        sessionsLoaded: null,
        withHumanCorrection: null,
        unjudgedSessions: null,
        noFollowUp: null,
      };
    const counts = tally(recorded.filter(loadedFrom(contexts, skill, folders)), outcome);
    return {
      basis: BASIS,
      sessionsLoaded: counts.sessions,
      withHumanCorrection: counts.judged >= MIN_SESSIONS ? counts.withHumanCorrection : null,
      unjudgedSessions: counts.unjudged,
      noFollowUp: counts.noFollowUp,
    };
  };
}
