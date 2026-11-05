import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@quench/history";
import { HarnessJudge, Jev, VerdictCache } from "@quench/judge";
import { contextOf } from "../src/commands/context.ts";
import { lines, quench } from "./run.ts";

const CANARY = "QCANARY7x";
const leaks = [
  `{\\"token\\":\\"${CANARY}a\\"}`,
  `Cookie: sid=${CANARY}b`,
  `https://${CANARY}c:pw@example.com/repo`,
  `curl -u ${CANARY}d:${CANARY}e https://example.com`,
  `oathtool deadbeef${CANARY}f`,
];

const at = (second: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, second)).toISOString();

type Case = { id: string; reply: string; skill: string | null; failures: number; error?: string };

function session(home: string, c: Case) {
  const calls = Array.from({ length: c.failures }, (_, i) => `${c.id}-call-${i}`);
  return lines([
    {
      type: "attachment",
      sessionId: c.id,
      timestamp: at(0),
      attachment: {
        type: "instructions",
        files: [
          { path: join(home, ".claude/CLAUDE.md"), type: "User", content: "Run tests first." },
          ...(c.id === "a"
            ? [{ path: join(home, "work/CLAUDE.md"), type: "Project", content: "Use Bun." }]
            : []),
        ],
      },
    },
    {
      type: "attachment",
      timestamp: at(0),
      attachment: {
        type: "skill_listing",
        names: ["verify", "deploy"],
        content: "- verify\n- deploy",
      },
    },
    { type: "user", timestamp: at(1), message: { role: "user", content: "fix the build" } },
    {
      type: "assistant",
      timestamp: at(2),
      message: {
        id: `${c.id}-m1`,
        model: "model-x",
        content: [
          ...(c.skill
            ? [{ type: "tool_use", id: `${c.id}-skill`, name: "Skill", input: { skill: c.skill } }]
            : []),
          ...calls.map((id) => ({
            type: "tool_use",
            id,
            name: "Bash",
            input: { command: c.error ? `curl -u ${CANARY}d:${CANARY}e x` : "bun test" },
          })),
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: "user",
      timestamp: at(3),
      message: {
        role: "user",
        content: calls.map((id) => ({
          type: "tool_result",
          tool_use_id: id,
          is_error: true,
          content: c.error ?? "Exit code 1\nerror: 3 tests failed",
        })),
      },
    },
    {
      type: "assistant",
      timestamp: at(4),
      message: {
        id: `${c.id}-m2`,
        model: "model-x",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "user", timestamp: at(5), message: { role: "user", content: c.reply } },
  ]);
}

const ordinary: Case[] = [
  { id: "a", reply: "No, you skipped the failing tests again.", skill: "verify", failures: 3 },
  { id: "b", reply: "Wrong, the tests still fail.", skill: null, failures: 3 },
  { id: "c", reply: "Stop, the tests are still failing.", skill: "verify", failures: 3 },
  { id: "d", reply: "That is wrong too.", skill: "deploy", failures: 0 },
];

async function fixture(cases: Case[], id = Jev.id) {
  const home = await mkdtemp(join(tmpdir(), "quench-cli-context-"));
  const dir = join(home, ".claude/projects/demo");
  await mkdir(dir, { recursive: true });
  const cache = await VerdictCache.open(join(home, ".quench/local"), id);
  for (const c of cases) {
    await Bun.write(join(dir, `${c.id}.jsonl`), session(home, c));
    await cache.remember([
      [
        { assistantSaid: "done", reply: c.reply },
        { kind: "correction", sender: "person", confidence: 1 },
      ],
    ]);
  }
  return home;
}

async function context(home: string, ...flags: string[]) {
  const args = ["corrections", "--context", "--cached-only", "--days", "36500", ...flags];
  const json = JSON.parse((await quench(home, ...args, "--json")).stdout).context;
  const { stdout } = await quench(home, ...args);
  return {
    json,
    text: stdout.slice(stdout.indexOf("Recurring corrections and what was in context")),
  };
}

type Loaded = { name: string; sessions: number; corrections: number; first: string };

async function snapshot(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { recursive: true })).sort();
  return Promise.all(entries.map(async (e) => `${e}:${(await stat(join(dir, e))).mtimeMs}`));
}

test.each([
  ["Jev", Jev.id, []],
  ["claude", HarnessJudge.id, ["--judge", "claude"]],
])(
  "context lists every skill and file loaded around a correction that recurs after the same failure, from %s verdicts",
  async (_, judgeId, flags) => {
    if (flags.length && process.platform === "win32") return;
    const home = await fixture(ordinary, judgeId);
    const before = await snapshot(join(home, ".claude"));
    const { json, text } = await context(home, ...flags);
    expect(await snapshot(join(home, ".claude"))).toEqual(before);
    expect(json).toMatchObject({ corrections: 4, outsideWindow: 0, withoutBehaviour: 1 });
    expect(json.recurring).toHaveLength(1);
    const [recurring] = json.recurring;
    expect(recurring).toMatchObject({
      behaviour: "Same failure 3+ times: Bash · bun test",
      corrections: 3,
      fromPeople: 3,
      sessions: 3,
      first: "2026-10-20",
      last: "2026-10-20",
    });
    expect(recurring.skills.map((s: Loaded) => [s.name, s.sessions])).toEqual([["verify", 2]]);
    expect(recurring.files.map((f: Loaded) => [f.name, f.sessions, f.corrections])).toEqual([
      [`~${join(home, ".claude/CLAUDE.md").slice(home.length)}`, 3, 3],
      [`~${join(home, "work/CLAUDE.md").slice(home.length)}`, 1, 1],
    ]);
    expect(recurring.evidence.map((e: object) => Object.keys(e).sort())).toEqual(
      Array(3).fill(["date", "harness", "position", "sender", "sessionId"]),
    );
    expect(text).toMatch(/verify {2}2\/3 sessions · 2 corrections · 2026-10-20/);
    expect(text).toMatch(/work.CLAUDE\.md {2}1\/3 sessions · 1 correction · 2026-10-20/);
    expect(text).toContain("correlation, not a cause");
  },
);

test("context renders no reply, error or command text, in text or JSON", async () => {
  const home = await fixture(
    leaks.map((reply, i) => ({
      id: `leak${i}`,
      reply,
      skill: `Cookie: sid=${CANARY}g`,
      failures: 3,
      error: i % 2 ? `Cookie: sid=${CANARY}b` : `Exit code 1\nCookie: sid=${CANARY}b`,
    })),
  );
  const { json, text } = await context(home);
  expect(json.recurring.map((r: { behaviour: string }) => r.behaviour)).toEqual([
    "Same failure 3+ times: Bash · curl",
  ]);
  expect(JSON.stringify(json)).not.toContain(CANARY);
  expect(text).toContain("Same failure 3+ times: Bash · curl");
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain("Cookie");
});

test("context counts only corrections inside --days, by the correction's own time", async () => {
  const home = await fixture(ordinary);
  const out = JSON.parse(
    (await quench(home, "corrections", "--context", "--cached-only", "--days", "1", "--json"))
      .stdout,
  ).context;
  expect(out).toMatchObject({ corrections: 0, outsideWindow: 4, recurring: [] });
});

const listed = (path: string) => ({
  type: "skills",
  at: null,
  chars: 1,
  listed: [{ name: "verify", path, chars: 1 }],
});

test("a skill counts only when listed and invoked, read or run through the shell successfully", () => {
  const path = "/skills/verify/SKILL.md";
  const of = (events: object[], harness = "codex") =>
    contextOf(
      { harness, cwd: "/", events, diagnostics: { unparsed: 0 } } as unknown as Session,
      "/home",
    ).skills;
  const call = (id: string, extra: object) => ({
    type: "tool_call",
    at: null,
    id,
    name: "x",
    ...extra,
  });
  const result = (callId: string, isError: boolean | null, extra: object = {}) => ({
    type: "tool_result",
    at: null,
    callId,
    isError,
    chars: 1,
    ...extra,
  });
  const shell = (command: string) => ({ shell: [{ command, workdir: "/" }] });
  expect(of([listed(path), call("1", shell(`echo ${path}`)), result("1", null)])).toEqual([]);
  expect(of([listed(path), call("1", shell(`cat ${path}`)), result("1", true)])).toEqual([]);
  expect(of([listed(path), call("1", shell(`cat ${path}`)), result("1", null)])).toEqual([
    "verify",
  ]);
  const read = call("1", { fileRead: { path } });
  const returned = { fileRead: { path, returnedTextChars: 1 } };
  expect(of([listed(path), read, result("1", true)], "claude-code")).toEqual([]);
  expect(of([listed(path), read, result("1", false, returned)], "claude-code")).toEqual(["verify"]);
  const invoked = (name: string) => ({ type: "invocation", at: null, name, by: "model" });
  expect(of([listed(path), invoked("verify")])).toEqual(["verify"]);
  expect(of([listed(path), invoked(`Cookie: sid=${CANARY}g`)])).toEqual([]);
  expect(of([invoked("verify")])).toBeNull();
});

test("combined instruction blocks from different folders stay separate and say what they are", () => {
  const block = (directory: string) => ({
    path: null,
    directory,
    label: "AGENTS.md instructions",
    textSha256: directory,
    textChars: 1,
    textDiffersFromFile: null,
  });
  const files = contextOf(
    {
      events: [
        { type: "instructions", at: null, unreadable: 0, files: [block("/historical/x")] },
        { type: "instructions", at: null, unreadable: 0, files: [block("/historical/y")] },
      ],
      harness: "codex",
      diagnostics: { unparsed: 0 },
      cwd: "/",
    } as unknown as Session,
    "/home",
  ).files;
  expect(files).toEqual([
    "/historical/x (AGENTS.md instructions)",
    "/historical/y (AGENTS.md instructions)",
  ]);
});
