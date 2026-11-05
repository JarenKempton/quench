import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessJudge, Jev, VerdictCache } from "@quench/judge";
import { lines, quench } from "./run.ts";

const SECRET = "ghp_" + "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6";

const at = (second: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, second)).toISOString();

function session(id: string, home: string, reply: string, skill: string | null, failures: number) {
  const calls = Array.from({ length: failures }, (_, i) => `${id}-call-${i}`);
  return lines([
    {
      type: "attachment",
      sessionId: id,
      timestamp: at(0),
      attachment: {
        type: "instructions",
        files: [
          { path: join(home, ".claude/CLAUDE.md"), type: "User", content: "Run tests first." },
          ...(id === "a"
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
        id: `${id}-m1`,
        model: "model-x",
        content: [
          ...(skill
            ? [{ type: "tool_use", id: `${id}-skill`, name: "Skill", input: { skill } }]
            : []),
          ...calls.map((cid) => ({
            type: "tool_use",
            id: cid,
            name: "Bash",
            input: { command: "bun test" },
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
        content: calls.map((cid) => ({
          type: "tool_result",
          tool_use_id: cid,
          is_error: true,
          content: "Exit code 1\nerror: 3 tests failed",
        })),
      },
    },
    {
      type: "assistant",
      timestamp: at(4),
      message: {
        id: `${id}-m2`,
        model: "model-x",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "user", timestamp: at(5), message: { role: "user", content: reply } },
  ]);
}

async function fixture(cacheFile: string, judgeId: string) {
  const home = await mkdtemp(join(tmpdir(), "quench-cli-context-"));
  const dir = join(home, ".claude/projects/demo");
  await mkdir(dir, { recursive: true });
  const cases = [
    ["a", "No, you skipped the failing tests again.", "verify", 3],
    ["b", `Wrong: the token ${SECRET} must not be printed.`, null, 3],
    ["c", "Stop, the tests are still failing.", "verify", 3],
    ["d", "That is wrong too.", "deploy", 0],
  ] as const;
  const cache = await VerdictCache.open(join(home, cacheFile), judgeId);
  for (const [id, reply, skill, failures] of cases) {
    await Bun.write(join(dir, `${id}.jsonl`), session(id, home, reply, skill, failures));
    await cache.remember([
      [
        { assistantSaid: "done", reply },
        { kind: "correction", sender: "person", confidence: 1 },
      ],
    ]);
  }
  return home;
}

type Loaded = { name: string; sessions: number; corrections: number; first: string };

async function snapshot(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return Promise.all(entries.map(async (e) => `${e}:${(await stat(join(dir, e))).mtimeMs}`));
}

test.each([
  ["Jev", ".quench/local/judgments.jsonl", Jev.id, []],
  ["claude", ".quench/local/judgments-claude.jsonl", HarnessJudge.id, ["--judge", "claude"]],
])(
  "context lists what was loaded around a correction that recurs after the same failure, from %s verdicts",
  async (_, cacheFile, judgeId, flags) => {
    if (flags.length && process.platform === "win32") return;
    const home = await fixture(cacheFile, judgeId);
    const before = await snapshot(join(home, ".claude"));
    const args = ["corrections", "--context", "--cached-only", "--days", "36500", ...flags];
    const out = JSON.parse((await quench(home, ...args, "--json")).stdout);
    expect(await snapshot(join(home, ".claude"))).toEqual(before);
    expect(out.context).toMatchObject({ corrections: 4, withoutBehaviour: 1, singleSession: 0 });
    expect(out.context.recurring).toHaveLength(1);
    const [recurring] = out.context.recurring;
    expect(recurring).toMatchObject({
      corrections: 3,
      fromPeople: 3,
      sessions: 3,
      first: "2026-10-20",
      last: "2026-10-20",
    });
    expect(recurring.behaviour).toContain("Same failure 3+ times");
    expect(recurring.skills.map((s: Loaded) => [s.name, s.sessions])).toEqual([["verify", 2]]);
    expect(recurring.files.map((f: Loaded) => [f.name, f.sessions])).toEqual([
      [`~${join(home, ".claude/CLAUDE.md").slice(home.length)}`, 3],
      [expect.stringContaining("CLAUDE.md"), 1],
    ]);
    const excerpts = recurring.evidence.map((e: { excerpt: string | null }) => e.excerpt);
    expect(excerpts).toContain("Stop, the tests are still failing.");
    expect(excerpts).toContain(null);
    expect(JSON.stringify(out.context)).not.toContain(SECRET);
    expect(JSON.stringify(out.context)).not.toContain(SECRET.slice(4, 20));

    const { stdout } = await quench(home, ...args);
    const text = stdout.slice(stdout.indexOf("Recurring corrections and what was in context"));
    expect(text).toContain("Same failure 3+ times");
    expect(text).toMatch(/verify {2}2\/3 sessions · 2 corrections · 2026-10-20/);
    expect(text).toContain("1 more in one session each");
    expect(text).toContain("correlation, not a cause");
    expect(text).not.toContain(SECRET);
  },
);
