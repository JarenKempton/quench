import { expect, test } from "bun:test";
import type { MachineState, SkillRecord, VersionCounts } from "@quench/fleet";
import { versionCards } from "../src/cards.ts";

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const counts = (sessions: number, withHumanCorrection = 0): VersionCounts => ({
  sessions,
  judged: sessions,
  withHumanCorrection,
  unjudged: 0,
  noFollowUp: 0,
});

const state = (loaded: number, without: number): MachineState => {
  const record: SkillRecord = {
    id: hash("c"),
    skill: "tidy",
    harness: "claude-code",
    location: "~/.claude/skills/tidy",
    origin: "user",
    contentVersion: hash("b"),
    listedBy: ["claude-code"],
    listingChars: null,
    recordedListingChars: null,
    bodyBytes: null,
    use: { sessionsListed: null, used: null, usedByUser: null, lowerBound: false },
    coOccurrence: {
      basis: "co-occurrence, not cause",
      sessionsLoaded: null,
      withHumanCorrection: null,
      unjudgedSessions: null,
      noFollowUp: null,
    },
    versions: [
      {
        treeHash: hash("a"),
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-10T00:00:00.000Z",
        loaded: counts(loaded),
        without: counts(without, 1),
      },
      {
        treeHash: hash("b"),
        from: "2026-10-10T00:00:00.000Z",
        to: null,
        loaded: counts(loaded),
        without: counts(without, 1),
      },
    ],
  };
  return {
    generation: 1,
    harnesses: {},
    skills: {
      schemaVersion: 1,
      days: 30,
      judge: null,
      records: [record],
      unrecognised: { recognised: false, count: 0, sessionsListed: 0, used: 0, usedByUser: 0 },
    },
  };
};

test("a card's baseline covers exactly the machines and harnesses it shows", () => {
  const [card] = versionCards([
    { name: "laptop", state: state(10, 2) },
    { name: "desktop", state: state(0, 12) },
  ]);
  expect(card!.places).toEqual([{ machine: "laptop", harness: "claude-code" }]);
  expect(card!.sides.before.without).toEqual(counts(2, 1));
  expect(card!.sides.after.without).toEqual(counts(2, 1));
  expect(card!.sides.before.loaded.sessions).toBe(10);
  expect(card!.shown).toBe(true);
});
