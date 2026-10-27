import { expect, test } from "bun:test";
import type { Author, Event, Session } from "@quench/history";
import { ReportBuilder, durationSeconds, runs, signals } from "../src/index.ts";

const at = (secs: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, secs));

const say = (secs: number, author: Author, text: string): Event => ({
  type: "message",
  author,
  origin: "unknown",
  text,
  at: at(secs),
});

const call = (secs: number, context: number, model: string, effort: string): Event => ({
  type: "inference",
  model,
  effort,
  usage: { input: 0, cacheRead: context, cacheWrite: 0, output: 10 },
  at: at(secs),
});

const tool = (secs: number, isError: boolean): Event[] => [
  { type: "tool_call", id: null, name: "anything", at: at(secs) },
  { type: "tool_result", callId: null, isError, chars: 3, at: at(secs) },
];

const session = (id: string, parent: string | null, events: Event[]): Session => ({
  id,
  harness: "claude-code",
  path: "/dev/null",
  cwd: null,
  parent,
  events,
  diagnostics: { lines: events.length, unparsed: 0 },
});

const parent = session("parent", null, [
  say(0, "injected", "harness preamble"),
  say(1, "user", "build it"),
  call(2, 20_000, "model-a", "high"),
  ...tool(3, true),
  call(4, 26_000, "model-a", "high"),
  say(5, "assistant", "done"),
  say(60, "user", "no, the other file"),
  call(61, 30_000, "model-b", "medium"),
  say(120, "user", "thanks"),
]);
const child = session("child", "parent", [call(3, 5_000, "model-c", "low")]);

test("a run spans one prompt and links the reply that followed", () => {
  const summary = runs(parent, [child]).map((r) => ({
    prompt: r.prompt,
    reply: r.reply,
    replyAt: r.replyAt,
    assistantSaid: r.assistantSaid,
    inferences: r.inferences,
    context: [r.contextStart, r.contextPeak],
    output: r.usage.output,
    toolErrors: r.toolErrors,
    subagents: r.subagents,
    model: r.model,
    seconds: durationSeconds(r),
  }));
  expect(summary).toEqual([
    {
      prompt: "build it",
      reply: "no, the other file",
      replyAt: at(60),
      assistantSaid: "done",
      inferences: 2,
      context: [20_000, 26_000],
      output: 20,
      toolErrors: 1,
      subagents: 1,
      model: "model-a",
      seconds: 4,
    },
    {
      prompt: "no, the other file",
      reply: "thanks",
      replyAt: at(120),
      assistantSaid: null,
      inferences: 1,
      context: [30_000, 30_000],
      output: 10,
      toolErrors: 0,
      subagents: 0,
      model: "model-b",
      seconds: 1,
    },
  ]);
});

test("a missing reply timestamp is not inferred from the next run's activity", () => {
  const list = runs(
    session("unknown", null, [
      say(0, "user", "work"),
      call(1, 100, "model", "high"),
      { ...say(2, "user", "correction"), at: null },
      call(3, 100, "model", "high"),
    ]),
  );
  expect(list[0]!.replyAt).toBeNull();
  expect(list[1]!.startedAt).toEqual(at(3));
});

test("the report weighs the starting load against everything processed", () => {
  const builder = new ReportBuilder();
  builder.add(parent);
  builder.add(child);
  const [h] = builder.finish();
  expect(h).toMatchObject({
    sessions: 1,
    subagentSessions: 1,
    runs: 2,
    tokensProcessed: 20_000 + 26_000 + 30_000 + 5_000,
    startingLoadTokens: 20_000 * 3 + 5_000,
    toolErrors: 1,
    toolResultsWithStatus: 1,
  });
  expect(h?.startingLoad.p50).toBe(20_000);
  expect(h?.models[0]?.name).toBe("model-a");
});

test("an empty history reports nothing", () => {
  expect(new ReportBuilder().finish()).toEqual([]);
});

test("signals bucket replies and count the corrected ones", () => {
  const samples = runs(parent, [child]).map((run, i) => ({
    harness: "claude-code" as const,
    position: i + 1,
    run,
    corrected: run.reply === "no, the other file",
  }));
  const buckets = (name: string) =>
    signals(samples)
      .find((s) => s.name === name)
      ?.buckets.map((b) => [b.label, b.replies, b.corrections]);
  expect(buckets("Effort")).toEqual([
    ["medium", 1, 0],
    ["high", 1, 1],
  ]);
  expect(buckets("Context when the reply came")).toEqual([["under 50k", 2, 1]]);
  expect(buckets("Harness")).toEqual([["Claude Code", 2, 1]]);
});

test("each run lists its tool calls in order, with server, outcome and result size", () => {
  const [run] = runs(
    session("s", null, [
      say(0, "user", "go"),
      call(1, 1_000, "m", "high"),
      { type: "mcp_call", id: "a", server: "biz", tool: "list_items", at: at(2) },
      { type: "tool_call", id: "a", name: "mcp__biz__list_items", at: at(2) },
      { type: "tool_call", id: "b", name: "exec", at: at(3) },
      { type: "mcp_call", id: "b", server: "biz", tool: "get_item", inScript: true, at: at(3) },
      { type: "tool_result", callId: "a", isError: false, chars: 120, at: at(4) },
      { type: "tool_result", callId: "b", isError: true, chars: 9, at: at(5) },
    ]),
  );
  expect(run?.calls).toEqual([
    { tool: "list_items", server: "biz", ok: true, resultChars: 120, inScript: false },
    { tool: "exec", server: null, ok: false, resultChars: 9, inScript: false },
    { tool: "get_item", server: "biz", ok: null, resultChars: null, inScript: true },
  ]);
});
