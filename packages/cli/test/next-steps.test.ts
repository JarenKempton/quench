import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { lines, quench } from "./run.ts";

const skill = (dir: string) =>
  Bun.write(join(dir, "SKILL.md"), `---\nname: ${basename(dir)}\ndescription: d\n---\n`);

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-next-")));
  const work = join(home, "work");
  await mkdir(work, { recursive: true });
  for (const name of ["notes", "keep"]) await skill(join(home, ".claude/skills", name));
  await Bun.write(join(home, ".claude/CLAUDE.md"), "Prefer boring solutions.\n");
  await Bun.write(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        docs: { type: "http", url: "https://docs.example.com/mcp" },
        docs2: { type: "http", url: "https://docs.example.com/mcp" },
      },
    }),
  );
  const names = ["notes", "keep"];
  const session = lines([
    {
      type: "attachment",
      cwd: work,
      attachment: {
        type: "skill_listing",
        names,
        content: names.map((n) => `- ${n}: does ${n}`).join("\n"),
      },
    },
    {
      type: "attachment",
      cwd: work,
      attachment: {
        type: "instructions",
        files: [
          {
            path: join(home, ".claude/CLAUDE.md"),
            type: "User",
            content: "Prefer boring solutions.",
          },
        ],
      },
    },
    {
      type: "api-request-shape",
      shape: {
        tools: [
          { name: "mcp__docs__q", description: "d".repeat(50) },
          { name: "mcp__docs2__q", description: "d".repeat(50) },
        ],
      },
    },
    {
      type: "assistant",
      cwd: work,
      message: {
        content: [{ type: "tool_use", id: "k", name: "Skill", input: { skill: "keep" } }],
      },
    },
  ]);
  await Bun.write(join(home, ".claude/projects/p/one.jsonl"), session);
  await Bun.write(join(home, ".claude/projects/p/two.jsonl"), session);
  return home;
}

test("the summary ends with measured cuts ranked by characters × sessions, in --json too", async () => {
  const home = await fixture();
  const { stdout, code } = await quench(home);
  expect(code).toBe(0);
  const next = stdout.slice(stdout.indexOf("▍Do this next"));
  expect(next).toBe(
    [
      "▍Do this next · ranked by characters saved × sessions",
      "  1. Remove MCP server docs2 from ~/.claude.json",
      "     91 chars per session × 2 sessions",
      "     same url as docs, which stays",
      "",
      "  2. Trim ~/.claude/CLAUDE.md",
      "     up to 24 chars per session × 2 sessions",
      "     loaded in full every session; trimming it saves up to its whole size",
      "",
      "  3. Cut notes (user folder)",
      "     19 chars per session × 2 sessions",
      `     remove ${join(home, ".claude/skills/notes")}`,
      "",
      "More: quench profile [projects|mcp|instructions|skills|failures] · quench sources · quench --help",
      "",
    ].join("\n"),
  );
  const json = JSON.parse((await quench(home, "--json")).stdout);
  expect(json.nextSteps.map((s: { kind: string }) => s.kind)).toEqual([
    "duplicate-mcp",
    "instruction-file",
    "skill-cut",
  ]);
  expect(json.nextSteps[2]).toEqual({
    kind: "skill-cut",
    action: "Cut notes (user folder)",
    command: null,
    note: `remove ${join(home, ".claude/skills/notes")}`,
    charsPerSession: 19,
    sessions: 2,
    totalChars: 38,
    size: "exact",
  });
});

test("the summary says so when nothing measured is worth doing", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-next-")));
  await Bun.write(
    join(home, ".claude/projects/p/one.jsonl"),
    lines([{ type: "user", cwd: home, message: { content: "hi" } }]),
  );
  const { stdout } = await quench(home);
  expect(stdout).toContain(
    "▍Do this next · ranked by characters saved × sessions\n  Nothing measured is worth cutting right now.\n",
  );
  expect(JSON.parse((await quench(home, "--json")).stdout).nextSteps).toEqual([]);
});
