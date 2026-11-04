import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { quoteArg, shellFor } from "@quench/history";
import { lines, quench } from "./run.ts";

const skill = (dir: string) =>
  Bun.write(join(dir, "SKILL.md"), `---\nname: ${basename(dir)}\ndescription: d\n---\n`);

const listing = (cwd: string, names: string[], used: string[]) => [
  {
    type: "attachment",
    cwd,
    attachment: {
      type: "skill_listing",
      names,
      content: names.map((n) => `- ${n}: does ${n}`).join("\n"),
    },
  },
  ...used.map((name) => ({
    type: "assistant",
    cwd,
    message: { content: [{ type: "tool_use", id: name, name: "Skill", input: { skill: name } }] },
  })),
];

const cutRows = (stdout: string) =>
  stdout
    .slice(stdout.indexOf("▍Cut list"))
    .split("\n")
    .slice(2)
    .filter((r) => /^\s+\S+ chars/.test(r))
    .map((r) => r.replace(/^\s+/, "").replace(/\s{2,}/g, " | "));

const posix = shellFor() === "posix";

test("each session's skills resolve against its own directory, not the project's latest", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-cwd-")));
  const repo = join(home, "repo");
  await mkdir(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  await skill(join(repo, "a/.claude/skills/foo"));
  await skill(join(repo, "b/.claude/skills/foo"));
  const older = join(home, ".claude/projects/p/a.jsonl");
  await Bun.write(older, lines(listing(join(repo, "a"), ["foo"], ["foo"])));
  await utimes(older, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
  await Bun.write(
    join(home, ".claude/projects/p/b.jsonl"),
    lines(listing(join(repo, "b"), ["foo"], [])),
  );
  const { stdout, code } = await quench(home, "profile", "skills");
  expect(code).toBe(0);
  const b = join(repo, "b/.claude/skills/foo");
  expect(cutRows(stdout)).toEqual([
    `15 chars | 1 | Claude Code | foo | project folder | ${posix ? "rm -r -- ~/repo/b/.claude/skills/foo" : `Remove-Item -Recurse -LiteralPath ${quoteArg(b, "powershell")}`}`,
  ]);
});

test("a folder used through a symlink alias is protected, and an unused alias removes only the link", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-alias-")));
  const work = join(home, "work");
  await mkdir(work, { recursive: true });
  await skill(join(home, ".agents/skills/notes"));
  await mkdir(join(home, ".claude/skills"), { recursive: true });
  await symlink(join(home, ".agents/skills/notes"), join(home, ".claude/skills/notes"), "dir");
  await skill(join(home, ".claude/skills/memo"));
  await symlink(join(home, ".claude/skills/memo"), join(home, ".agents/skills/memo"), "dir");
  await Bun.write(
    join(home, ".claude/projects/p/c.jsonl"),
    lines(listing(work, ["notes", "memo"], ["notes", "memo"])),
  );
  const agents = join(home, ".agents/skills");
  const block = [
    "<skills_instructions>",
    `- \`r0\` = \`${agents}\``,
    "- notes: Notes (file: r0/notes/SKILL.md)",
    "- memo: Memo (file: r0/memo/SKILL.md)",
    "</skills_instructions>",
  ].join("\n");
  await Bun.write(
    join(home, ".codex/sessions/2026/10/20/c.jsonl"),
    lines([
      { type: "session_meta", payload: { id: "c", cwd: work } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: block }],
        },
      },
    ]),
  );
  const { stdout, code } = await quench(home, "profile", "skills");
  expect(code).toBe(0);
  const memo = join(agents, "memo");
  expect(cutRows(stdout)).toEqual([
    "40 chars | 1 | Codex | notes | user folder | no command, still used: Claude Code notes 1",
    `37 chars | 1 | Codex | memo | user folder | ${posix ? "rm -- ~/.agents/skills/memo" : `(Get-Item -LiteralPath ${quoteArg(memo, "powershell")}).Delete()`} · removes the link only, not the folder it points to`,
  ]);
});
