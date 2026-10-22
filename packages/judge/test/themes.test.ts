import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runs } from "@quench/insights";
import {
  groupCorrections,
  JevThemes,
  ThemeCache,
  VerdictCache,
  type Reply,
  type ThemeInput,
} from "../src/index.ts";

const options = { limit: 20, examples: 10, since: new Date("2026-10-01T00:00:00Z") };
const path = async () => join(await mkdtemp(join(tmpdir(), "quench-themes-")), "themes.jsonl");
const reply = (sessionId: string, text: string, extra: Partial<Reply> = {}): Reply => ({
  sessionId,
  path: `/history/${sessionId}.jsonl`,
  harness: "codex",
  cwd: null,
  position: 1,
  kind: "correction",
  sender: "person",
  senderSource: "judge",
  run: runs({
    id: sessionId,
    harness: "codex",
    path: "/unused",
    cwd: null,
    parent: null,
    diagnostics: { lines: 4, unparsed: 0 },
    events: [
      { type: "message", author: "user", origin: "host", text: "work", at: null },
      {
        type: "inference",
        model: "model-a",
        effort: null,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        at: new Date("2026-10-20T10:00:00Z"),
      },
      { type: "message", author: "assistant", origin: "unknown", text: "done", at: null },
      {
        type: "message",
        author: "user",
        origin: "host",
        text,
        at: new Date("2026-10-20T10:00:02Z"),
      },
    ],
  })[0]!,
  ...extra,
});

function scripted(answers: string[]) {
  const inputs: ThemeInput[] = [];
  return {
    id: JevThemes.id,
    inputs,
    assign: async (input: ThemeInput) => {
      inputs.push(input);
      const choice = answers[inputs.length - 1];
      if (!choice) throw new Error("Unexpected model call");
      return { choice, model: "jev-test" };
    },
  };
}

test("semantic assignments retain occurrences, distinct sessions, run models and sender evidence", async () => {
  const cacheFile = await path();
  const cache = await ThemeCache.open(cacheFile, JevThemes.id);
  const a = reply("a", "Please run the check before saying it passes.");
  const b = reply("b", "Don't claim verification without executing the check.", {
    senderSource: "host",
  });
  b.run.model = "model-b";
  const duplicate = reply("c", a.run.reply!, { senderSource: "harness" });
  duplicate.run.model = null;
  const list = [
    b,
    duplicate,
    a,
    reply("d", "Use the other endpoint."),
    reply("e", "That is unclear."),
    reply("f", "Agent relay", { sender: "automation" }),
    reply("g", "Unresolved sender", { sender: null, senderSource: "unknown" }),
    reply("h", "Not classified", { kind: null }),
  ];
  const judge = scripted(["new", "t0", "new", "unclear"]);
  const result = await groupCorrections(list, cache, judge, options);
  expect([result.eligibleCorrections, result.uniqueInputs, result.newlyGrouped]).toEqual([5, 4, 4]);
  expect(result.excluded).toEqual({
    outsideWindowCorrections: 0,
    unknownTimeCorrections: 0,
    automationCorrections: 1,
    unknownSenderCorrections: 1,
    unclassifiedReplies: 1,
  });
  expect(result.unclear).toBe(1);
  expect(result.themes[0]).toMatchObject({
    representative: a.run.reply,
    corrections: 3,
    sessions: 3,
    recurring: true,
    models: ["model-a", "model-b"],
    unknownModels: 1,
    senderSources: { harness: 1, host: 1, judge: 1, unknown: 0 },
    classifierModels: ["jev-test"],
  });
  expect(result.themes[0]!.examples.map((e) => [e.sessionId, e.position, e.path])).toEqual([
    ["a", 1, "/history/a.jsonl"],
    ["c", 1, "/history/c.jsonl"],
    ["b", 1, "/history/b.jsonl"],
  ]);
  expect(Object.keys(judge.inputs[0]!.choices)).toEqual(["new", "unclear"]);
  expect(Object.keys(judge.inputs[1]!.state)).toEqual(["correction", "exemplars"]);
  const bytes = await Bun.file(cacheFile).text();
  const replay = await groupCorrections(
    [...list].reverse(),
    await ThemeCache.open(cacheFile, JevThemes.id),
    scripted([]),
    options,
  );
  expect([replay.cacheHits, replay.newlyGrouped, replay.failed]).toEqual([4, 0, 0]);
  expect(replay.themes).toEqual(result.themes);
  expect(await Bun.file(cacheFile).text()).toBe(bytes);
});

test("dry-run stops at the first unknown decision, without inventing downstream groups or writing", async () => {
  const cacheFile = await path();
  const cache = await ThemeCache.open(cacheFile, JevThemes.id);
  const list = [
    reply("a", "First correction"),
    reply("b", "Second correction"),
    reply("c", "Third correction"),
  ];
  const first = await groupCorrections(list, cache, null, options);
  expect([first.pending, first.blocked, first.newlyGrouped, first.themes.length]).toEqual([
    1, 2, 0, 0,
  ]);
  expect(await Bun.file(cacheFile).exists()).toBe(false);
  await groupCorrections(list, cache, scripted(["new"]), { ...options, limit: 1 });
  const before = await Bun.file(cacheFile).text();
  const partial = await groupCorrections(list, cache, null, options);
  expect([partial.cacheHits, partial.pending, partial.blocked]).toEqual([1, 1, 1]);
  expect(await Bun.file(cacheFile).text()).toBe(before);
});

test("the theme window uses known correction timestamps and abstains when the reply time is missing", async () => {
  const cache = await ThemeCache.open(await path(), JevThemes.id);
  const old = reply("a", "Old correction");
  old.run.replyAt = new Date("2020-01-01T00:00:00Z");
  const unknown = reply("b", "Unknown date");
  unknown.run.replyAt = null;
  const judge = scripted(["new"]);
  const result = await groupCorrections(
    [old, unknown, reply("c", "Current correction")],
    cache,
    judge,
    { ...options, limit: 1 },
  );
  expect([result.eligibleCorrections, result.omittedCorrections, judge.inputs.length]).toEqual([
    1, 0, 1,
  ]);
  expect(result.excluded).toMatchObject({ outsideWindowCorrections: 1, unknownTimeCorrections: 1 });
  expect(result.themes[0]!.representative).toBe("Current correction");
});

test("limits apply to unique exchanges without dropping their local occurrences, and recurrence needs multiple sessions", async () => {
  const cache = await ThemeCache.open(await path(), JevThemes.id);
  const a = reply("a", "Keep the scope small");
  const result = await groupCorrections(
    [a, { ...a, position: 2 }, reply("b", "Another correction")],
    cache,
    scripted(["new"]),
    { ...options, limit: 1, examples: 0 },
  );
  expect([result.selectedInputs, result.selectedCorrections, result.omittedCorrections]).toEqual([
    1, 2, 1,
  ]);
  expect(result.themes[0]).toMatchObject({
    corrections: 2,
    sessions: 1,
    recurring: false,
    examples: [],
  });
  const invalid = await groupCorrections([a], cache, null, { ...options, limit: 51 }).catch(
    (error: unknown) => error,
  );
  expect(invalid).toMatchObject({ message: "Theme limit must be between 1 and 50" });
  const otherHarness = { ...a, harness: "pi" as const };
  const cross = await groupCorrections([a, otherHarness], cache, null, options);
  expect(cross.themes[0]!.sessions).toBe(2);
});

test("cache identity includes all classifier inputs and version, but not local evidence metadata", async () => {
  const cacheFile = await path();
  const cache = await ThemeCache.open(cacheFile, JevThemes.id);
  const judge = scripted(["new"]);
  const a = reply("a", "Verify before claiming success");
  await groupCorrections([a], cache, judge, options);
  const input = judge.inputs[0]!;
  expect(cache.get(input)?.choice).toBe("new");
  for (const changed of [
    { ...input, question: "different question" },
    { ...input, choices: { ...input.choices, new: "different meaning" } },
    {
      ...input,
      state: {
        ...input.state,
        correction: { ...input.state.correction, assistantSaid: "different context" },
      },
    },
    {
      ...input,
      state: { ...input.state, exemplars: [{ id: "t0", exchange: input.state.correction }] },
    },
  ])
    expect(cache.get(changed)).toBeUndefined();
  const before = await Bun.file(cacheFile).text();
  expect((await ThemeCache.open(cacheFile, "another-version")).get(input)).toBeUndefined();
  expect(await Bun.file(cacheFile).text()).toBe(before);
  a.run.model = "new-local-model";
  const replay = await groupCorrections([{ ...a, senderSource: "host" }], cache, null, options);
  expect(replay.themes[0]).toMatchObject({
    models: ["new-local-model"],
    senderSources: { host: 1 },
  });
});

test("invalid choices stop without poisoning the cache, and excerpts are Unicode-safe and bounded", async () => {
  const cacheFile = await path();
  const cache = await ThemeCache.open(cacheFile, JevThemes.id);
  const a = reply("a", "🙂".repeat(1500));
  a.run.assistantSaid = "🙂".repeat(2000);
  const judge = scripted(["invented"]);
  const failed = await groupCorrections([a, reply("b", "Other")], cache, judge, options);
  expect([failed.failed, failed.blocked, failed.newlyGrouped]).toEqual([1, 1, 0]);
  expect(await Bun.file(cacheFile).exists()).toBe(false);
  expect(Array.from(judge.inputs[0]!.state.correction.reply)).toHaveLength(1000);
  expect(Array.from(judge.inputs[0]!.state.correction.assistantSaid)).toHaveLength(500);
});

test("unterminated theme cache tails cannot consume existing or newly appended decisions", async () => {
  for (const tail of ["", '\n{"judge":']) {
    const file = await path();
    const original = await ThemeCache.open(file, JevThemes.id);
    const judge = scripted(["new"]);
    await groupCorrections([reply("a", "Verify first")], original, judge, options);
    const input = judge.inputs[0]!;
    const firstLine = (await Bun.file(file).text()).trimEnd();
    await Bun.write(file, firstLine + tail);
    const reopened = await ThemeCache.open(file, JevThemes.id);
    expect(reopened.get(input)?.choice).toBe("new");
    const next = { ...input, question: "Another specific question" };
    await reopened.remember(next, { choice: "unclear", model: "jev-test" });
    const again = await ThemeCache.open(file, JevThemes.id);
    expect([again.get(input)?.choice, again.get(next)?.choice]).toEqual(["new", "unclear"]);
    expect((await Bun.file(file).text()).startsWith(firstLine + tail)).toBe(true);
  }
});

test("malformed caches and other namespaces remain byte-identical when opened read-only", async () => {
  const file = await path();
  const bytes =
    "not json\n" +
    JSON.stringify({
      judge: "old",
      key: "old",
      verdict: { kind: "correction", sender: "person", confidence: 1 },
    }) +
    "\n";
  await Bun.write(file, bytes);
  const cache = await ThemeCache.open(file, JevThemes.id);
  expect(cache.warnings).toHaveLength(1);
  await VerdictCache.open(file, "different", true);
  expect(await Bun.file(file).text()).toBe(bytes);
});

test("Jev's grouping call uses only its separate question, records model/usage, and does not retry errors", async () => {
  const cache = await ThemeCache.open(await path(), JevThemes.id);
  let calls = 0;
  const judge = new JevThemes("test", async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init!.body as string);
    expect(Object.keys(body.questions)).toEqual(["theme"]);
    expect(Object.keys(body.state)).toEqual(["correction", "exemplars"]);
    return Response.json({
      model: "jev-test",
      answers: { theme: { type: "choice", choice: "new", confidence: 1, probabilities: {} } },
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  });
  const result = await groupCorrections([reply("a", "Correct this")], cache, judge, options);
  expect([result.newlyGrouped, calls]).toEqual([1, 1]);
  expect(judge.tokens).toEqual({ input: 10, output: 2 });
  const broken = new JevThemes("test", async () => {
    calls += 1;
    return Response.json({ error: "unavailable" }, { status: 500 });
  });
  const failed = await groupCorrections([reply("b", "Other correction")], cache, broken, options);
  expect([failed.failed, calls]).toEqual([1, 2]);
});

test("the maximum analysis limit bounds fresh calls and exemplar choices even for all-distinct intents", async () => {
  const cache = await ThemeCache.open(await path(), JevThemes.id);
  const list = Array.from({ length: 60 }, (_, i) =>
    reply(`s${String(i).padStart(2, "0")}`, `Distinct corrective intent ${i}`),
  );
  const judge = scripted(Array.from({ length: 50 }, () => "new"));
  const result = await groupCorrections(list, cache, judge, { ...options, limit: 50 });
  expect([
    result.selectedInputs,
    result.newlyGrouped,
    result.omittedCorrections,
    judge.inputs.length,
  ]).toEqual([50, 50, 10, 50]);
  expect(Math.max(...judge.inputs.map((input) => Object.keys(input.choices).length))).toBe(51);
  expect(Math.max(...judge.inputs.map((input) => input.state.exemplars.length))).toBe(49);
});
