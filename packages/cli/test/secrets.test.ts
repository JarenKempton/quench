import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "../src/main.ts");

const FAKE = {
  github: "ghp_" + "FakeQuenchTestValue0123456789abcdefg",
  npm: "npm_" + "FakeQuenchTestValue0123456789abcdefg",
  mcp: "ghp_" + "FakeQuenchMcpValue0123456789abcdefgh",
  skill: "ghp_" + "FakeQuenchSkillValue0123456789abcdef",
  sshpass: "Fake#Pw42x",
  mysql: "FakePw_2026",
  pypi: "Quench-fake-pass-42",
};

const SPACED = [
  'mysql -p "Spaced Secret99" -e "select 1"',
  "mysqldump --password 'Long Pass Phrase 1' db",
  "psql postgresql://u:PgUrlPw9@h/db",
  "redis-cli -h cache -a RedisPw_31 ping",
  "htpasswd -b .htpasswd admin HtPw_4411",
];

const PROBES = [
  FAKE.sshpass,
  FAKE.mysql,
  "Spaced Secret99",
  "Long Pass Phrase 1",
  "PgUrlPw9",
  "RedisPw_31",
  "HtPw_4411",
];

const line = (value: unknown) => JSON.stringify(value);

async function fakeHome() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-secrets-")));
  const project = join(home, "repo");
  const claude = join(home, ".claude");
  await mkdir(join(project, ".github/workflows"), { recursive: true });
  await Bun.spawn(["git", "init", "-q", project]).exited;
  await Bun.write(join(project, ".env"), `GITHUB_TOKEN=${FAKE.github}\n`);
  await Bun.write(
    join(project, ".mcp.json"),
    line({ mcpServers: { gh: { command: "gh-mcp", env: { GITHUB_TOKEN: FAKE.mcp } } } }),
  );
  await Bun.spawn(["git", "-C", project, "add", ".mcp.json"]).exited;
  await Bun.write(
    join(project, ".github/workflows/sync.yml"),
    "on: push\njobs:\n  a:\n    steps:\n      - run: echo '${{ toJSON(secrets) }}' > s.json\n",
  );
  await Bun.write(
    join(project, "node_modules/left-pad/package.json"),
    line({ name: "left-pad", scripts: { postinstall: "node bundle.js" } }),
  );
  await Bun.write(
    join(project, "node_modules/fresh-dep/package.json"),
    line({ name: "fresh-dep", scripts: { preinstall: "node scripts/setup.js" } }),
  );
  await Bun.write(join(home, ".pypirc"), `[pypi]\npassword = ${FAKE.pypi}\n`);
  await Bun.write(
    join(claude, "settings.json"),
    line({ permissions: { defaultMode: "bypassPermissions", allow: ["Bash", "mcp__gh"] } }),
  );
  await Bun.write(
    join(claude, "skills/deploy/SKILL.md"),
    `---\nname: deploy\n---\nUse ${FAKE.skill}\n`,
  );
  await Bun.write(join(home, ".codex/config.toml"), 'approval_policy = "never"\n');
  await Bun.write(join(home, ".npmrc"), `//registry.npmjs.org/:_authToken=${FAKE.npm}\n`);
  await chmod(join(home, ".npmrc"), 0o644);
  await Bun.write(
    join(claude, "projects/-repo/s1.jsonl"),
    [
      line({
        type: "user",
        timestamp: "2026-10-01T10:00:00Z",
        cwd: project,
        sessionId: "s1",
        message: { role: "user", content: "check the env" },
      }),
      line({
        type: "assistant",
        timestamp: "2026-10-01T10:00:05Z",
        message: {
          id: "m1",
          model: "claude-opus-5-5",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat .env ~/.npmrc" } },
            {
              type: "tool_use",
              id: "t2",
              name: "Bash",
              input: { command: `sshpass -p '${FAKE.sshpass}' ssh deploy@host cat .pypirc` },
            },
            {
              type: "tool_use",
              id: "t3",
              name: "Bash",
              input: { command: `mysql -p${FAKE.mysql} -e "select 1"` },
            },
            ...SPACED.map((command, i) => ({
              type: "tool_use",
              id: `p${i}`,
              name: "Bash",
              input: { command },
            })),
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      line({
        type: "user",
        timestamp: "2026-10-01T10:00:06Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: `GITHUB_TOKEN=${FAKE.github}\n//registry.npmjs.org/:_authToken=${FAKE.npm}`,
            },
            { type: "tool_result", tool_use_id: "t2", content: `password = ${FAKE.pypi}` },
            { type: "tool_result", tool_use_id: "t3", content: "1" },
            ...SPACED.map((_, i) => ({
              type: "tool_result",
              tool_use_id: `p${i}`,
              content: `password = QuenchFakePass${i}_x9Zq`,
            })),
          ],
        },
      }),
    ].join("\n") + "\n",
  );
  return { home, project };
}

async function run(home: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", main, "secrets", "--no-host-history", ...args], {
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, code };
}

const neverRaw = (output: string) => {
  for (const value of Object.values(FAKE)) expect(output).not.toContain(value.slice(4, 16));
  for (const probe of PROBES) expect(output).not.toContain(probe);
};

test("secrets reports history, configs, permissions, files and footprints without raw values", async () => {
  const { home, project } = await fakeHome();
  const { stdout, code } = await run(home, "--json");
  expect(code).toBe(0);
  neverRaw(stdout);
  const report = JSON.parse(stdout);

  const exposed = report.history.secrets.map((s: Record<string, unknown>) => [
    s.provider,
    s.sessions,
    s.firstSeen,
    (s.exposures as { by: string }[])[0]!.by,
  ]);
  expect(exposed).toEqual([
    ["github", 1, "2026-10-01T10:00:06.000Z", "Bash: cat .env ~/.npmrc"],
    ["npm", 1, "2026-10-01T10:00:06.000Z", "Bash: cat .env ~/.npmrc"],
  ]);
  expect(report.history.secrets[0].rotate).toBe("https://github.com/settings/tokens");
  const shown = report.history.lowConfidence.map(
    (s: { exposures: { by: string }[] }) => s.exposures[0]!.by,
  );
  for (const command of [
    'mysql -p "Spac…',
    "--password 'Long…",
    "u:PgUr…",
    "-a Redi…",
    "admin HtPw…",
  ])
    expect(shown.some((by: string) => by.includes(command))).toBe(true);
  expect(
    report.history.lowConfidence
      .filter((s: { exposures: { by: string }[] }) => s.exposures[0]!.by.includes("sshpass"))
      .map((s: Record<string, unknown>) => [
        s.rule,
        s.rotate,
        (s.exposures as { by: string }[])[0]!.by,
      ]),
  ).toEqual([
    ["secret-named-value", null, expect.stringMatching(/^Bash: sshpass -p 'Fake…[0-9a-f]{8}' ssh/)],
  ]);

  const mcp = report.configs.find((f: { path: string }) => f.path === join(project, ".mcp.json"));
  expect(mcp.tracked).toBe(true);
  expect(mcp.secrets.map((s: { provider: string }) => s.provider)).toEqual(["github"]);

  expect(
    report.permissions.map((p: Record<string, string>) => [p.harness, p.kind, p.setting]),
  ).toEqual([
    ["claude-code", "bypass", "permissions.defaultMode = bypassPermissions"],
    ["claude-code", "wildcard-shell", "permissions.allow Bash"],
    ["claude-code", "auto-approved-mcp", "permissions.allow mcp__gh"],
    ["codex", "bypass", "approval_policy = never"],
  ]);

  expect(report.instructions.files.map((f: { kind: string }) => f.kind)).toEqual(["skill"]);

  const file = (path: string) =>
    report.credentialFiles.find((f: { path: string }) => f.path === path);
  expect(file(join(home, ".npmrc"))).toMatchObject({
    present: true,
    plaintext: true,
    readInSessions: 1,
    printedInSessions: true,
    ...(process.platform === "win32" ? {} : { mode: "644", othersCanRead: true }),
  });
  expect(file(join(project, ".env"))).toMatchObject({ plaintext: true, printedInSessions: true });
  expect(file(join(home, ".aws/credentials"))).toMatchObject({ present: false });
  expect(file(join(home, ".pypirc"))).toMatchObject({ plaintext: true, printedInSessions: true });

  expect(report.footprints.map((f: { reason: string }) => f.reason).sort()).toEqual([
    "dumps every repository secret with toJSON(secrets)",
    "postinstall runs bundle.js, the Shai-Hulud payload",
    "preinstall added in the last 30 days: node scripts/setup.js",
  ]);
});

test("secrets text output masks every value", async () => {
  const { home } = await fakeHome();
  const { stdout, code } = await run(home);
  expect(code).toBe(0);
  neverRaw(stdout);
  expect(stdout).toContain("ghp_…");
  expect(stdout).toContain("https://github.com/settings/tokens");
});
