import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@quench/history";
import { runs } from "@quench/insights";
import {
  cueSentences,
  guidanceBreaks,
  JevGuidance,
  judgeGuidance,
  KeyRejected,
  loadedStandards,
  ThemeCache,
  type GuidanceInput,
  type Reply,
} from "../src/index.ts";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 10, minutes));
const user = (text: string, minute: number): Event[] => [
  { type: "message", author: "user", origin: "typed", text, at: at(minute) },
  {
    type: "inference",
    model: "model-a",
    effort: null,
    usage: { context: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    at: at(minute),
  },
];
const said = (text: string, minute: number): Event => ({
  type: "message",
  author: "assistant",
  origin: "unknown",
  text,
  at: at(minute),
});
const session = (events: Event[]) => ({
  id: "s",
  harness: "claude-code" as const,
  path: "/unused",
  cwd: null,
  branch: "t3/lane",
  parent: null,
  diagnostics: { lines: 0, unparsed: 0 },
  events,
});

const history = runs(
  session([
    ...user("Fix the build. Never use npm here. Stay idle until I say go.", 0),
    said("Set up.", 1),
    ...user("No, run the tests with bun test", 5),
    said("Running.", 6),
    { type: "compaction", trigger: "auto", tokensBefore: null, at: at(7) },
    ...user("continue", 8),
    said("Ran npm test.", 9),
    ...user("now the docs", 200),
    said("Docs updated.", 201),
  ]),
);

const reply = (position: number, kind: Reply["kind"]): Reply => ({
  sessionId: "s",
  path: "/unused",
  harness: "claude-code",
  cwd: null,
  position,
  run: history[position - 1]!,
  kind,
  sender: "person",
  senderSource: "harness",
  classified: "cached",
});

const replies = [reply(1, "correction"), reply(2, "approval"), reply(3, "new_request")];
const cachePath = async () =>
  join(await mkdtemp(join(tmpdir(), "quench-guidance-")), "guidance.jsonl");
const open = (path: string) => ThemeCache.open<GuidanceInput>(path, JevGuidance.id);

test("always/never and from-now-on sentences are rules, must/don't need a judge, status lines are not", () => {
  expect(
    cueSentences(
      "Stay idle until #12 merges. Never push to main. From now on, run bun test first. Don't merge yet. Never mind.",
    ),
  ).toEqual([
    { text: "Never push to main.", ambiguous: false },
    { text: "From now on, run bun test first.", ambiguous: false },
    { text: "Don't merge yet.", ambiguous: true },
  ]);
});

test("only turns after a compaction or an idle gap are judged, against corrections and standing rules", () => {
  const breaks = guidanceBreaks("s", history, replies, 0, 3, []);
  expect(breaks.map((b) => [b.turn, b.after])).toEqual([
    [2, "compaction"],
    [3, "idle-gap"],
  ]);
  expect(breaks[0]!.rules.map((r) => [r.evidence, r.kind, r.text])).toEqual([
    ["s#0", "standing", "Never use npm here."],
    ["s#1", "correction", "No, run the tests with bun test"],
  ]);
  expect(breaks[0]!.evidence).toEqual({
    prompt: "continue",
    assistant_said: "Ran npm test.",
    commands: [],
  });
  expect(guidanceBreaks("s", history, replies, 0, 1, [])).toEqual([]);
  const ruleless = runs(
    session([
      ...user("start", 0),
      said("a", 1),
      { type: "compaction", trigger: "auto", tokensBefore: null, at: at(2) },
      ...user("go on", 3),
      said("b", 4),
      { type: "compaction", trigger: "auto", tokensBefore: null, at: at(5) },
      ...user("again", 6),
      said("c", 7),
      { type: "compaction", trigger: "auto", tokensBefore: null, at: at(8) },
      ...user("more", 9),
      said("d", 10),
      ...user("Never push to main.", 11),
      said("e", 12),
      { type: "compaction", trigger: "auto", tokensBefore: null, at: at(13) },
      ...user("last", 14),
      said("f", 15),
    ]),
  );
  expect(guidanceBreaks("s", ruleless, [], 0, 5, []).map((b) => b.turn)).toEqual([5]);
});

function scripted(answers: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    judge: {
      id: JevGuidance.id,
      guidance: async (input: GuidanceInput) => {
        const kind = Object.keys(input.choices).find((k) => k in answers)!;
        asked.push(kind);
        return { choice: answers[kind]!, model: "jev-test", tokens: 100 };
      },
    },
  };
}

test("a break the judge confirms is unknown with its rule id kept apart as unreliable; reruns come from the cache", async () => {
  const path = await cachePath();
  const breaks = guidanceBreaks("s", history, replies, 0, 2, []);
  const { judge, asked } = scripted({ kept: "r0", broke: "broke", lifted: "in_force" });
  const first = await judgeGuidance(breaks, await open(path), judge);
  expect(first).toEqual({ guidance: "unknown", unreliableRule: "s#0", turns: 1, tokens: 300 });
  expect(asked).toEqual(["kept", "broke", "lifted"]);
  expect(await judgeGuidance(breaks, await open(path), null)).toEqual(first);
});

test("a lifted or followed rule is dropped and the turn judged again", async () => {
  const breaks = guidanceBreaks("s", history, replies, 0, 2, []);
  const lifted = scripted({ kept: "r0", broke: "broke", lifted: "lifted" });
  const kept = await judgeGuidance(breaks, await open(await cachePath()), lifted.judge);
  expect(kept.guidance).toBe("kept");
  expect(lifted.asked).toEqual(["kept", "broke", "lifted", "kept", "broke", "lifted"]);
  const followed = scripted({ kept: "r0", broke: "followed" });
  expect(await judgeGuidance(breaks, await open(await cachePath()), followed.judge)).toMatchObject({
    guidance: "kept",
  });
});

test("no break or no rule is skipped, no key is pending, and a rejected key stops", async () => {
  const cache = await open(await cachePath());
  const breaks = guidanceBreaks("s", history, replies, 0, 3, []);
  expect(await judgeGuidance([], cache, null)).toMatchObject({ guidance: "skipped" });
  expect(await judgeGuidance([{ ...breaks[0]!, rules: [] }], cache, null)).toMatchObject({
    guidance: "skipped",
  });
  expect(await judgeGuidance(breaks, cache, null)).toMatchObject({ guidance: "pending", turns: 2 });
  const rejected = {
    id: JevGuidance.id,
    guidance: async () => {
      throw new KeyRejected(401);
    },
  };
  expect(judgeGuidance(breaks, cache, rejected)).rejects.toBeInstanceOf(KeyRejected);
});

test("a loaded instruction file counts only when it still matches what the session loaded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-standards-"));
  const path = join(dir, "CLAUDE.md");
  const text = "# Rules\n\n- Never push to main.\n- Keep files small.\n";
  await writeFile(path, text);
  const loaded = (textSha256: string) =>
    session([
      {
        type: "instructions",
        files: [
          {
            path,
            directory: null,
            label: null,
            textSha256,
            textChars: text.length,
            textDiffersFromFile: null,
          },
        ],
        unreadable: 0,
        at: at(0),
      },
    ]);
  const digest = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  expect(await loadedStandards(loaded(digest), [], [])).toEqual([
    {
      evidence: "CLAUDE.md:3",
      from: -1,
      kind: "standard",
      text: "Never push to main.",
      ambiguous: false,
    },
  ]);
  expect(await loadedStandards(loaded("0".repeat(64)), [], [])).toEqual([]);
});
