import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Home,
  discoverAll,
  inferences,
  readSessions,
  type Author,
  type HarnessId,
  type Session,
} from "../src/index.ts";

const fixtures = join(import.meta.dir, "fixtures/home");

async function all(home: Home): Promise<Session[]> {
  const out: Session[] = [];
  for await (const o of readSessions(await discoverAll(home))) {
    if (!o.ok) throw o.error;
    out.push(o.session);
  }
  return out.sort((a, b) => `${a.harness}/${a.id}`.localeCompare(`${b.harness}/${b.id}`));
}

async function one(harness: HarnessId, id: string): Promise<Session> {
  const found = (await all(new Home(fixtures))).find((s) => s.harness === harness && s.id === id);
  if (!found) throw new Error(`no ${harness} session ${id}`);
  return found;
}

const messages = (s: Session, author: Author) =>
  s.events.flatMap((e) => (e.type === "message" && e.author === author ? [e.text] : []));

describe("discovery", () => {
  test("finds every harness and links subagents to their parent", async () => {
    const found = (await all(new Home(fixtures))).map((s) => [s.harness, s.id, s.parent]);
    expect(found).toEqual([
      ["claude-code", "agent-a1", "s1"],
      ["claude-code", "s1", null],
      ["codex", "c1", null],
      ["pi", "p1", null],
    ]);
  });

  test("follows each harness's override variable", async () => {
    const home = new Home("/nonexistent")
      .withVar("CLAUDE_CONFIG_DIR", join(fixtures, ".claude"))
      .withVar("CODEX_HOME", join(fixtures, ".codex"))
      .withVar("PI_CODING_AGENT_DIR", join(fixtures, ".pi/agent"));
    expect(await all(home)).toHaveLength(4);
  });

  test("a home without any harness has no sessions", async () => {
    expect(await discoverAll(new Home(mkdtempSync(join(tmpdir(), "quench-"))))).toEqual([]);
  });
});

describe("Claude Code", () => {
  test("separates what people typed from harness text", async () => {
    const s = await one("claude-code", "s1");
    expect(messages(s, "user")).toEqual([
      "Add a health check endpoint",
      "/review now",
      "<div> renders twice",
      "no, use the existing router",
    ]);
    expect(messages(s, "injected")).toHaveLength(3);
    expect(s.cwd).toBe("/work/demo");
  });

  test("records where a message came from when the transcript says", async () => {
    const s = await one("claude-code", "s1");
    const origins = s.events.flatMap((e) =>
      e.type === "message" && e.author === "user" ? [e.origin] : [],
    );
    expect(origins).toEqual(["typed", "unknown", "unknown", "host"]);
  });

  test("counts a streamed model call once, with its final usage", async () => {
    const calls = inferences(await one("claude-code", "s1")).map((i) => [
      i.model,
      i.effort,
      i.usage.input + i.usage.cacheRead + i.usage.cacheWrite,
      i.usage.output,
    ]);
    expect(calls).toEqual([
      ["claude-opus-5-5", "high", 21002, 40],
      ["claude-opus-5-5", "medium", 30003, 9],
    ]);
  });

  test("reads tool errors and compactions, and counts lines it cannot parse", async () => {
    const s = await one("claude-code", "s1");
    expect(s.events.flatMap((e) => (e.type === "tool_result" ? [e.isError] : []))).toEqual([true]);
    expect(s.events.find((e) => e.type === "compaction")).toMatchObject({
      trigger: "auto",
      tokensBefore: 180000,
    });
    expect(s.diagnostics.unparsed).toBe(1);
  });
});

describe("Codex", () => {
  test("hides injected instructions and splits cached input out of input", async () => {
    const s = await one("codex", "c1");
    expect(messages(s, "user")).toEqual(["Fix the flaky test"]);
    expect(messages(s, "injected")).toHaveLength(3);
    expect(inferences(s).map((i) => [i.model, i.effort, i.usage])).toEqual([
      ["gpt-6.1-sol", "high", { input: 6804, cacheRead: 11904, cacheWrite: 0, output: 13 }],
    ]);
  });
});

describe("Pi", () => {
  test("reads usage and thinking level, and skips empty calls", async () => {
    const s = await one("pi", "p1");
    expect(messages(s, "user")).toEqual(["Rename the module"]);
    expect(messages(s, "injected")).toEqual(["You are Pi."]);
    expect(inferences(s).map((i) => [i.effort, i.usage])).toEqual([
      ["medium", { input: 1774, cacheRead: 200, cacheWrite: 0, output: 61 }],
    ]);
  });
});
