import { expect, test } from "bun:test";
import { fixPrompt, flagsOf, type SkillRecord, type SkillsReport } from "../src/skills.ts";

const record = (over: Partial<SkillRecord> & { id: string }): SkillRecord => ({
  skill: "deploy",
  harness: "claude-code",
  location: "~/.claude/skills/deploy",
  origin: "user",
  contentVersion: "sha256:a",
  listingChars: 120,
  recordedListingChars: null,
  bodyBytes: 900,
  use: { sessionsListed: 2, used: 1, usedByUser: 0, lowerBound: false },
  coOccurrence: {
    sessionsLoaded: null,
    withHumanCorrection: null,
    unjudgedSessions: null,
    noFollowUp: null,
  },
  ...over,
});

const report = (skills: SkillRecord[]): SkillsReport => ({
  schemaVersion: 1,
  days: 30,
  judge: "jev",
  origins: ["user"],
  skills,
});

test("each flag fires on its evidence and gives a one-line reason", () => {
  const flagged = record({
    id: "a",
    recordedListingChars: 1500,
    use: { sessionsListed: 12, used: 0, usedByUser: 0, lowerBound: false },
    coOccurrence: { sessionsLoaded: 8, withHumanCorrection: 4, unjudgedSessions: 1, noFollowUp: 1 },
  });
  const copy = record({
    id: "b",
    harness: "codex",
    location: "~/.codex/skills/deploy",
    contentVersion: "sha256:b",
  });
  const flags = flagsOf(flagged, report([flagged, copy]));
  expect(flags.map((f) => f.kind)).toEqual(["unused", "corrections", "drift", "large"]);
  expect(flags.map((f) => f.reason)).toEqual([
    "Listed in 12 sessions in the last 30 days and never used.",
    "A person corrected the agent in 4 of 6 judged sessions that loaded it (co-occurrence, not cause).",
    "Its folder differs from the copy for Codex at ~/.codex/skills/deploy.",
    "Its listing is 1,500 characters, sent in every session that lists it.",
  ]);
  expect(fixPrompt(flagged, flags)).toStartWith(
    'Review the "deploy" skill for Claude Code, at ~/.claude/skills/deploy/SKILL.md.',
  );
});

test("unknown evidence never flags", () => {
  const quiet = record({
    id: "a",
    listingChars: null,
    use: { sessionsListed: null, used: null, usedByUser: null, lowerBound: false },
    contentVersion: null,
  });
  const flags = flagsOf(quiet, report([quiet, record({ id: "b", contentVersion: "sha256:b" })]));
  expect(flags).toEqual([]);
  expect(fixPrompt(quiet, flags)).toBeNull();
});
