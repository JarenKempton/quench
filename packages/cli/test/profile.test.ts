import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, utimes } from "node:fs/promises";
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

  const bare = await quench(home);
  expect(bare.code).toBe(0);
  expect(bare.stdout).toContain(`Pi · ${join(home, ".pi/agent")} · not found (set --pi-home)`);
  expect(bare.stdout).toContain(
    "Projects · 1 git repository · 1 other directory · 1 session directory no longer on disk",
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
