import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@quench/history";
import { runs } from "@quench/insights";
import {
  guidanceInputs,
  JevGuidance,
  judgeGuidance,
  KeyRejected,
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

const session = runs({
  id: "s",
  harness: "claude-code",
  path: "/unused",
  cwd: null,
  branch: "t3/lane",
  parent: null,
  diagnostics: { lines: 0, unparsed: 0 },
  events: [
    ...user("Use bun, never npm", 0),
    said("Set up.", 1),
    ...user("No, run the tests with bun test", 5),
    said("Running.", 6),
    { type: "compaction", trigger: "auto", tokensBefore: null, at: at(7) },
    ...user("continue", 8),
    said("Ran npm test.", 9),
    ...user("now the docs", 200),
    said("Docs updated.", 201),
  ],
});

const reply = (position: number, kind: Reply["kind"]): Reply => ({
  sessionId: "s",
  path: "/unused",
  harness: "claude-code",
  cwd: null,
  position,
  run: session[position - 1]!,
  kind,
  sender: "person",
  senderSource: "harness",
  classified: "cached",
});

const replies = [reply(1, "correction"), reply(2, "approval"), reply(3, "new_request")];
const cachePath = async () =>
  join(await mkdtemp(join(tmpdir(), "quench-guidance-")), "guidance.jsonl");
const open = (path: string) => ThemeCache.open<GuidanceInput>(path, JevGuidance.id);

test("only turns after a compaction or an idle gap are asked, against earlier rules and corrections", () => {
  const inputs = guidanceInputs(session, replies, 0, 3);
  expect(inputs.map((i) => [i.turn, i.input.state.after])).toEqual([
    [2, "compaction"],
    [3, "idle-gap"],
  ]);
  for (const { input } of inputs) {
    expect(input.state.rules).toEqual([
      { id: "turn_0", kind: "rule", text: "Use bun, never npm" },
      { id: "turn_1", kind: "correction", text: "No, run the tests with bun test" },
    ]);
    expect(Object.keys(input.choices)).toEqual(["kept", "unknown", "turn_0", "turn_1"]);
  }
  expect(inputs[0]!.input.state.turn).toEqual({
    prompt: "continue",
    assistant_said: "Ran npm test.",
    commands: [],
  });
  expect(guidanceInputs(session, replies, 0, 1)).toEqual([]);
});

test("a broken rule wins with its id, costs are summed, and a cached verdict is not asked again", async () => {
  const path = await cachePath();
  const asked: GuidanceInput[] = [];
  const judge = {
    id: JevGuidance.id,
    guidance: async (input: GuidanceInput) => {
      asked.push(input);
      return {
        choice: input.state.after === "compaction" ? "turn_0" : "kept",
        model: "jev-test",
        tokens: 1000,
      };
    },
  };
  const inputs = guidanceInputs(session, replies, 0, 3);
  expect(await judgeGuidance("s", inputs, await open(path), judge)).toEqual({
    guidance: "broken",
    rule: "s#0",
    turns: 2,
    tokens: 2000,
  });
  expect(await judgeGuidance("s", inputs, await open(path), null)).toEqual({
    guidance: "broken",
    rule: "s#0",
    turns: 2,
    tokens: 2000,
  });
  expect(asked).toHaveLength(2);
});

test("no break is skipped, no key is pending, a failure stays pending and a rejected key stops", async () => {
  const cache = await open(await cachePath());
  const inputs = guidanceInputs(session, replies, 0, 3);
  expect(await judgeGuidance("s", [], cache, null)).toMatchObject({ guidance: "skipped" });
  expect(await judgeGuidance("s", inputs, cache, null)).toMatchObject({
    guidance: "pending",
    turns: 2,
  });
  const failing = {
    id: JevGuidance.id,
    guidance: async () => {
      throw new Error("timeout");
    },
  };
  expect(await judgeGuidance("s", inputs, cache, failing)).toMatchObject({ guidance: "pending" });
  const rejected = {
    id: JevGuidance.id,
    guidance: async () => {
      throw new KeyRejected(401);
    },
  };
  expect(judgeGuidance("s", inputs, cache, rejected)).rejects.toBeInstanceOf(KeyRejected);
});
