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

test("theme limits select correction dates, not recently modified files containing old history", async () => {
  const { home, sessions } = await fixture();
  for (const id of ["a", "b"]) {
    const file = join(sessions, `${id}.jsonl`);
    const lines = (await Bun.file(file).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { timestamp: string });
    for (const line of lines) line.timestamp = "2020-01-01T10:00:00Z";
    if (id === "b") lines[2]!.timestamp = new Date().toISOString();
    await Bun.write(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  const result = await run(home, [
    "corrections",
    "--themes",
    "--days",
    "1",
    "--theme-limit",
    "1",
    "--dry-run",
    "--json",
  ]);
  expect(result.code).toBe(0);
  const out = JSON.parse(result.stdout);
  expect([
    out.themes.eligibleCorrections,
    out.themes.selectedInputs,
    out.themes.omittedCorrections,
  ]).toEqual([1, 1, 0]);
  expect(out.themes.excluded.outsideWindowCorrections).toBe(1);
});

test("themes classifies missing replies before grouping, then replays both caches without requests", async () => {
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
    outsideWindowCorrections: 0,
    unknownTimeCorrections: 0,
    automationCorrections: 1,
    unknownSenderCorrections: 0,
    unclassifiedReplies: 1,
  });
  expect(await Bun.file(themeFile).exists()).toBe(false);
  const noKey = await run(home, args);
  expect(noKey.code).toBe(2);
  expect(noKey.stderr).toContain("TYPESAFE_API_KEY");
  const calls: string[] = [];
  let grouping = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const body = (await request.json()) as {
        questions: Record<string, unknown>;
        state: Record<string, unknown>;
      };
      const question = Object.keys(body.questions)[0]!;
      expect(Object.keys(body.questions)).toEqual([question]);
      expect(["kind", "sender", "theme"]).toContain(question);
      if (question === "kind")
        expect(body.state).toEqual({ assistant_said: "done", user_reply: "Have you tested it?" });
      else if (question === "sender")
        expect(body.state).toEqual({ message: "Have you tested it?" });
      else expect(Object.keys(body.state)).toEqual(["correction", "exemplars"]);
      calls.push(question);
      return Response.json({
        model: "local-test-model",
        answers: {
          [question]: {
            type: "choice",
            choice:
              question === "kind"
                ? "correction"
                : question === "sender"
                  ? "person"
                  : grouping++ === 0
                    ? "new"
                    : "t0",
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
    const preview = await run(
      home,
      ["corrections", "--themes", "--days", "36500", "--dry-run"],
      env,
    );
    expect(preview.code).toBe(0);
    expect(calls).toEqual([]);
    expect(await Bun.file(cacheFile).text()).toBe(before);
    expect(await Bun.file(themeFile).exists()).toBe(false);
    const fresh = await run(home, args, env);
    expect(fresh.code).toBe(0);
    const result = JSON.parse(fresh.stdout);
    expect(calls).toEqual(["kind", "sender", "theme", "theme", "theme"]);
    expect(preview.stdout).toContain("Uncached replies: 1 (2 classification requests)");
    expect([result.newlyJudged, result.pending, result.themes.newlyGrouped]).toEqual([1, 0, 3]);
    expect(result.tokens).toEqual({ input: 20, output: 4 });
    expect(result.themes.tokens).toEqual({ input: 30, output: 6 });
    expect(result.themes.themes[0]).toMatchObject({
      corrections: 3,
      sessions: 3,
      recurring: true,
      models: ["model-a", "model-b", "model-d"],
      classifierModels: ["local-test-model"],
    });
    expect(result.themes.excluded.unclassifiedReplies).toBe(0);
    const bytes = await Bun.file(themeFile).text();
    const verdicts = await Bun.file(cacheFile).text();
    expect(verdicts.startsWith(before)).toBe(true);
    expect(verdicts.trim().split("\n")).toHaveLength(4);
    for (const environment of [{}, env]) {
      const replay = await run(home, args, environment);
      expect(replay.code).toBe(0);
      const replayed = JSON.parse(replay.stdout);
      expect([replayed.newlyJudged, replayed.pending]).toEqual([0, 0]);
      expect([
        replayed.themes.cacheHits,
        replayed.themes.newlyGrouped,
        replayed.themes.pending,
      ]).toEqual([3, 0, 0]);
      expect(replayed.themes.themes).toEqual(result.themes.themes);
    }
    expect(calls).toHaveLength(5);
    expect(await Bun.file(themeFile).text()).toBe(bytes);
    expect(await Bun.file(cacheFile).text()).toBe(verdicts);
    expect(await Bun.file(join(sessions, "a.jsonl")).text()).toBe(history);
    const text = await run(home, ["corrections", "--themes", "--days", "36500"]);
    expect(text.stdout).toContain("3 corrections · 3 sessions");
    expect(text.stdout).toContain("representative quotations, not draft rules");
    expect(text.stdout).toContain(`${join(sessions, "a.jsonl")}`);
    expect(text.stdout).not.toContain("Uncached replies:");
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

test("classification failures remain visible even when known themes group successfully", async () => {
  const { home, cacheFile, themeFile } = await fixture();
  const before = await Bun.file(cacheFile).text();
  const calls: string[] = [];
  let grouping = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const body = (await request.json()) as { questions: Record<string, unknown> };
      const question = Object.keys(body.questions)[0]!;
      calls.push(question);
      return Response.json({
        model: "local-test-model",
        answers: {
          [question]: {
            type: "choice",
            choice:
              question === "kind"
                ? "praise"
                : question === "sender"
                  ? "person"
                  : grouping++ === 0
                    ? "new"
                    : "t0",
            confidence: 1,
            probabilities: {},
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    },
  });
  try {
    const failed = await run(home, args, {
      TYPESAFE_API_KEY: "local-test-only",
      TYPESAFE_BASE_URL: server.url.toString(),
    });
    expect(failed.code).toBe(1);
    const result = JSON.parse(failed.stdout);
    expect([result.failed, result.newlyJudged, result.themes.failed]).toEqual([1, 0, 0]);
    expect(result.themes.excluded.unclassifiedReplies).toBe(1);
    expect(result.themes.themes[0].corrections).toBe(2);
    expect(calls).toEqual(["kind", "sender", "theme", "theme"]);
    expect(await Bun.file(cacheFile).text()).toBe(before);
    const themes = await Bun.file(themeFile).text();
    const noKey = await run(home, args);
    expect(noKey.code).toBe(2);
    const replayed = JSON.parse(noKey.stdout);
    expect([replayed.pending, replayed.themes.pending, replayed.themes.cacheHits]).toEqual([
      1, 0, 2,
    ]);
    expect(noKey.stderr).toContain("Classifying missing replies");
    expect(await Bun.file(cacheFile).text()).toBe(before);
    expect(await Bun.file(themeFile).text()).toBe(themes);
    expect(calls).toHaveLength(4);
    const text = await run(home, ["corrections", "--themes", "--days", "36500"], {
      TYPESAFE_API_KEY: "local-test-only",
      TYPESAFE_BASE_URL: server.url.toString(),
    });
    expect(text.code).toBe(1);
    expect(text.stdout).toContain("1 unclassified replies (not grouped)");
    expect(text.stdout).toContain("Classification failure:");
    expect(calls).toHaveLength(6);
  } finally {
    await server.stop(true);
  }
});

test("a grouping service failure is reported without reclassifying replies or assuming later memberships", async () => {
  const { home, cacheFile, themeFile } = await fixture();
  const cache = await VerdictCache.open(cacheFile, Jev.id);
  await cache.remember([
    [
      { assistantSaid: "done", reply: "Have you tested it?" },
      { kind: "question", sender: "person", confidence: 1 },
    ],
  ]);
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
