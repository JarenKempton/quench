import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliRunsTimeout } from "./run.ts";

const main = join(import.meta.dir, "../src/main.ts");

const run = (home: string, ...args: string[]) => runWithEnv(home, args);

async function runWithEnv(home: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", main, "steering", ...args], {
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
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
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-steering-")));
  const project = join(home, "repo");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, "src"));
  return { home, project };
}

test(
  "steering inventories current files offline, deduplicates content and retains rule locations",
  async () => {
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
    expect(
      file.sources.some((s: { path: string }) => s.path.includes(join("src", "AGENTS.md"))),
    ).toBe(true);
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
    expect(rendered.stdout).toContain("ranked by characters × sessions loaded");
    expect(rendered.stdout).not.toContain("    - Run the real check.");
    expect(rendered.stdout).toContain("--rules");
    const listed = await run(home, join(project, "src"), "--rules");
    expect(listed.stdout).toContain(`${path}:6-7`);
    expect(listed.stdout).toContain("    - Run the real check.");
    expect(await entries(home)).toEqual(before);
  },
  cliRunsTimeout,
);

const claudeSession = (home: string, id: string, cwd: string, files: [string, string][]) =>
  Bun.write(
    join(home, "claude-config/projects/sessions", `${id}.jsonl`),
    [
      { type: "user", timestamp: "2026-10-20T10:00:00Z", cwd, message: { content: "hi" } },
      {
        type: "attachment",
        timestamp: "2026-10-20T10:00:00Z",
        cwd,
        attachment: {
          type: "instructions",
          files: files.map(([path, content]) => ({ path, type: "Project", content })),
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );

test(
  "steering ranks instruction items, auto memory included, by characters × sessions loaded",
  async () => {
    const { home, project } = await fixture();
    const global = join(home, "claude-config/CLAUDE.md");
    const local = join(project, "CLAUDE.md");
    const memory = join(
      home,
      "claude-config/projects",
      project.replace(/[^A-Za-z0-9]/g, "-"),
      "memory/MEMORY.md",
    );
    const texts = {
      global: "- Be brief.",
      local: "- Run the tests.",
      memory: `- ${"m".repeat(200)}`,
    };
    await Bun.write(global, `${texts.global}\n`);
    await Bun.write(local, `${texts.local}\n`);
    await Bun.write(memory, `${texts.memory}\n`);
    await Bun.write(join(project, "src/topic.md"), "not loaded\n");
    await claudeSession(home, "a", project, [
      [global, texts.global],
      [local, texts.local],
      [memory, texts.memory],
    ]);
    await claudeSession(home, "b", join(project, "src"), [
      [global, texts.global],
      [memory, texts.memory],
    ]);
    await claudeSession(home, "c", join(home, "elsewhere"), [[global, texts.global]]);
    const out = JSON.parse((await run(home, project, "--json")).stdout);
    expect(
      out.ranked.map(
        (r: { path: string; scope: string; sessions: number; loadedChars: number }) => [
          r.path,
          r.scope,
          r.sessions,
          r.loadedChars,
        ],
      ),
    ).toEqual([
      [memory, "project", 2, 2 * texts.memory.length],
      [global, "global", 2, 2 * texts.global.length],
      [local, "project", 1, texts.local.length],
    ]);
    expect(out.coverage).toEqual({ sessions: 2, unrecorded: 0, combinedOnly: 0 });
    const text = (await run(home, project)).stdout;
    const rows = text.split("\n").filter((line) => /not recorded|chars\s*$/.test(line));
    expect(rows[0]).toContain("auto memory · MEMORY.md");
    expect(rows[0]).toMatch(/\s2\s+404 chars$/);
  },
  cliRunsTimeout,
);

test(
  "steering flags duplicate rules, global vs project conflicts and stale names as heuristics",
  async () => {
    const { home, project } = await fixture();
    const global = join(home, "claude-config/CLAUDE.md");
    const local = join(project, "CLAUDE.md");
    await Bun.write(
      global,
      "- Keep replies short and lead with the answer.\n- Never run `git push --force` on main.\n- Read `~/notes/gone.md` first.\n- Generic `AGENTS.md` files own code style.\n",
    );
    await Bun.write(
      local,
      "- Keep replies short, and lead with the answer!\n- Always run `git push --force` on main.\n- See `docs/gone.md` and `README.md`.\n- Run `quench-missing-tool-xyz check` first.\n- Run `bun run nope`, then `bun run test`.\n",
    );
    await Bun.write(join(project, "README.md"), "# Readme\n");
    await Bun.write(
      join(project, "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } }),
    );
    const out = JSON.parse((await run(home, project, "--json")).stdout);
    expect(
      out.duplicates.map((group: { path: string; startLine: number }[]) =>
        group.map((rule) => [rule.path, rule.startLine]),
      ),
    ).toEqual([
      [
        [global, 1],
        [local, 1],
      ],
    ]);
    expect(
      out.conflicts.map((c: { global: { startLine: number }; project: { startLine: number } }) => [
        c.global.startLine,
        c.project.startLine,
      ]),
    ).toEqual([[2, 2]]);
    expect(
      out.stale.map((rule: { path: string; startLine: number; missing: object[] }) => [
        rule.path,
        rule.startLine,
        rule.missing,
      ]),
    ).toEqual([
      [global, 3, [{ name: "~/notes/gone.md", kind: "file" }]],
      [local, 3, [{ name: "docs/gone.md", kind: "file" }]],
      [local, 4, [{ name: "quench-missing-tool-xyz", kind: "command" }]],
      [local, 5, [{ name: "bun run nope", kind: "script" }]],
    ]);
    const text = (await run(home, project)).stdout;
    expect(text).toContain("Duplicate rules across files (1)");
    expect(text).toContain(`${join("~", "claude-config", "CLAUDE.md")}:1-1`);
    expect(text).toContain(`${join("~", "repo", "CLAUDE.md")}:1-1`);
    expect(text).toContain("Possible conflicts, global vs project · heuristic (1)");
    expect(text).toContain("Possibly stale · heuristic (4)");
    expect(text).toContain("command `quench-missing-tool-xyz` not found");
  },
  cliRunsTimeout,
);

test(
  "steering lists a file once when another candidate name differs only by case",
  async () => {
    const { home, project } = await fixture();
    await Bun.write(join(project, "AGENTS.md"), "- Run tests.\n");
    await symlink("AGENTS.md", join(project, "AGENTS.MD")).catch(() => {});
    const result = await run(home, project, "--json");
    expect(result.code).toBe(0);
    const [file] = JSON.parse(result.stdout).files;
    expect(
      file.sources
        .filter((s: { harness: string }) => s.harness === "pi")
        .map((s: { path: string }) => s.path),
    ).toEqual([join(project, "AGENTS.md")]);
  },
  cliRunsTimeout,
);

test(
  "steering requires an explicit existing directory and does not crawl descendants",
  async () => {
    const { home, project } = await fixture();
    await Bun.write(join(project, "src/AGENTS.md"), "Nested only.\n");
    expect((await run(home)).stderr).toContain("project directory");
    expect((await run(home, join(home, "missing"))).code).toBe(1);
    expect((await run(home, join(project, "src/AGENTS.md"))).code).toBe(1);
    expect((await run(home, project, "extra")).code).toBe(1);
    const result = await run(home, project, "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).files).toEqual([]);
  },
  cliRunsTimeout,
);

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
])(
  "steering parser review: %s",
  async (_name, text, expected) => {
    const { home, project } = await fixture();
    await Bun.write(join(project, "AGENTS.md"), text as string);
    const result = await run(home, project, "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).files[0].rules.map((r: { text: string }) => r.text)).toEqual(
      expected,
    );
  },
  cliRunsTimeout,
);

test(
  "steering review: repeated user/ancestor rule roots do not exhaust directory coverage",
  async () => {
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
  },
  cliRunsTimeout,
);

test(
  "steering review: dangling instruction symlinks warn instead of silently disappearing",
  async () => {
    const { home, project } = await fixture();
    await symlink("missing.md", join(project, "CLAUDE.md"));
    const result = await run(home, project, "--json");
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.files).toEqual([]);
    expect(out.warnings.join(" ")).toContain(join(project, "CLAUDE.md"));
  },
  cliRunsTimeout,
);

test(
  "content identity survives separate worktree paths and oversized files are visibly skipped",
  async () => {
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
  },
  cliRunsTimeout,
);

test(
  "steering preserves instructions around Markdown separators and code examples",
  async () => {
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
  },
  cliRunsTimeout,
);

test(
  "steering reuses aliased rule directories and warns about broken instruction links",
  async () => {
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
      out.files.flatMap((file: { rules: { text: string }[] }) =>
        file.rules.map((rule) => rule.text),
      ),
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
  },
  cliRunsTimeout,
);

test(
  "steering sums every recorded file a session loaded, even when two share their text",
  async () => {
    const { home, project } = await fixture();
    const text = "- Lead with the answer, always.";
    const global = join(home, "claude-config/CLAUDE.md");
    const local = join(project, "CLAUDE.md");
    for (const path of [global, local]) await Bun.write(path, `${text}\n`);
    await claudeSession(home, "a", project, [
      [global, text],
      [local, text],
    ]);
    await claudeSession(home, "b", project, []);
    const out = JSON.parse((await run(home, project, "--json")).stdout);
    expect(
      out.ranked.map((r: { path: string; sessions: number; loadedChars: number }) => [
        r.path,
        r.sessions,
        r.loadedChars,
      ]),
    ).toEqual([
      [global, 1, text.length],
      [local, 1, text.length],
    ]);
    expect(out.coverage).toEqual({ sessions: 2, unrecorded: 0, combinedOnly: 0 });
  },
  cliRunsTimeout,
);

test(
  "steering counts sessions recorded through a symlinked or differently cased directory",
  async () => {
    const { home, project } = await fixture();
    const local = join(project, "CLAUDE.md");
    await Bun.write(local, "- Run the tests.\n");
    const link = join(home, "link");
    await symlink(project, link, "junction");
    await claudeSession(home, "a", link, [[join(link, "CLAUDE.md"), "- Run the tests."]]);
    const folded = process.platform === "darwin" || process.platform === "win32";
    if (folded)
      await claudeSession(home, "b", project.toUpperCase(), [
        [local.toUpperCase(), "- Run the tests."],
      ]);
    const out = JSON.parse((await run(home, project, "--json")).stdout);
    expect(out.coverage.sessions).toBe(folded ? 2 : 1);
    expect(out.ranked[0].sessions).toBe(folded ? 2 : 1);
  },
  cliRunsTimeout,
);

test(
  "steering finds auto memory under Claude Code's truncated, hashed slug for long paths",
  async () => {
    const { home, project } = await fixture();
    const deep = join(
      project,
      ...Array.from({ length: 5 }, (_, i) => `${"segment".repeat(6)}-${i}`),
    );
    await mkdir(deep, { recursive: true });
    let hash = 0;
    for (let i = 0; i < deep.length; i++) hash = ((hash << 5) - hash + deep.charCodeAt(i)) | 0;
    const slug = `${deep.replace(/[^A-Za-z0-9]/g, "-").slice(0, 200)}-${Math.abs(hash).toString(36)}`;
    const memory = join(home, "claude-config/projects", slug, "memory/MEMORY.md");
    await Bun.write(memory, "- Remember the long path.\n");
    const out = JSON.parse((await run(home, deep, "--json")).stdout);
    expect(deep.replace(/[^A-Za-z0-9]/g, "-").length).toBeGreaterThan(200);
    expect(out.ranked.map((r: { path: string }) => r.path)).toEqual([memory]);
  },
  cliRunsTimeout,
);

test(
  "steering lists every location of a duplicated rule, identical files included",
  async () => {
    const { home, project } = await fixture();
    const text = "- Keep every change small and reviewable.\n";
    const paths = [
      join(project, "CLAUDE.md"),
      join(project, ".claude/CLAUDE.md"),
      join(project, "CLAUDE.local.md"),
    ];
    for (const path of paths.slice(0, 2)) await Bun.write(path, text);
    const two = JSON.parse((await run(home, project, "--json")).stdout).duplicates;
    expect(two.map((g: { path: string }[]) => g.map((r) => r.path))).toEqual([paths.slice(0, 2)]);
    await Bun.write(paths[2]!, text);
    const three = JSON.parse((await run(home, project, "--json")).stdout).duplicates;
    expect(three.map((g: { path: string }[]) => g.map((r) => r.path).sort())).toEqual([
      [...paths].sort(),
    ]);
  },
  cliRunsTimeout,
);

test(
  "steering conflicts need the same action with opposite polarity",
  async () => {
    const { home, project } = await fixture();
    await Bun.write(
      join(home, "claude-config/CLAUDE.md"),
      "- Never skip tests before pushing `main`.\n- Never deploy on a Friday afternoon.\n",
    );
    await Bun.write(
      join(project, "CLAUDE.md"),
      "- Always add tests before pushing `main`.\n- Always deploy on a Friday afternoon.\n",
    );
    const out = JSON.parse((await run(home, project, "--json")).stdout);
    expect(
      out.conflicts.map((c: { global: { text: string }; project: { text: string } }) => [
        c.global.text,
        c.project.text,
      ]),
    ).toEqual([
      ["- Never deploy on a Friday afternoon.", "- Always deploy on a Friday afternoon."],
    ]);
  },
  cliRunsTimeout,
);

test(
  "steering checks scripts against the package each file applies to and abstains when ambiguous",
  async () => {
    const { home, project } = await fixture();
    const site = join(project, "site");
    await mkdir(site);
    await Bun.write(join(project, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    await Bun.write(join(site, "package.json"), JSON.stringify({ scripts: { build: "x" } }));
    await Bun.write(join(project, "CLAUDE.md"), "- Run `bun run build` here.\n");
    await Bun.write(join(site, "CLAUDE.md"), "- Run `bun run build` in the site.\n");
    for (const dir of [project, site])
      await Bun.write(join(dir, ".claude/CLAUDE.md"), "- Run `bun run deploy` too.\n");
    const out = JSON.parse((await run(home, site, "--json")).stdout);
    expect(
      out.stale.map((rule: { path: string; missing: { name: string }[] }) => [
        rule.path,
        rule.missing.map((m) => m.name),
      ]),
    ).toEqual([[join(project, "CLAUDE.md"), ["bun run build"]]]);
  },
  cliRunsTimeout,
);

test(
  "steering recognises drive-letter paths when checking for stale files",
  async () => {
    const { home, project } = await fixture();
    await Bun.write(join(project, "README.md"), "# Readme\n");
    await Bun.write(
      join(project, "CLAUDE.md"),
      `- Read \`C:\\quench-missing\\gone.md\` and \`${join(project, "README.md")}\`.\n`,
    );
    const out = JSON.parse((await run(home, project, "--json")).stdout);
    expect(out.stale.map((rule: { missing: object[] }) => rule.missing)).toEqual([
      [{ name: "C:\\quench-missing\\gone.md", kind: "file" }],
    ]);
  },
  cliRunsTimeout,
);

test(
  "steering keeps ranking totals per file path after a file's text changes to match another",
  async () => {
    const { home, project } = await fixture();
    const text = "- Be brief.";
    const global = join(home, "claude-config/CLAUDE.md");
    const local = join(project, "CLAUDE.md");
    for (const path of [global, local]) await Bun.write(path, `${text}\n`);
    await claudeSession(home, "a", project, [
      [global, text],
      [local, "x".repeat(100_000)],
    ]);
    const out = JSON.parse((await run(home, project, "--json")).stdout);
    expect(
      out.ranked.map((r: { path: string; scope: string; loadedChars: number }) => [
        r.path,
        r.scope,
        r.loadedChars,
      ]),
    ).toEqual([
      [local, "project", 100_000],
      [global, "global", text.length],
    ]);
  },
  cliRunsTimeout,
);

test(
  "steering compares conflicts per scoped location when global and project files are identical",
  async () => {
    const { home, project } = await fixture();
    const never = "- Never deploy on a Friday afternoon.\n";
    const global = join(home, "claude-config/CLAUDE.md");
    const local = join(project, "CLAUDE.md");
    await Bun.write(local, never);
    await Bun.write(join(home, "claude-config/rules/same.md"), never);
    await Bun.write(global, "- Always deploy on a Friday afternoon.\n");
    const out = JSON.parse((await run(home, project, "--json")).stdout);
    expect(
      out.conflicts.map((c: { global: { path: string }; project: { path: string } }) => [
        c.global.path,
        c.project.path,
      ]),
    ).toEqual([[global, local]]);
  },
  cliRunsTimeout,
);

test(
  "steering lists the rules hooks keep blocking in this project, not elsewhere",
  async () => {
    const { home, project } = await fixture();
    const blockedPush = (cwd: string, n: number) => [
      {
        type: "assistant",
        cwd,
        message: {
          content: [
            { type: "tool_use", id: `h${n}`, name: "Bash", input: { command: "git push" } },
          ],
        },
      },
      {
        type: "user",
        cwd,
        permissionDecision: { decision: "reject", source: "hook" },
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `h${n}`,
              is_error: true,
              content:
                "PreToolUse:Bash hook error: [guard.sh]: guard: blocked — push to main. Ask.",
            },
          ],
        },
      },
    ];
    const write = (id: string, records: object[]) =>
      Bun.write(
        join(home, "claude-config/projects/sessions", `${id}.jsonl`),
        records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
    await write("here", [...blockedPush(project, 1), ...blockedPush(project, 2)]);
    await write("away", blockedPush(join(home, "elsewhere"), 3));
    const out = JSON.parse((await run(home, project, "--json")).stdout);
    expect(out.blocked).toEqual([
      {
        guard: "hook",
        command: "git push",
        blocks: 2,
        sessions: 1,
        projects: [{ root: project, blocks: 2 }],
        harnesses: ["claude-code"],
        example: "here",
      },
    ]);
    expect((await run(home, project)).stdout).toContain(
      [
        "Rules agents keep hitting · calls blocked by a hook or permission rule here (1)",
        "  2× in 1 session  hook · git push  e.g. session here",
      ].join("\n"),
    );
  },
  cliRunsTimeout,
);
