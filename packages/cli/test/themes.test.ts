import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jev, VerdictCache } from "@quench/judge";

const root = join(import.meta.dir, "../../..");
const args = ["corrections", "--themes", "--days", "36500", "--json"];

async function run(home: string, flags: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", join(root, "packages/cli/src/main.ts"), ...flags], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
      TYPESAFE_API_KEY: "",
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

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "quench-cli-themes-"));
  const sessions = join(home, ".claude/projects/demo");
  await mkdir(sessions, { recursive: true });
  const cases = [
    ["a", "done", "Run the check before saying it passed.", "person"],
    ["b", "Everything passes.", "Don't report success without executing checks.", "person"],
    ["c", "done", "Relay: run the checks.", "automation"],
    ["d", "done", "Have you tested it?", null],
  ] as const;
  const cacheFile = join(home, ".quench/local/judgments.jsonl");
  const cache = await VerdictCache.open(cacheFile, Jev.id);
  for (const [id, assistantSaid, reply, sender] of cases) {
    await Bun.write(
      join(sessions, `${id}.jsonl`),
      [
        {
          type: "user",
          sessionId: id,
          timestamp: "2026-10-20T10:00:00Z",
          promptSource: "sdk",
          message: { role: "user", content: "work" },
        },
        {
          type: "assistant",
          timestamp: "2026-10-20T10:00:01Z",
          message: {
            id,
            model: `model-${id}`,
            content: [{ type: "text", text: assistantSaid }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        {
          type: "user",
          timestamp: "2026-10-20T10:00:02Z",
          promptSource: "sdk",
          message: { role: "user", content: reply },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    if (sender)
      await cache.remember([
        [
          { assistantSaid, reply },
          { kind: "correction", sender, confidence: 1 },
        ],
      ]);
  }
  return { home, cacheFile, themeFile: join(home, ".quench/local/themes.jsonl"), sessions };
}

test("themes runs through the actual SDK path independently, then replays with no key or requests", async () => {
  const { home, cacheFile, themeFile, sessions } = await fixture();
  const before = await Bun.file(cacheFile).text();
  const history = await Bun.file(join(sessions, "a.jsonl")).text();
  const dry = await run(home, [...args, "--dry-run"]);
  expect(dry.code).toBe(0);
  const planned = JSON.parse(dry.stdout);
  expect([
    planned.pending,
    planned.newlyJudged,
    planned.themes.pending,
    planned.themes.blocked,
  ]).toEqual([1, 0, 1, 1]);
  expect(planned.themes.excluded).toEqual({
    automationCorrections: 1,
    unknownSenderCorrections: 0,
    unclassifiedReplies: 1,
  });
  expect(await Bun.file(themeFile).exists()).toBe(false);
  const noKey = await run(home, args);
  expect(noKey.code).toBe(2);
  expect(noKey.stderr).toContain("Grouping cached person corrections uses Jev");
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const body = (await request.json()) as {
        questions: Record<string, unknown>;
        state: Record<string, unknown>;
      };
      expect(Object.keys(body.questions)).toEqual(["theme"]);
      expect(Object.keys(body.state)).toEqual(["correction", "exemplars"]);
      calls += 1;
      return Response.json({
        model: "local-test-model",
        answers: {
          theme: {
            type: "choice",
            choice: calls === 1 ? "new" : "t0",
            confidence: 1,
            probabilities: {},
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    },
  });
  try {
    const env = { TYPESAFE_API_KEY: "local-test-only", TYPESAFE_BASE_URL: server.url.toString() };
    const fresh = await run(home, args, env);
    expect(fresh.code).toBe(0);
    const result = JSON.parse(fresh.stdout);
    expect([calls, result.newlyJudged, result.pending, result.themes.newlyGrouped]).toEqual([
      2, 0, 1, 2,
    ]);
    expect(result.themes.tokens).toEqual({ input: 20, output: 4 });
    expect(result.themes.themes[0]).toMatchObject({
      corrections: 2,
      sessions: 2,
      recurring: true,
      models: ["model-a", "model-b"],
      classifierModels: ["local-test-model"],
    });
    const bytes = await Bun.file(themeFile).text();
    for (const environment of [{}, env]) {
      const replay = await run(home, args, environment);
      expect(replay.code).toBe(0);
      const replayed = JSON.parse(replay.stdout);
      expect([
        replayed.themes.cacheHits,
        replayed.themes.newlyGrouped,
        replayed.themes.pending,
      ]).toEqual([2, 0, 0]);
      expect(replayed.themes.themes).toEqual(result.themes.themes);
    }
    expect(calls).toBe(2);
    expect(await Bun.file(themeFile).text()).toBe(bytes);
    expect(await Bun.file(cacheFile).text()).toBe(before);
    expect(await Bun.file(join(sessions, "a.jsonl")).text()).toBe(history);
    const text = await run(home, ["corrections", "--themes", "--days", "36500"]);
    expect(text.stdout).toContain("2 corrections · 2 sessions");
    expect(text.stdout).toContain("representative quotations, not draft rules");
    expect(text.stdout).toContain(`${join(sessions, "a.jsonl")}`);
    expect(text.stdout).not.toContain("would be sent to Jev in 2 requests");
  } finally {
    await server.stop(true);
  }
});

test("themes previews leave malformed reply/theme caches unchanged and validate analysis limits", async () => {
  const { home, cacheFile, themeFile } = await fixture();
  const before = (await Bun.file(cacheFile).text()) + "malformed\n";
  await Bun.write(cacheFile, before);
  await Bun.write(themeFile, "malformed theme cache\n");
  const preview = await run(home, [...args, "--dry-run", "--theme-limit", "1"]);
  expect(preview.code).toBe(0);
  const out = JSON.parse(preview.stdout);
  expect([out.themes.selectedInputs, out.themes.omittedCorrections, out.themes.blocked]).toEqual([
    1, 1, 0,
  ]);
  expect(out.themes.warnings).toHaveLength(1);
  expect(await Bun.file(cacheFile).text()).toBe(before);
  expect(await Bun.file(themeFile).text()).toBe("malformed theme cache\n");
  for (const limit of ["0", "51", "1.5", "NaN"]) {
    const invalid = await run(home, [...args, "--theme-limit", limit]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("--theme-limit must be");
  }
  expect((await run(home, ["report", "--themes"])).code).toBe(1);
  expect((await run(home, ["corrections", "--theme-limit", "2"])).code).toBe(1);
});

test("a grouping service failure is reported without reclassifying replies or assuming later memberships", async () => {
  const { home, cacheFile, themeFile } = await fixture();
  const before = await Bun.file(cacheFile).text();
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      calls += 1;
      return Response.json({ error: "unavailable" }, { status: 500 });
    },
  });
  try {
    const failed = await run(home, args, {
      TYPESAFE_API_KEY: "local-test-only",
      TYPESAFE_BASE_URL: server.url.toString(),
    });
    expect(failed.code).toBe(1);
    const result = JSON.parse(failed.stdout);
    expect([calls, result.newlyJudged, result.themes.failed, result.themes.blocked]).toEqual([
      1, 0, 1, 1,
    ]);
    expect(await Bun.file(themeFile).exists()).toBe(false);
    expect(await Bun.file(cacheFile).text()).toBe(before);
  } finally {
    await server.stop(true);
  }
});
