import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "../src/main.ts");

async function quench(home: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", main, ...args], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
      TYPESAFE_API_KEY: "must-not-be-used",
      TYPESAFE_BASE_URL: "http://127.0.0.1:1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=q", "-c", "user.email=q@q", "-c", "init.defaultBranch=main", ...args],
    { cwd },
  );
  if (!result.success) throw new Error(result.stderr.toString());
};

const codexSession = (dir: string, id: string, cwd: string) =>
  Bun.write(
    join(dir, `${id}.jsonl`),
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-10-20T10:00:00Z",
      payload: { id, cwd },
    }) + "\n",
  );

test("profile with no arguments finds projects from session directories and groups worktrees", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-profile-")));
  const repo = join(home, "code/app");
  const worktree = join(home, "worktrees/app-feature");
  const scratch = join(home, "scratch");
  const untouched = join(home, "elsewhere/lib");
  await mkdir(repo, { recursive: true });
  await mkdir(join(repo, "src"));
  await mkdir(scratch);
  await mkdir(untouched, { recursive: true });
  git(repo, "init");
  git(repo, "commit", "--allow-empty", "-m", "init");
  git(repo, "worktree", "add", worktree);
  git(untouched, "init");
  await Bun.write(join(worktree, "AGENTS.md"), "- Run the real check.\n");
  await Bun.write(join(home, ".codex/AGENTS.md"), "Use concise replies.\n");
  const sessions = join(home, ".codex/sessions/2026/10/20");
  await codexSession(sessions, "a", join(repo, "src"));
  await codexSession(sessions, "b", worktree);
  await codexSession(sessions, "c", worktree);
  await codexSession(sessions, "d", scratch);
  await codexSession(sessions, "e", join(home, "deleted"));
  const earlier = new Date(Date.now() - 86_400_000);
  await utimes(join(sessions, "a.jsonl"), earlier, earlier);
  await Bun.write(join(home, ".claude/CLAUDE.md"), "Prefer boring solutions.\n");
  await Bun.write(
    join(home, "pi-elsewhere/sessions/p.jsonl"),
    JSON.stringify({ type: "session", id: "p", cwd: scratch, timestamp: "2026-10-20T10:00:00Z" }) +
      "\n",
  );

  const older = new Date(Date.now() - 2 * 86_400_000);
  await utimes(join(sessions, "d.jsonl"), older, older);
  await utimes(join(home, "pi-elsewhere/sessions/p.jsonl"), older, older);

  const bare = await quench(home);
  expect(bare.code).toBe(0);
  expect(bare.stdout).toBe(
    [
      "Quench profile · last 30 days · 5 sessions · instruction files as they are on disk now",
      "",
      "  Agent        Sessions  Home",
      "  Claude Code         0  ~/.claude",
      "  Codex               5  ~/.codex",
      "  Pi                  —  ~/.pi/agent not found; set --pi-home",
      "",
      "Global instructions · every project, before project files",
      "  ~/.claude/CLAUDE.md  25 B  Claude Code",
      "  ~/.codex/AGENTS.md   21 B  Codex",
      "",
      "Projects · 1 git repository · project instruction size per agent",
      "  Project  Sessions  Last used  Claude Code  Codex  Recorded/session  Instruction files  Worktrees   Path",
      "  app             3  today             22 B   22 B                 —  AGENTS.md          1 · 0 idle  ~/code/app",
      "",
      "Other folders · 1 folder outside git · 1 session",
      "  Project  Sessions  Last used   Claude Code  Codex  Recorded/session  Instruction files  Path",
      "  scratch         1  2 days ago            —      —                 —  none               ~/scratch",
      "",
      "1 session folder no longer exists; its sessions are not listed.",
      "",
      "Agent columns: the project's own instruction files on disk now in its most recently used folder; global files come on top.",
      "Recorded/session: median instruction text sessions logged loading, global files included. Older harness versions logged none.",
      "Skills, MCP servers and plugins are not counted yet.",
      "",
    ].join("\n"),
  );

  const { stdout, code } = await quench(
    home,
    "profile",
    "--days",
    "36500",
    "--pi-home",
    join(home, "pi-elsewhere"),
    "--scan",
    join(home, "elsewhere"),
    "--json",
  );
  expect(code).toBe(0);
  const out = JSON.parse(stdout);
  expect(
    out.homes.map((h: { harness: string; found: boolean; sessions: number }) => [
      h.harness,
      h.found,
      h.sessions,
    ]),
  ).toEqual([
    ["claude-code", true, 0],
    ["codex", true, 5],
    ["pi", true, 1],
  ]);
  expect(
    out.globalInstructions.map((f: { sources: { path: string }[] }) =>
      f.sources.map((s) => s.path),
    ),
  ).toEqual([[join(home, ".claude/CLAUDE.md")], [join(home, ".codex/AGENTS.md")]]);
  expect(
    out.projects.map(
      (p: {
        root: string;
        git: boolean;
        scanned: boolean;
        sessions: number;
        directories: { path: string }[];
      }) => ({
        root: p.root,
        git: p.git,
        scanned: p.scanned,
        sessions: p.sessions,
        directories: p.directories.map((d) => d.path).sort(),
      }),
    ),
  ).toEqual([
    {
      root: repo,
      git: true,
      scanned: false,
      sessions: 3,
      directories: [join(repo, "src"), worktree].sort(),
    },
    { root: scratch, git: false, scanned: false, sessions: 2, directories: [scratch] },
    { root: untouched, git: true, scanned: true, sessions: 0, directories: [] },
  ]);
  const app = out.projects[0];
  expect(app.harnesses).toEqual(["codex"]);
  expect(app.instructions.directory).toBe(worktree);
  expect(
    app.instructions.files.map((f: { sources: { path: string; scope: string }[] }) =>
      f.sources.map((s) => [s.scope, s.path]),
    ),
  ).toEqual([
    [
      ["project", join(worktree, "AGENTS.md")],
      ["project", join(worktree, "AGENTS.md")],
      ["project", join(worktree, "AGENTS.md")],
    ],
  ]);
  expect(out.missingDirectories).toEqual([join(home, "deleted")]);
});

test("profile rejects a scan directory that does not exist", async () => {
  const home = await mkdtemp(join(tmpdir(), "quench-profile-"));
  const { code, stderr } = await quench(home, "--scan", join(home, "nope"));
  expect(code).toBe(1);
  expect(stderr).toContain("nope");
});

test("worktrees lists idle worktrees safe to remove and why others are kept, without removing any", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-worktrees-")));
  const repo = join(home, "code/app");
  const wt = (name: string) => join(home, "wt", name);
  await mkdir(repo, { recursive: true });
  git(repo, "init");
  git(repo, "commit", "--allow-empty", "-m", "init");
  for (const name of ["active", "merged", "dirty", "unmerged", "locked", "gone"])
    git(repo, "worktree", "add", "-b", name, wt(name));
  git(wt("unmerged"), "commit", "--allow-empty", "-m", "work");
  await Bun.write(join(wt("dirty"), "notes.txt"), "draft\n");
  git(repo, "worktree", "lock", wt("locked"));
  await rm(wt("gone"), { recursive: true });
  const sessions = join(home, ".codex/sessions/2026/10/20");
  await codexSession(sessions, "a", wt("active"));
  await codexSession(sessions, "b", repo);

  const profile = await quench(home);
  expect(profile.stdout).toContain("6 · 4 idle");
  expect(profile.stdout).toContain("`quench worktrees` shows which are safe to remove.");

  const text = await quench(home, "worktrees");
  expect(text.code).toBe(0);
  expect(text.stdout).toContain(
    [
      "~/code/app · 6 linked worktrees · 1 active · 4 idle · base main",
      "  Safe to remove (1):",
      "    git -C ~/code/app worktree remove ~/wt/merged   # merged",
      "  Idle but kept (3):",
      "    ~/wt/dirty   # dirty · uncommitted or untracked changes",
      "    ~/wt/locked   # locked · locked",
      "    ~/wt/unmerged   # unmerged · branch not merged into main",
      "  Folders already gone (1): git -C ~/code/app worktree prune",
    ].join("\n"),
  );

  const { stdout } = await quench(home, "worktrees", "--json");
  const [checked] = JSON.parse(stdout).repositories;
  expect(
    checked.worktrees.map((w: { branch: string; active: boolean; removable: boolean }) => [
      w.branch,
      w.active,
      w.removable,
    ]),
  ).toEqual([
    ["active", true, false],
    ["dirty", false, false],
    ["gone", false, false],
    ["locked", false, false],
    ["merged", false, true],
    ["unmerged", false, false],
  ]);
  for (const name of ["active", "merged", "dirty", "unmerged", "locked"])
    expect(await Bun.file(join(wt(name), ".git")).exists()).toBe(true);
});

test("profile shows the instructions sessions recorded loading and whether disk still matches", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-recorded-")));
  const repo = join(home, "code/app");
  const worktree = join(home, "wt/app-x");
  await mkdir(repo, { recursive: true });
  git(repo, "init");
  git(repo, "commit", "--allow-empty", "-m", "init");
  git(repo, "worktree", "add", worktree);
  const claudeHome = join(home, ".claude");
  const memory = join(
    claudeHome,
    "projects",
    repo.replace(/[^A-Za-z0-9]/g, "-"),
    "memory/MEMORY.md",
  );
  await Bun.write(join(claudeHome, "CLAUDE.md"), "Prefer boring solutions.\n");
  await Bun.write(join(repo, "CLAUDE.md"), "- Run the real check.\n");
  await Bun.write(join(worktree, "CLAUDE.md"), "- New rule.\n");
  await Bun.write(memory, "- Deploys need approval.\n");
  const claudeSession = (id: string, cwd: string, files: object[]) =>
    Bun.write(
      join(claudeHome, "projects/sessions", `${id}.jsonl`),
      [
        { type: "user", timestamp: "2026-10-20T10:00:00Z", cwd, message: { content: "hi" } },
        ...files.map((attachment) => ({
          type: "attachment",
          timestamp: "2026-10-20T10:00:00Z",
          cwd,
          attachment,
        })),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
  const file = (path: string, content: string, extra = {}) => ({
    path,
    type: "Project",
    content,
    ...extra,
  });
  await claudeSession("one", repo, [
    {
      type: "instructions",
      files: [
        file(join(claudeHome, "CLAUDE.md"), "Prefer boring solutions."),
        file(join(repo, "CLAUDE.md"), "- Run the real check."),
        file(memory, "- Deploys need approval."),
      ],
    },
    {
      type: "nested_memory",
      content: file(join(repo, "admin/CLAUDE.md"), "- Small admin changes.", {
        contentDiffersFromDisk: true,
      }),
    },
  ]);
  await claudeSession("two", worktree, [
    {
      type: "instructions",
      files: [
        file(join(claudeHome, "CLAUDE.md"), "Prefer boring solutions."),
        file(join(worktree, "CLAUDE.md"), "- Old rule."),
      ],
    },
  ]);
  await claudeSession("three", repo, []);
  await Bun.write(
    join(home, ".codex/sessions/2026/10/20/c.jsonl"),
    [
      { type: "session_meta", timestamp: "2026-10-20T10:00:00Z", payload: { id: "c", cwd: repo } },
      {
        type: "response_item",
        timestamp: "2026-10-20T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `# AGENTS.md instructions for ${repo}\n\n<INSTRUCTIONS>\nUse concise replies.\n</INSTRUCTIONS>`,
            },
          ],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );

  const yesterday = new Date(Date.now() - 86_400_000);
  await utimes(join(claudeHome, "projects/sessions/two.jsonl"), yesterday, yesterday);

  const { stdout, code } = await quench(home);
  expect(code).toBe(0);
  expect(stdout).toContain(
    [
      "  Project  Sessions  Last used  Claude Code  Codex  Recorded/session  Instruction files  Worktrees   Path",
      "  app             4  today             22 B      —          35 chars  CLAUDE.md          1 · 0 idle  ~/code/app",
    ].join("\n"),
  );
  expect(stdout).toContain(
    [
      "Recorded instructions · what session histories logged loading · worktrees folded",
      "  File                       Agents       Sessions  Last recorded      Size  Disk now",
      "  ~/.claude/CLAUDE.md        Claude Code         2  today          24 chars  same",
      "  app/CLAUDE.md              Claude Code         2  today          21 chars  1 same, 1 differs",
      "  app (combined block)       Codex               1  today          20 chars  not comparable",
      "  app auto memory/MEMORY.md  Claude Code         1  today          24 chars  same",
      "  app/admin/CLAUDE.md        Claude Code         1  today          22 chars  not comparable",
    ].join("\n"),
  );
  const out = JSON.parse((await quench(home, "--json")).stdout);
  expect(
    out.recordedInstructions
      .find((r: { file: string; combined: boolean }) => r.file === "CLAUDE.md" && !r.combined)
      .checkouts.map((c: { path: string; disk: string }) => [c.path, c.disk]),
  ).toEqual([
    [join(repo, "CLAUDE.md"), "same"],
    [join(worktree, "CLAUDE.md"), "differs"],
  ]);
  expect(out.projects[0].recordedLoad).toEqual({ sessions: 3, medianChars: 35 });
});
