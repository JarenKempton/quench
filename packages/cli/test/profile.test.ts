import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Home, skillInventory } from "@quench/history";

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

  const summary = await quench(home);
  expect(summary.code).toBe(0);
  expect(summary.stdout).toBe(
    [
      "Quench · last 30 days · 5 sessions (Codex 5)",
      "",
      "Every session starts with",
      "  Codex  21 B global instructions  no skill listing recorded",
      "  Each project adds its own instruction files on top.",
      "",
      "Busiest projects",
      "  Project  Sessions  Last used   Instructions per session",
      "  app             3  today                              —",
      "  scratch         1  2 days ago                         —",
      "",
      "Dig in",
      "  quench profile            every table, in full",
      "  quench profile <section>  one of: projects, mcp, instructions, skills, failures",
      "  quench sources <file>     what one session read",
      "  quench --help             all commands",
      "",
    ].join("\n"),
  );

  const bare = await quench(home, "profile");
  expect(bare.code).toBe(0);
  expect(bare.stdout).toBe(
    [
      "Quench profile · last 30 days · 5 sessions · instruction files as they are on disk now",
      "",
      "  Agent        Sessions  Skills  MCP  Home",
      "  Claude Code         0  0         0  ~/.claude",
      "  Codex               5  0         0  ~/.codex",
      "  Pi                  —  —         —  ~/.pi/agent not found; set --pi-home",
      "",
      "Global instructions · every project, before project files",
      "  ~/.claude/CLAUDE.md  25 B  Claude Code",
      "  ~/.codex/AGENTS.md   21 B  Codex",
      "",
      "Projects · 1 git repository · project instruction size per agent",
      "  Project  Sessions  Last used  Claude Code  Codex  Recorded/session  Skills  MCP  Instruction files  Worktrees   Path",
      "  app             3  today             22 B   22 B                 —       —    —  AGENTS.md          1 · 0 idle  ~/code/app",
      "",
      "Other folders · 1 folder outside git · 1 session",
      "  Project  Sessions  Last used   Claude Code  Codex  Recorded/session  Skills  MCP  Instruction files  Path",
      "  scratch         1  2 days ago            —      —                 —       —    —  none               ~/scratch",
      "",
      "1 session folder no longer exists; its sessions are not listed.",
      "",
      "Agent columns: the project's own instruction files on disk now in its most recently used folder; global files come on top.",
      "Recorded/session: median instruction text sessions logged loading, global files included. Older harness versions logged none.",
      "Skills: model-visible skills and their up-front name + description size; bodies load on demand. Built-in and plugin skills are not counted yet.",
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

  const profile = await quench(home, "profile");
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

  const { stdout, code } = await quench(home, "profile");
  expect(code).toBe(0);
  expect(stdout).toContain(
    [
      "  Project  Sessions  Last used  Claude Code  Codex  Recorded/session  Skills  MCP  Instruction files  Worktrees   Path",
      "  app             4  today             22 B      —          35 chars       —    —  CLAUDE.md          1 · 0 idle  ~/code/app",
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

test("profile lists skills and MCP servers each agent finds, without reading out secrets", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-setup-")));
  const repo = join(home, "code/app");
  const worktree = join(home, "wt/app-x");
  await mkdir(repo, { recursive: true });
  git(repo, "init");
  git(repo, "commit", "--allow-empty", "-m", "init");
  git(repo, "worktree", "add", worktree);
  const skill = (dir: string, front: string, body = "Steps.\n") =>
    Bun.write(join(dir, "SKILL.md"), `---\n${front}\n---\n\n${body}`);
  await skill(join(home, ".claude/skills/review"), "name: review\ndescription: Review: find bugs");
  await skill(
    join(home, ".claude/skills/release"),
    "name: release\ndescription: Ship it\ndisable-model-invocation: true",
  );
  await Bun.write(join(home, ".claude/commands/deploy.md"), "Deploy the app.\n\nMore.\n");
  await skill(join(home, "shared/notes"), "name: notes\ndescription: Take notes");
  await mkdir(join(home, ".agents/skills"), { recursive: true });
  await symlink(join(home, "shared/notes"), join(home, ".agents/skills/notes"));
  await symlink(join(home, "shared/notes"), join(home, ".claude/skills/notes"));
  await skill(join(home, ".codex/skills/.system/plan"), "name: plan\ndescription: Plan work");
  await skill(join(home, "shared/app-skills/app-only"), "name: app-only\ndescription: App task");
  await mkdir(join(repo, ".claude"), { recursive: true });
  await symlink(join(home, "shared/app-skills"), join(repo, ".claude/skills"));
  await skill(join(repo, ".agents/skills/repo-skill"), "name: repo-skill\ndescription: Repo task");
  await Bun.write(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: { figma: { type: "http", url: "https://mcp.example.com/mcp?token=SECRET" } },
      projects: {
        [repo]: {
          mcpServers: {
            db: {
              command: "/usr/bin/db-mcp",
              args: ["--password", "SECRET"],
              env: { PW: "SECRET" },
            },
          },
        },
      },
    }),
  );
  await Bun.write(
    join(repo, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        tickets: { command: "npx", args: ["tickets", "SECRET"] },
      },
    }),
  );
  await Bun.write(
    join(home, ".claude/settings.json"),
    JSON.stringify({ enabledMcpjsonServers: ["linear"] }),
  );
  await Bun.write(
    join(home, ".codex/config.toml"),
    [
      "[mcp_servers.docs]",
      'url = "https://docs.example.com/mcp"',
      'bearer_token_env_var = "SECRET"',
      "[mcp_servers.old]",
      'command = "old-mcp"',
      "enabled = false",
      `[projects."${repo}"]`,
      'trust_level = "trusted"',
    ].join("\n"),
  );
  await Bun.write(
    join(repo, ".codex/config.toml"),
    '[mcp_servers.local]\ncommand = "node"\nargs = ["SECRET"]\n',
  );
  await Bun.write(
    join(home, ".claude/projects/s/one.jsonl"),
    JSON.stringify({ type: "user", cwd: worktree, message: { content: "hi" } }) + "\n",
  );
  await codexSession(join(home, ".codex/sessions/2026/10/20"), "c", repo);

  const earlier = new Date(Date.now() - 86_400_000);
  await utimes(join(home, ".claude/projects/s/one.jsonl"), earlier, earlier);

  const { stdout, code } = await quench(home, "profile");
  expect(code).toBe(0);
  expect(stdout).toContain(
    [
      "  Agent        Sessions  Skills        MCP  Home",
      "  Claude Code         1  3 · 59 chars    1  ~/.claude",
      "  Codex               1  2 · 28 chars    2  ~/.codex",
      "  Pi                  —  —               —  ~/.pi/agent not found; set --pi-home",
    ].join("\n"),
  );
  expect(stdout).toContain(
    [
      "MCP servers · configured on disk now · tool definitions not counted",
      "  Server   Agent        Scope    Transport  Target            State           Where",
      "  figma    Claude Code  user     http       mcp.example.com   on              all projects",
      "  docs     Codex        user     http       docs.example.com  on              all projects",
      "  old      Codex        user     stdio      old-mcp           off             all projects",
      "  linear   Claude Code  project  http       mcp.linear.app    on              app",
      "  tickets  Claude Code  project  stdio      npx               needs approval  app",
      "  db       Claude Code  local    stdio      db-mcp            on              app",
      "  local    Codex        project  stdio      node              on              app",
    ].join("\n"),
  );
  const raw = (await quench(home, "--json")).stdout;
  expect(raw).not.toContain("SECRET");
  const out = JSON.parse(raw);
  const where = (skills: { name: string; sources: { harness: string; scope: string }[] }[]) =>
    skills.map((s) => [s.name, s.sources.map((x) => `${x.harness}:${x.scope}`)]);
  expect(where(out.globalSkills)).toEqual([
    ["notes", ["claude-code:user", "codex:user", "pi:user"]],
    ["release", ["claude-code:user"]],
    ["review", ["claude-code:user"]],
    ["deploy", ["claude-code:user"]],
    ["plan", ["codex:system"]],
  ]);
  expect(out.globalSkills.find((s: { name: string }) => s.name === "release").modelInvocable).toBe(
    false,
  );
  expect(where(out.projects[0].skills)).toEqual([
    ["app-only", ["claude-code:project"]],
    ["repo-skill", ["codex:project", "pi:project"]],
  ]);
  const inWorktree = await skillInventory(new Home(home), worktree);
  expect(
    inWorktree.skills
      .filter((s) => s.sources.some((x) => x.scope === "project"))
      .map((s) => [s.name, s.sources.map((x) => `${x.harness}:${x.scope}`)]),
  ).toEqual([["app-only", ["claude-code:project"]]]);
});

test("profile shows which recorded skills sessions listed and used", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-skilluse-")));
  const project = join(home, "work");
  await mkdir(project, { recursive: true });
  const lines = (records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const listing = (names: string[]) => ({
    type: "attachment",
    cwd: project,
    attachment: {
      type: "skill_listing",
      names,
      content: names.map((n) => `- ${n}: does ${n}`).join("\n"),
    },
  });
  const skillCall = (skill: string) => ({
    type: "assistant",
    cwd: project,
    message: { content: [{ type: "tool_use", id: skill, name: "Skill", input: { skill } }] },
  });
  const command = (name: string) => ({
    type: "user",
    cwd: project,
    message: { content: `<command-name>/${name}</command-name>\n<command-args></command-args>` },
  });
  await Bun.write(
    join(home, ".claude/projects/p/one.jsonl"),
    lines([listing(["review", "deploy", "notes"]), skillCall("review"), command("compact")]),
  );
  await Bun.write(
    join(home, ".claude/projects/p/two.jsonl"),
    lines([listing(["review", "deploy", "notes"]), command("deploy"), skillCall("review")]),
  );
  await Bun.write(join(home, ".claude/projects/p/three.jsonl"), lines([command("review")]));
  const block = [
    "<skills_instructions>",
    "## Skills",
    "### Skill roots",
    `- \`r0\` = \`${home}/.agents/skills\``,
    "### Available skills",
    "- notes: Take notes (file: r0/notes/SKILL.md)",
    "- figma:figma-use: Use Figma (file: r0/figma-use/SKILL.md)",
    "</skills_instructions>",
  ].join("\n");
  await Bun.write(
    join(home, ".codex/sessions/2026/10/20/c.jsonl"),
    lines([
      { type: "session_meta", payload: { id: "c", cwd: project } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: block }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "x",
          input: `text(await tools.exec_command({cmd:"sed -n '1,80p' ${home}/.agents/skills/notes/SKILL.md"}))`,
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "y",
          input: 'text(await tools.exec_command({cmd:"cat figma-use/SKILL.md"}))',
        },
      },
    ]),
  );
  const piSkills = `<available_skills>\n  <skill>\n    <name>notes</name>\n    <description>Take notes</description>\n    <location>${home}/.agents/skills/notes/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>plan</name>\n    <description>Plan</description>\n    <location>${home}/.pi/agent/skills/plan/SKILL.md</location>\n  </skill>\n</available_skills>`;
  await Bun.write(
    join(home, ".pi/agent/sessions/x/p.jsonl"),
    lines([
      { type: "session", id: "p", cwd: project },
      { type: "message", message: { role: "system", content: "", sections: { skills: piSkills } } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "r",
              name: "read",
              arguments: { path: `${home}/.agents/skills/notes/SKILL.md` },
            },
          ],
        },
      },
    ]),
  );

  const { stdout, code } = await quench(home, "profile");
  expect(code).toBe(0);
  expect(stdout).toContain(
    [
      "Recorded skills · what session histories listed and used · last 30 days",
      "  Agent        Sessions  Listed  Listing size  Used  Never used",
      "  Claude Code         2       3      63 chars     2           1",
      "  Codex               1       2     207 chars     1           1",
      "  Pi                  1       2     370 chars     1           1",
      "  Most used · Claude Code: review 2, deploy 1",
      "  Listed, never used · Claude Code: notes",
      "  Most used · Codex: notes 1",
      "  Listed, never used · Codex: figma:figma-use",
      "  Most used · Pi: notes 1",
      "  Listed, never used · Pi: plan",
    ].join("\n"),
  );
  const out = JSON.parse((await quench(home, "--json")).stdout);
  const byHarness = Object.fromEntries(
    out.recordedSkills.map((u: { harness: string; skills: object[] }) => [u.harness, u.skills]),
  );
  expect(byHarness["claude-code"]).toEqual([
    { name: "review", listedIn: 2, usedIn: 2, byUser: 0 },
    { name: "deploy", listedIn: 2, usedIn: 1, byUser: 1 },
    { name: "notes", listedIn: 2, usedIn: 0, byUser: 0 },
  ]);
  expect(byHarness.codex).toEqual([
    { name: "notes", listedIn: 1, usedIn: 1, byUser: 0 },
    { name: "figma:figma-use", listedIn: 1, usedIn: 0, byUser: 0 },
  ]);
});

test("profile lists MCP servers sessions called and whether local config has them", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-mcpuse-")));
  const project = join(home, "work");
  await mkdir(project, { recursive: true });
  const lines = (records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await Bun.write(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://mcp.example.com" } } }),
  );
  await Bun.write(
    join(home, ".codex/config.toml"),
    '[mcp_servers.docs-site]\nurl = "https://docs.example.com/mcp"\n',
  );
  const call = (id: string, name: string) => ({
    type: "assistant",
    cwd: project,
    message: { content: [{ type: "tool_use", id, name, input: {} }] },
  });
  await Bun.write(
    join(home, ".claude/projects/p/one.jsonl"),
    lines([
      call("a", "mcp__figma__get_design"),
      call("a", "mcp__figma__get_design"),
      call("b", "mcp__figma__get_screenshot"),
      call("c", "mcp__claude_ai_Drive__search"),
      call("d", "Read"),
    ]),
  );
  await Bun.write(
    join(home, ".codex/sessions/2026/10/20/c.jsonl"),
    lines([
      { type: "session_meta", payload: { id: "c", cwd: project } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "x",
          input:
            "await tools.mcp__docs_site__search({q:1}); await tools.mcp__codex_apps__drive_list({}); const n = 'tools.mcp__unused__tool';",
        },
      },
    ]),
  );

  const { stdout, code } = await quench(home, "profile");
  expect(code).toBe(0);
  expect(stdout).toContain(
    [
      "MCP servers called · from session history · last 30 days",
      "  Server           Agent        Sessions  Calls  In local config",
      "  figma            Claude Code         1      2  yes",
      "  claude_ai_Drive  Claude Code         1      1  no",
      "  codex_apps       Codex               1      1  no",
      "  docs_site        Codex               1      1  yes",
      "  Not in local config: an account connector (claude.ai, ChatGPT apps), a plugin, a server the host app passed in, or config since removed.",
    ].join("\n"),
  );
});

test("profile lists failures that repeat in a project, by kind and what failed", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-failures-")));
  const project = join(home, "work");
  await mkdir(project, { recursive: true });
  const lines = (records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const call = (id: string, name: string, input: object) => ({
    type: "assistant",
    cwd: project,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const result = (id: string, content: string, isError = true) => ({
    type: "user",
    cwd: project,
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  });
  const missingRead = (id: string) => [
    call(id, "Read", { file_path: join(project, "docs/setup.md") }),
    result(id, "File does not exist."),
  ];
  await Bun.write(
    join(home, ".claude/projects/p/one.jsonl"),
    lines([
      ...missingRead("r1"),
      ...missingRead("r2"),
      call("g", "Bash", { command: "grep -n needle src/a.ts" }),
      result("g", "Exit code 1"),
      call("c", "Bash", { command: "git status && npm test" }),
      result("c", "Exit code 1\nnpm error Missing script: test"),
      ...[1, 2, 3].flatMap((n) => [
        call(`h${n}`, "Bash", { command: "git push --force" }),
        result(
          `h${n}`,
          "PreToolUse:Bash hook error: [/hooks/guard.sh]: guard: blocked — force push.",
        ),
      ]),
    ]),
  );
  await Bun.write(join(home, ".claude/projects/p/two.jsonl"), lines(missingRead("r3")));
  const codex = (id: string) =>
    Bun.write(
      join(home, `.codex/sessions/2026/10/20/${id}.jsonl`),
      lines([
        { type: "session_meta", payload: { id, cwd: project } },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "x",
            input:
              'const r = await tools.exec_command({cmd:"pytest -q"}); text(JSON.stringify(r));',
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "x",
            output: [
              { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
              {
                type: "input_text",
                text: '{"exit_code":127,"output":"zsh:1: command not found: pytest"}',
              },
            ],
          },
        },
      ]),
    );
  await codex("c1");
  await codex("c2");

  const { stdout, code } = await quench(home, "profile");
  expect(code).toBe(0);
  expect(stdout).toContain(
    [
      "Repeated failures · tool calls that failed the same way · last 30 days",
      "  Project  Kind             What                         Failures  Sessions  In a row     Output  Agents",
      "  work     rejected         guard: blocked — force push         3         1         3  225 chars  Claude Code",
      "  work     no such file     docs/setup.md                       3         2         2   60 chars  Claude Code",
      "  work     no such command  pytest                              2         2         1  218 chars  Codex",
      "  9 failed tool calls in all, returning 545 chars of output.",
    ].join("\n"),
  );
  expect(stdout).not.toContain("grep");
  expect(stdout).not.toContain("npm");
  const json = JSON.parse((await quench(home, "--json")).stdout);
  expect(json.recordedFailures.failures).toBe(9);
  const section = await quench(home, "profile", "failures");
  expect(section.stdout.split("\n")[0]).toBe(
    "Repeated failures · tool calls that failed the same way · last 30 days",
  );
  expect(section.stdout).not.toContain("Projects ·");
  expect((await quench(home)).stdout).toContain(
    [
      "Worth a look",
      '  • In work, "guard: blocked — force push" failed 3 times across 1',
      "    session.",
      "    → quench profile failures",
    ].join("\n"),
  );
  const unknown = await quench(home, "profile", "nope");
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('unknown section "nope"');
});
