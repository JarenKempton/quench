import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "../src/main.ts");

const run = (home: string, ...args: string[]) => runWithEnv(home, args);

async function runWithEnv(home: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", main, "steering", ...args], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, "claude-config"),
      CODEX_HOME: join(home, "codex-config"),
      PI_CODING_AGENT_DIR: join(home, "pi-config"),
      TYPESAFE_API_KEY: "must-not-be-used",
      TYPESAFE_BASE_URL: "http://127.0.0.1:1",
      ...env,
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

async function entries(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    result.push(path);
    if (entry.isDirectory()) result.push(...(await entries(path)));
  }
  return result.sort();
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "quench-steering-"));
  const project = join(home, "repo");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, "src"));
  return { home, project };
}

test("steering inventories current files offline, deduplicates content and retains rule locations", async () => {
  const { home, project } = await fixture();
  const path = join(project, "AGENTS.md");
  const text =
    "---\npaths: src/**\n---\n# Checks\n\n- Run the real check.\n  Keep its output.\n\nExplain failures\nwithout claiming success.\n\n```sh\n- not a rule\n```\n";
  await Bun.write(path, text);
  await symlink("AGENTS.md", join(project, "CLAUDE.md"));
  await Bun.write(join(project, "src/AGENTS.md"), text);
  await Bun.write(join(home, "claude-config/CLAUDE.md"), "Use concise replies.\n");
  await Bun.write(join(home, "codex-config/AGENTS.override.md"), "Use concise replies.\n");
  await Bun.write(join(home, "pi-config/AGENTS.md"), "Use concise replies.\n");
  await Bun.write(join(home, "AGENTS.md"), "Ancestor guidance.\n");
  const rules = join(project, ".claude/rules");
  await mkdir(join(rules, "nested"), { recursive: true });
  await Bun.write(join(rules, "nested/checks.md"), "# Local\n\n1. Report the actual result.\n");
  await symlink(rules, join(rules, "nested/cycle"));
  await Bun.write(join(project, "src/unrecognized.md"), "Do not discover me.\n");
  const before = await entries(home);
  const result = await run(home, join(project, "src"), "--json");
  expect(result.code).toBe(0);
  const out = JSON.parse(result.stdout);
  expect(out.project).toBe(join(project, "src"));
  expect(out.evidence).toBe("current-disk");
  expect(out.historicalLoad).toBe("unknown");
  const file = out.files.find((f: { bytes: number }) => f.bytes === Buffer.byteLength(text));
  expect(file.id).toMatch(/^[a-f0-9]{64}$/);
  expect(file.rules).toEqual([
    { startLine: 6, endLine: 7, text: "- Run the real check.\n  Keep its output." },
    { startLine: 9, endLine: 10, text: "Explain failures\nwithout claiming success." },
  ]);
  expect(file.sources).toContainEqual({
    harness: "claude-code",
    path: join(project, "CLAUDE.md"),
    realPath: path,
    scope: "ancestor",
  });
  expect(file.sources.filter((s: { harness: string }) => s.harness === "codex")).toHaveLength(2);
  expect(file.sources.some((s: { path: string }) => s.path.includes("src/AGENTS.md"))).toBe(true);
  const globals = out.files.find(
    (f: { rules: { text: string }[] }) => f.rules[0]?.text === "Use concise replies.",
  );
  expect(globals.sources.map((s: { harness: string }) => s.harness).sort()).toEqual([
    "claude-code",
    "codex",
    "pi",
  ]);
  const ancestor = out.files.find(
    (f: { rules: { text: string }[] }) => f.rules[0]?.text === "Ancestor guidance.",
  );
  expect(ancestor.sources.map((s: { harness: string }) => s.harness).sort()).toEqual([
    "claude-code",
    "pi",
  ]);
  expect(
    out.files.some((f: { rules: { text: string }[] }) => f.rules[0]?.text.includes("not a rule")),
  ).toBe(false);
  expect(out.limitations.join(" ")).toContain("not proof");
  expect(out.warnings.join(" ")).toContain("cycle");
  expect(await entries(home)).toEqual(before);
  expect(await Bun.file(path).text()).toBe(text);
  const rendered = await run(home, join(project, "src"));
  expect(rendered.code).toBe(0);
  expect(rendered.stdout).toContain("Current steering inventory");
  expect(rendered.stdout).toContain(`${path}:6-7`);
  expect(rendered.stdout).toContain("historical loading: unknown");
});

test("steering requires an explicit existing directory and does not crawl descendants", async () => {
  const { home, project } = await fixture();
  await Bun.write(join(project, "src/AGENTS.md"), "Nested only.\n");
  expect((await run(home)).stderr).toContain("project directory");
  expect((await run(home, join(home, "missing"))).code).toBe(1);
  expect((await run(home, join(project, "src/AGENTS.md"))).code).toBe(1);
  expect((await run(home, project, "extra")).code).toBe(1);
  const result = await run(home, project, "--json");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).files).toEqual([]);
});

test.each([
  ["leading separator", "---\n\n- Run tests.\n", ["- Run tests."]],
  [
    "inline backticks",
    "```bun test```\n\n- Report the result.\n",
    ["```bun test```", "- Report the result."],
  ],
  [
    "nested fence",
    "- Run checks.\n\n    ```sh\n    echo example\n    ```\n\n- Report the result.\n",
    ["- Run checks.", "- Report the result."],
  ],
  [
    "quoted fence",
    "> ```sh\n> echo example\n> ```\n\n- Report the result.\n",
    ["- Report the result."],
  ],
  ["setext heading", "Checks\n======\n\n- Run tests.\n", ["- Run tests."]],
])("steering parser review: %s", async (_name, text, expected) => {
  const { home, project } = await fixture();
  await Bun.write(join(project, "AGENTS.md"), text as string);
  const result = await run(home, project, "--json");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).files[0].rules.map((r: { text: string }) => r.text)).toEqual(
    expected,
  );
});

test("steering review: repeated user/ancestor rule roots do not exhaust directory coverage", async () => {
  const { home, project } = await fixture();
  const userRules = join(home, ".claude/rules");
  for (let i = 0; i < 128; i++) await mkdir(join(userRules, String(i)), { recursive: true });
  await Bun.write(join(userRules, "shared.md"), "- Global guidance.\n");
  await Bun.write(join(project, ".claude/rules/checks.md"), "- Run tests.\n");
  const result = await runWithEnv(home, [project, "--json"], {
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
  });
  expect(result.code).toBe(0);
  const out = JSON.parse(result.stdout);
  expect(out.files).toHaveLength(2);
  const shared = out.files.find(
    (file: { rules: { text: string }[] }) => file.rules[0]?.text === "- Global guidance.",
  );
  expect(shared.sources.map((source: { scope: string }) => source.scope).sort()).toEqual([
    "ancestor",
    "user",
  ]);
  expect(out.warnings).toEqual([]);
});

test("steering review: dangling instruction symlinks warn instead of silently disappearing", async () => {
  const { home, project } = await fixture();
  await symlink("missing.md", join(project, "CLAUDE.md"));
  const result = await run(home, project, "--json");
  expect(result.code).toBe(0);
  const out = JSON.parse(result.stdout);
  expect(out.files).toEqual([]);
  expect(out.warnings.join(" ")).toContain(join(project, "CLAUDE.md"));
});

test("content identity survives separate worktree paths and oversized files are visibly skipped", async () => {
  const { home, project } = await fixture();
  const second = join(home, "worktree");
  await mkdir(second);
  await Bun.write(join(second, ".git"), "gitdir: ../repo/.git/worktrees/worktree\n");
  for (const dir of [project, second])
    await Bun.write(join(dir, "AGENTS.md"), "- Keep scope small.\n");
  const a = JSON.parse((await run(home, project, "--json")).stdout);
  const b = JSON.parse((await run(home, second, "--json")).stdout);
  expect(a.files[0].id).toBe(b.files[0].id);
  expect(a.files[0].sources[0].path).not.toBe(b.files[0].sources[0].path);
  await Bun.write(join(project, "CLAUDE.md"), "x".repeat(262145));
  const bounded = JSON.parse((await run(home, project, "--json")).stdout);
  expect(bounded.warnings.join(" ")).toContain("262144");
  expect(bounded.files).toHaveLength(1);
});

test("steering preserves instructions around Markdown separators and code examples", async () => {
  const { home, project } = await fixture();
  const cases = [
    ["---\n\n- Run tests.\n", ["- Run tests."]],
    ["---\n\n- Run tests.\n\n---\n", ["- Run tests."]],
    ["```bun test```\n\n- Report the result.\n", ["```bun test```", "- Report the result."]],
    [
      "- Validate:\n\n    ```sh\n    example only\n    ```\n\n- Report.\n",
      ["- Validate:", "- Report."],
    ],
    ["> ```sh\n> - example only\n> ```\n\n- Report.\n", ["- Report."]],
    ["Checks\n======\n\n- Run tests.\n", ["- Run tests."]],
    ["Checks\n------\n\n- Run tests.\n", ["- Run tests."]],
  ] as const;
  for (const [text, expected] of cases) {
    await Bun.write(join(project, "AGENTS.md"), text);
    const result = await run(home, project, "--json");
    expect(result.code).toBe(0);
    const file = JSON.parse(result.stdout).files[0];
    expect(file.rules.map((rule: { text: string }) => rule.text)).toEqual(expected);
    for (const rule of file.rules)
      expect(
        text
          .split("\n")
          .slice(rule.startLine - 1, rule.endLine)
          .join("\n"),
      ).toBe(rule.text);
  }
});

test("steering reuses aliased rule directories and warns about broken instruction links", async () => {
  const { home, project } = await fixture();
  const globalRules = join(home, "claude-config/rules");
  await mkdir(globalRules, { recursive: true });
  await mkdir(join(home, ".claude"));
  await symlink(globalRules, join(home, ".claude/rules"));
  for (let i = 0; i < 128; i++) await mkdir(join(globalRules, `dir${i}`));
  await Bun.write(join(globalRules, "shared.md"), "- Global guidance.\n");
  await Bun.write(join(project, ".claude/rules/checks.md"), "- Run project tests.\n");
  await symlink("missing.md", join(project, "CLAUDE.md"));
  const result = await run(home, project, "--json");
  expect(result.code).toBe(0);
  const out = JSON.parse(result.stdout);
  expect(
    out.files.flatMap((file: { rules: { text: string }[] }) => file.rules.map((rule) => rule.text)),
  ).toContain("- Run project tests.");
  const shared = out.files.find(
    (file: { rules: { text: string }[] }) => file.rules[0]?.text === "- Global guidance.",
  );
  expect(shared.sources.map((source: { scope: string }) => source.scope).sort()).toEqual([
    "ancestor",
    "user",
  ]);
  expect(out.warnings.join(" ")).not.toContain("limit");
  expect(out.warnings.join(" ")).toContain(join(project, "CLAUDE.md"));
});
