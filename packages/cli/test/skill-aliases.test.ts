import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { quoteArg, removeFolder, shellFor } from "@quench/history";
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

test("a skill tracked in a repo is one row across worktrees, removed from the repo with git", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-repo-")));
  const main = join(home, "repo");
  const other = join(home, "repo-wt");
  await mkdir(main, { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=q", "-c", "user.email=q@q", ...args], { cwd });
  git(main, "init", "-q");
  await skill(join(main, ".claude/skills/foo"));
  await skill(join(main, "b/.claude/skills/foo"));
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "skills");
  git(main, "worktree", "add", "-q", other);
  await skill(join(other, ".claude/skills/scratch"));
  await Bun.write(join(home, ".claude/projects/p/m.jsonl"), lines(listing(main, ["foo"], [])));
  await Bun.write(
    join(home, ".claude/projects/p/w.jsonl"),
    lines(listing(other, ["foo", "scratch"], [])),
  );
  await Bun.write(
    join(home, ".claude/projects/p/b.jsonl"),
    lines(listing(join(other, "b"), ["foo"], [])),
  );
  const { stdout, code } = await quench(home, "profile", "skills");
  expect(code).toBe(0);
  const scratch = join(other, ".claude/skills/scratch");
  expect(cutRows(stdout)).toEqual([
    "30 chars | 2 | Claude Code | foo | tracked in repo | tracked in repo: remove .claude/skills/foo in a PR",
    `23 chars | 1 | Claude Code | scratch | project folder | ${posix ? "rm -r -- ~/repo-wt/.claude/skills/scratch" : `Remove-Item -Recurse -LiteralPath ${quoteArg(scratch, "powershell")}`}`,
    "15 chars | 1 | Claude Code | foo | tracked in repo | tracked in repo: remove b/.claude/skills/foo in a PR",
  ]);
});

test.skipIf(process.platform === "win32")(
  "a symlinked skill tracked in a repo is one row across worktrees",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "quench-repolink-")));
    const main = join(home, "repo");
    const other = join(home, "repo-wt");
    await mkdir(join(main, ".claude/skills"), { recursive: true });
    await skill(join(main, "shared/linked"));
    await symlink("../../shared/linked", join(main, ".claude/skills/linked"));
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.name=q", "-c", "user.email=q@q", ...args], { cwd: main });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "skills");
    git("worktree", "add", "-q", other);
    await Bun.write(join(home, ".claude/projects/p/m.jsonl"), lines(listing(main, ["linked"], [])));
    await Bun.write(
      join(home, ".claude/projects/p/w.jsonl"),
      lines(listing(other, ["linked"], [])),
    );
    const { stdout } = await quench(home, "profile", "skills");
    expect(cutRows(stdout)).toEqual([
      "42 chars | 2 | Claude Code | linked | tracked in repo | tracked in repo: remove .claude/skills/linked in a PR",
    ]);
  },
);

test("tracking checks are literal and need the skill's own entrypoint", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-literal-")));
  const repo = join(home, "repo");
  const skills = join(repo, ".claude/skills");
  await mkdir(repo, { recursive: true });
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=q", "-c", "user.email=q@q", ...args], { cwd: repo });
  git("init", "-q");
  await skill(join(skills, "cutx"));
  await Bun.write(join(skills, "half/README.md"), "notes\n");
  git("add", ".");
  git("commit", "-q", "-m", "skills");
  await skill(join(skills, "cut[x]"));
  await skill(join(skills, "half"));
  await Bun.write(
    join(home, ".claude/projects/p/s.jsonl"),
    lines(listing(repo, ["cutx", "cut[x]", "half"], ["cutx"])),
  );
  const { stdout, code } = await quench(home, "profile", "skills");
  expect(code).toBe(0);
  const rm = (name: string) =>
    removeFolder(join(skills, name), shellFor()).replace(` -- ${home}/`, " -- ~/");
  expect(cutRows(stdout)).toEqual([
    `21 chars | 1 | Claude Code | cut[x] | project folder | ${rm("cut[x]")}`,
    `17 chars | 1 | Claude Code | half | project folder | ${rm("half")}`,
  ]);
});
