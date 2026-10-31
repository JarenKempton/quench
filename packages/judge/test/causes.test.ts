import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@quench/history";
import { runs } from "@quench/insights";
import {
  JevCauses,
  judgeCauses,
  KeyRejected,
  ThemeCache,
  type CauseInput,
  type Reply,
} from "../src/index.ts";

const path = async () => join(await mkdtemp(join(tmpdir(), "quench-causes-")), "causes.jsonl");
const open = async (file: string) => ThemeCache.open<CauseInput>(file, JevCauses.id);

const failing = (id: string): Event[] => [
  { type: "tool_call", id, name: "Read", at: null },
  {
    type: "tool_result",
    callId: id,
    isError: true,
    chars: 5,
    at: null,
    failure: { kind: "missing-path", detail: "a.ts", exitCode: null },
  },
];

const reply = (text: string, extra: Partial<Reply> = {}, body: Event[] = []): Reply => ({
  sessionId: "s",
  path: "/history/s.jsonl",
  harness: "codex",
  cwd: "/private/repo",
  position: 1,
  kind: "correction",
  sender: "person",
  senderSource: "harness",
  run: runs({
    id: "s",
    harness: "codex",
    path: "/unused",
    cwd: null,
    parent: null,
    diagnostics: { lines: 0, unparsed: 0 },
    events: [
      { type: "message", author: "user", origin: "typed", text: "work", at: null },
      {
        type: "inference",
        model: "model-a",
        effort: "high",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        at: null,
      },
      ...body,
      { type: "message", author: "assistant", origin: "unknown", text: "x".repeat(600), at: null },
      { type: "message", author: "user", origin: "typed", text, at: null },
    ],
  })[0]!,
  ...extra,
});

function fake(answer: (input: CauseInput) => string) {
  const inputs: CauseInput[] = [];
  return {
    id: JevCauses.id,
    inputs,
    cause: async (input: CauseInput) => {
      inputs.push(input);
      return { choice: answer(input), model: "jev-test" };
    },
  };
}

test("only corrections are asked, once per exchange, with nothing but the clipped text", async () => {
  const judge = fake(() => "wrong_assumption");
  const replies = [
    reply("no, that file is generated"),
    reply("no, that file is generated", { sender: "automation" }),
    reply("thanks", { kind: "approval" }),
    reply("now add tests", { kind: "new_request" }),
    reply("unclassified", { kind: null }),
  ];
  const causes = await judgeCauses(replies, await open(await path()), judge);
  expect(judge.inputs).toHaveLength(1);
  expect(judge.inputs[0]!.state).toEqual({
    correction: { assistantSaid: "x".repeat(500), reply: "no, that file is generated" },
  });
  expect(JSON.stringify(judge.inputs)).not.toContain("/private/repo");
  expect([causes.corrections, causes.uniqueInputs, causes.newlyJudged]).toEqual([2, 1, 1]);
  expect([
    causes.fromPeople.causes.wrong_assumption,
    causes.fromAutomation.causes.wrong_assumption,
  ]).toEqual([1, 1]);
});

test("a cached cause is reused from disk; a new exchange is a miss", async () => {
  const file = await path();
  await judgeCauses(
    [reply("wrong branch")],
    await open(file),
    fake(() => "misread_instruction"),
  );
  const judge = fake(() => "steering");
  const causes = await judgeCauses(
    [reply("wrong branch"), reply("use tabs")],
    await open(file),
    judge,
  );
  expect(judge.inputs.map((i) => i.state.correction.reply)).toEqual(["use tabs"]);
  expect([causes.cacheHits, causes.newlyJudged]).toEqual([1, 1]);
  expect(causes.caused.map((c) => c.cause)).toEqual(["misread_instruction", "steering"]);
});

test("a dry run asks nothing and counts one request per uncached exchange", async () => {
  const file = await path();
  await judgeCauses(
    [reply("cached one")],
    await open(file),
    fake(() => "bad_tool_use"),
  );
  const causes = await judgeCauses(
    [reply("cached one"), reply("new one"), reply("new one"), reply("other")],
    await open(file),
    null,
  );
  expect([causes.cacheHits, causes.pending, causes.newlyJudged]).toEqual([1, 2, 0]);
  expect(causes.fromPeople.causes).toEqual(
    expect.objectContaining({ bad_tool_use: 1, pending: 3, failed: 0 }),
  );
  expect(await Bun.file(file).text()).toContain(JevCauses.id);
});

test("failed and unknown answers stay visible and are not cached; a rejected key stops", async () => {
  const file = await path();
  const judge = {
    id: JevCauses.id,
    cause: async (input: CauseInput) => {
      if (input.state.correction.reply === "boom") throw new Error("timeout");
      return { choice: "made_up", model: "jev-test" };
    },
  };
  const causes = await judgeCauses([reply("boom"), reply("odd")], await open(file), judge);
  expect(causes.caused.map((c) => c.cause)).toEqual(["failed", "failed"]);
  expect(causes.failures).toEqual(["timeout", "Unknown cause made_up"]);
  expect(await Bun.file(file).exists()).toBe(false);
  const rejected = {
    id: JevCauses.id,
    cause: async () => {
      throw new KeyRejected(401);
    },
  };
  expect(
    await judgeCauses([reply("x")], await open(file), rejected).catch((e) => e),
  ).toBeInstanceOf(KeyRejected);
});

test("causes join the behaviour of the run before and the existing model buckets", async () => {
  const looping = reply("stop retrying", {}, ["a", "b", "c"].flatMap(failing));
  const causes = await judgeCauses(
    [looping, reply("rename it")],
    await open(await path()),
    fake((input) =>
      input.state.correction.reply === "stop retrying" ? "rabbit_hole" : "steering",
    ),
  );
  const people = causes.fromPeople;
  expect(people.byBehaviour["retry-loop"]).toEqual(
    expect.objectContaining({ rabbit_hole: 1, steering: 0 }),
  );
  expect(people.withoutBehaviour).toEqual(expect.objectContaining({ rabbit_hole: 0, steering: 1 }));
  expect(people.byBucket.find((b) => b.name === "Model")?.buckets).toEqual([
    { label: "model-a", causes: expect.objectContaining({ rabbit_hole: 1, steering: 1 }) },
  ]);
});
