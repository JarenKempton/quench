import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jev, VerdictCache } from "@quench/judge";
import { lines } from "./run.ts";

export const day = (month: number, date: number, second = 0) =>
  new Date(Date.UTC(2026, month - 1, date, 10, 0, second)).toISOString();

export const SKILL = `---
name: verify
description: Run the full test suite before you say a change is done.
---

Run bun test, bunx tsc and bunx vp check before you report a change as done.
`;

export const MEMORY = `- [Checks](checks.md) — what to run first
`;

export const ENTRY = `Always run bun test, bunx tsc and bunx vp check before you report a change as done.
`;

export const TEA = `When the user wants tea, reply with jokes from their notes.
`;

export const PDF = `---
name: pdf
description: Use when the user wants to work with PDF files from their documents.
---

Fill and merge PDF forms.
`;

export function git(cwd: string, at: string, ...args: string[]) {
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

export type Case = { id: string; at: string; corrected: boolean };

export function session(home: string, c: Case) {
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

export const cases = (month: number, corrected: number): Case[] =>
  Array.from({ length: 10 }, (_, i) => ({
    id: `m${month}s${i}`,
    at: day(month, 10 + i),
    corrected: i < corrected,
  }));

export async function fixture(judge = Jev.id, laterCorrected = 5) {
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
  await Bun.write(join(memory, "tea.md"), TEA);
  await Bun.write(join(home, ".claude/skills/pdf/SKILL.md"), PDF);
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
