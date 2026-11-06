import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessJudge, Jev, VerdictCache } from "@quench/judge";
import { lines, quench } from "./run.ts";

const day = (month: number, date: number, second = 0) =>
  new Date(Date.UTC(2026, month - 1, date, 10, 0, second)).toISOString();

const SKILL = `---
name: verify
description: Run the full test suite before you say a change is done.
---

Run bun test, bunx tsc and bunx vp check before you report a change as done.
`;

const MEMORY = `- [Checks](checks.md) — what to run first
`;

const ENTRY = `Always run bun test, bunx tsc and bunx vp check before you report a change as done.
`;

function git(cwd: string, at: string, ...args: string[]) {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (!result.success) throw new Error(result.stderr.toString());
}

type Case = { id: string; at: string; corrected: boolean };

function session(home: string, c: Case) {
  const work = join(home, "work");
  const memory = join(home, ".claude/projects/-work/memory/MEMORY.md");
  return lines([
    {
      type: "attachment",
      sessionId: c.id,
      cwd: work,
      timestamp: c.at,
      attachment: {
        type: "instructions",
        files: [
          { path: join(work, "CLAUDE.md"), type: "Project", content: "x" },
          { path: memory, type: "AutoMem", content: MEMORY },
        ],
      },
    },
    {
      type: "attachment",
      cwd: work,
      timestamp: c.at,
      attachment: { type: "skill_listing", names: ["verify"], content: "- verify" },
    },
    { type: "user", cwd: work, timestamp: c.at, message: { role: "user", content: "fix it" } },
    {
      type: "assistant",
      cwd: work,
      timestamp: c.at,
      message: {
        id: `${c.id}-m1`,
        model: "model-x",
        content: [
          { type: "tool_use", id: `${c.id}-skill`, name: "Skill", input: { skill: "verify" } },
          { type: "text", text: "done" },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: "user",
      cwd: work,
      timestamp: c.at,
      message: { role: "user", content: c.corrected ? `${c.id}: no, wrong` : `${c.id}: thanks` },
    },
  ]);
}

const cases = (month: number, corrected: number): Case[] =>
  Array.from({ length: 10 }, (_, i) => ({
    id: `m${month}s${i}`,
    at: day(month, 10 + i),
    corrected: i < corrected,
  }));

async function fixture(judge = Jev.id, laterCorrected = 5) {
  const home = await mkdtemp(join(tmpdir(), "quench-file-history-"));
  const work = join(home, "work");
  await mkdir(work, { recursive: true });
  git(work, day(1, 1), "init", "-q");
  git(work, day(1, 1), "config", "core.autocrlf", "false");
  await Bun.write(join(work, "CLAUDE.md"), "Use Bun.\n");
  git(work, day(1, 1), "add", "CLAUDE.md");
  git(work, day(1, 1), "commit", "-q", "-m", "one");
  await Bun.write(join(work, "CLAUDE.md"), "Use Bun.\nRun every check twice before you stop.\n");
  git(work, day(2, 1), "commit", "-q", "-am", "two");
  await Bun.write(join(home, ".claude/skills/verify/SKILL.md"), SKILL);
  const memory = join(home, ".claude/projects/-work/memory");
  await Bun.write(join(memory, "MEMORY.md"), MEMORY);
  await Bun.write(join(memory, "checks.md"), ENTRY);
  const dir = join(home, ".claude/projects/-work");
  const cache = await VerdictCache.open(join(home, ".quench/local"), judge);
  for (const c of [...cases(1, 3), ...cases(2, laterCorrected)]) {
    await Bun.write(join(dir, `${c.id}.jsonl`), session(home, c));
    await cache.remember([
      [
        { assistantSaid: "done", reply: c.corrected ? `${c.id}: no, wrong` : `${c.id}: thanks` },
        { kind: c.corrected ? "correction" : "approval", sender: "person", confidence: 1 },
      ],
    ]);
  }
  return home;
}

async function run(home: string, ...flags: string[]) {
  const args = ["corrections", "--context", "--cached-only", "--days", "36500", ...flags];
  const out = await quench(home, ...args, "--json");
  expect(out.stderr).toBe("");
  const { stdout } = await quench(home, ...args);
  return { json: JSON.parse(out.stdout).context, text: stdout };
}

type History = {
  kind: string;
  name: string;
  path: string;
  source: string;
  versions: {
    from: string;
    bytes: number;
    loaded: { sessions: number; withHumanCorrection: number; judged: number };
  }[];
  changes: { grewBy: number; shown: boolean; grewWithoutDrop: boolean; rates: object }[];
};

async function tree(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { recursive: true })).sort();
  return Promise.all(entries.map(async (e) => `${e}:${(await stat(join(dir, e))).mtimeMs}`));
}

test.each([
  ["Jev", Jev.id, []],
  ["claude", HarnessJudge.id, ["--judge", "claude"]],
])(
  "a tracked instruction file splits at its git commits and is flagged when it grew with no drop in corrections, from %s verdicts",
  async (_, judge, flags) => {
    if (flags.length && process.platform === "win32") return;
    const home = await fixture(judge);
    const before = [await tree(join(home, ".claude")), await tree(join(home, "work"))];
    const { json, text } = await run(home, ...flags);
    expect([await tree(join(home, ".claude")), await tree(join(home, "work"))]).toEqual(before);
    const file = (json.history.files as History[]).find((f) => f.path.endsWith("CLAUDE.md"))!;
    expect(file).toMatchObject({ kind: "instructions", source: "git" });
    expect(
      file.versions.map((v) => [
        v.from.slice(0, 10),
        v.bytes,
        v.loaded.sessions,
        v.loaded.withHumanCorrection,
      ]),
    ).toEqual([
      ["2026-01-01", 9, 10, 3],
      ["2026-02-01", 48, 10, 5],
    ]);
    expect(file.changes).toEqual([
      expect.objectContaining({
        grewBy: 39,
        shown: true,
        grewWithoutDrop: true,
        rates: { before: 0.3, after: 0.5 },
      }),
    ]);
    expect(json.history.basis).toBe("correlation, not cause");
    expect(text).toMatch(
      /Grew 39 B on 2026-02-01 with no drop in correction rate \(30% → 50%\); correlation, not cause/,
    );
  },
);

test("a file that grew while corrections dropped is not flagged", async () => {
  const home = await fixture(Jev.id, 1);
  const { json } = await run(home);
  const file = (json.history.files as History[]).find((f) => f.path.endsWith("CLAUDE.md"))!;
  expect(file.changes[0]).toMatchObject({ shown: true, grewWithoutDrop: false });
});

test("an untracked skill gets its history from snapshots Quench records, split when its content changes", async () => {
  const home = await fixture();
  const skill = join(home, ".claude/skills/verify/SKILL.md");
  const skillOf = (json: { history: { files: History[] } }) =>
    json.history.files.find((f) => f.kind === "skill")!;
  const first = skillOf((await run(home)).json);
  expect(first).toMatchObject({ name: "verify", source: "snapshots" });
  expect(first.versions).toHaveLength(1);
  expect(first.versions[0]!.loaded.sessions).toBe(0);
  await run(home, "--dry-run");
  await Bun.write(skill, `${SKILL}\nAlso run the linter.\n`);
  const second = skillOf((await run(home)).json);
  expect(second.versions.map((v) => v.bytes)).toEqual([SKILL.length, SKILL.length + 22]);
  expect(await Bun.file(skill).text()).toBe(`${SKILL}\nAlso run the linter.\n`);
});

test("a dry run records no snapshot", async () => {
  const home = await fixture();
  await quench(home, "corrections", "--context", "--dry-run", "--days", "36500");
  expect(await Bun.file(join(home, ".quench/local/snapshots.json")).exists()).toBe(false);
});

test("a memory entry that overlaps a skill is flagged with both locations", async () => {
  const home = await fixture();
  const { json, text } = await run(home);
  expect(json.overlaps).toEqual([
    {
      entry: { path: expect.stringMatching(/memory.checks\.md$/), startLine: 1, endLine: 1 },
      copies: 1,
      skill: expect.objectContaining({ name: "verify", startLine: 6 }),
      shared: expect.any(Number),
      duplicate: false,
    },
  ]);
  expect(text).toMatch(/checks\.md:1 {2}↔ {2}skill verify .*SKILL\.md:6/);
});
