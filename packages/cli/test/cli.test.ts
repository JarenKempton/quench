import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cp, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jev, VerdictCache } from "@quench/judge";
import { fakeCalls, fakeHarnessPath } from "../../judge/test/fake-path.ts";

const root = join(import.meta.dir, "../../..");
const home = join(root, "packages/history/test/fixtures/home");

const quench = (...args: string[]) => quenchAt(home, ...args);

const quenchAt = (home: string, ...args: string[]) => quenchAtWith({}, home, ...args);

async function quenchAtWith(extra: Record<string, string>, home: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, join(root, "packages/cli/src/main.ts"), ...args], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
      TYPESAFE_API_KEY: "",
      ...extra,
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

test("report --json totals each harness found in the home", async () => {
  const { stdout, code } = await quench("report", "--days", "36500", "--json");
  expect(code).toBe(0);
  const out = JSON.parse(stdout);
  expect(
    out.harnesses.map((h: { harness: string; sessions: number }) => [h.harness, h.sessions]),
  ).toEqual([
    ["claude-code", 1],
    ["codex", 1],
    ["pi", 1],
  ]);
  expect(out.unreadable).toBe(0);
});

test("runs shows each prompt, what the agent did, and the reply", async () => {
  const { stdout, code } = await quench("runs", join(home, ".claude/projects/-work-demo/s1.jsonl"));
  expect(code).toBe(0);
  expect(stdout).toContain('#1   "Add a health check endpoint"');
  expect(stdout).toContain("1 tool error · 1 subagent · 1 compaction");
  expect(stdout).toContain('→  "/review now"');
});

test("runs --session finds a session by id in any harness home", async () => {
  const found = await quench("runs", "--session", "c1", "--json");
  expect(found.code).toBe(0);
  expect(JSON.parse(found.stdout).length).toBeGreaterThan(0);
  const missing = await quench("runs", "--session", "nope");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("No session with id nope");
});

test("runs --all reads several machine folders and tags each run with its machine", async () => {
  const history = await mkdtemp(join(tmpdir(), "quench-history-"));
  await cp(join(home, ".claude"), join(history, "goliath/.claude"), { recursive: true });
  await cp(join(home, ".codex"), join(history, "sb1/.codex"), { recursive: true });
  await cp(join(home, ".claude"), join(history, "sb1/.claude"), { recursive: true });
  const { stdout, code } = await quench(
    "runs",
    "--all",
    "--json",
    "--history",
    join(history, "goliath"),
    "--history",
    join(history, "sb1"),
  );
  expect(code).toBe(0);
  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const top = lines.filter((r) => r.parentSession === null);
  expect(new Set(top.map((r) => `${r.machine} ${r.harness} ${r.cwd}`))).toEqual(
    new Set([
      "goliath claude-code /work/demo",
      "sb1 claude-code /work/demo",
      "sb1 codex /work/demo",
    ]),
  );
  expect(new Set(lines.map((r) => r.id)).size).toBe(lines.length);
  expect(lines.find((r) => r.machine === "sb1" && r.session === "s1")?.id).toStartWith(
    "sb1:claude-code:s1:",
  );
  const parent = lines.find(
    (r) => r.machine === "goliath" && r.session === "s1" && r.prompt?.includes("health check"),
  );
  expect(parent).toMatchObject({ subagents: 1, open: false, parentSession: null });
  expect(lines.some((r) => r.parentSession === "s1")).toBe(true);
  expect((await quench("runs", "--all")).code).toBe(1);
});

test("corrections asks for a key before sending anything, and a dry run never counts a slash command", async () => {
  const noKey = await quench("corrections");
  expect(noKey.code).toBe(2);
  expect(noKey.stderr).toContain("Set TYPESAFE_API_KEY to opt in");

  const dry = await quench("corrections", "--days", "36500", "--dry-run", "--json");
  expect(dry.code).toBe(0);
  const out = JSON.parse(dry.stdout);
  expect([out.pending, out.newlyJudged, out.tokens]).toEqual([0, 0, null]);
  expect([out.senderSources.harness, out.fromPeople.kinds.new_request]).toEqual([1, 1]);
  expect(await Bun.file(join(home, ".quench")).exists()).toBe(false);
});

test("corrections uses optional host evidence over a cached sender, and degrades visibly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-cli-host-"));
  const sessions = join(dir, ".claude/projects/demo");
  const hostDir = join(dir, ".t3/userdata");
  await mkdir(sessions, { recursive: true });
  await mkdir(hostDir, { recursive: true });
  await Bun.write(
    join(sessions, "native.jsonl"),
    [
      {
        type: "user",
        sessionId: "native",
        timestamp: "2026-10-20T10:00:00Z",
        promptSource: "sdk",
        message: { role: "user", content: "build" },
      },
      {
        type: "assistant",
        timestamp: "2026-10-20T10:00:01Z",
        message: {
          id: "a",
          model: "model",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "user",
        timestamp: "2026-10-20T10:00:03Z",
        promptSource: "sdk",
        message: { role: "user", content: "no, the other file" },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  const cache = await VerdictCache.open(join(dir, ".quench/local"), Jev.id);
  const cacheFile = cache.path;
  await cache.remember([
    [
      { assistantSaid: "done", reply: "no, the other file" },
      { kind: "correction", sender: "person", confidence: 1 },
    ],
  ]);
  const cacheBefore = await Bun.file(cacheFile).text();
  const path = join(hostDir, "statev2.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE orchestration_v2_projection_provider_threads (payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, role TEXT, payload_json TEXT);`);
  db.query("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?)").run(
    JSON.stringify({
      appThreadId: "thread",
      nativeThreadRef: { driver: "claudeAgent", nativeId: "native", strength: "strong" },
    }),
  );
  db.query("INSERT INTO orchestration_v2_projection_messages VALUES ('thread', 'user', ?)").run(
    JSON.stringify({
      id: "message",
      threadId: "thread",
      role: "user",
      text: "no, the other file",
      createdAt: "2026-10-20T10:00:02Z",
      createdBy: "agent",
      creationSource: "mcp",
    }),
  );
  db.close();
  const hostBefore = await Bun.file(path).bytes();
  const args = ["corrections", "--days", "36500", "--dry-run", "--json"];
  const disabled = await quenchAt(dir, ...args, "--no-host-history");
  expect(JSON.parse(disabled.stdout).fromPeople.kinds.correction).toBe(1);
  const enriched = await quenchAt(dir, ...args);
  const out = JSON.parse(enriched.stdout);
  expect(enriched.code).toBe(0);
  expect(out.fromPeople.kinds.correction).toBe(0);
  expect(out.fromAutomation.kinds.correction).toBe(1);
  expect(out.senderSources).toEqual({ harness: 0, host: 1, judge: 0, unknown: 0 });
  expect([out.pending, out.newlyJudged, out.failed, out.tokens]).toEqual([0, 0, 0, null]);
  expect(await Bun.file(path).bytes()).toEqual(hostBefore);
  expect(await Bun.file(cacheFile).text()).toBe(cacheBefore);
  const broken = join(dir, "broken.sqlite");
  await Bun.write(broken, "not sqlite");
  const fallback = await quenchAt(dir, ...args, "--host-history", broken);
  expect(fallback.code).toBe(0);
  expect(JSON.parse(fallback.stdout).senderSources.judge).toBe(1);
  expect(fallback.stderr).toContain("incompatible");

  const causes = await quenchAt(dir, ...args, "--causes", "--no-host-history");
  expect(causes.code).toBe(0);
  const asked = JSON.parse(causes.stdout).causes;
  expect([asked.corrections, asked.pending, asked.cacheHits, asked.tokens]).toEqual([
    1,
    1,
    0,
    null,
  ]);
  expect(asked.caused.map((c: { cause: string; sender: string }) => [c.cause, c.sender])).toEqual([
    ["pending", "person"],
  ]);
  expect(await Bun.file(join(dir, ".quench/local/causes.jsonl")).exists()).toBe(false);
  const noKey = await quenchAt(
    dir,
    "corrections",
    "--days",
    "36500",
    "--causes",
    "--no-host-history",
  );
  expect(noKey.code).toBe(2);
  expect(noKey.stdout).toContain("1 pending");
});

test("corrections --cached-only never classifies new replies, so it needs no key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-cli-cached-"));
  const sessions = join(dir, ".claude/projects/demo");
  await mkdir(sessions, { recursive: true });
  await Bun.write(
    join(sessions, "s.jsonl"),
    [
      {
        type: "user",
        timestamp: "2026-10-20T10:00:00Z",
        message: { role: "user", content: "build" },
      },
      {
        type: "assistant",
        timestamp: "2026-10-20T10:00:01Z",
        message: {
          id: "a",
          model: "model",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "user",
        timestamp: "2026-10-20T10:00:03Z",
        message: { role: "user", content: "no, the other file" },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  const args = ["corrections", "--days", "36500", "--no-host-history"];
  expect((await quenchAt(dir, ...args)).code).toBe(2);
  const cached = await quenchAt(dir, ...args, "--cached-only", "--json");
  expect(cached.code).toBe(0);
  const out = JSON.parse(cached.stdout);
  expect([out.pending, out.newlyJudged]).toEqual([1, 0]);
  expect(await Bun.file(join(dir, ".quench/local/judgments")).exists()).toBe(false);
  expect((await quench("report", "--cached-only")).stderr).toContain(
    "--cached-only is only available for corrections",
  );
});

test.skipIf(process.platform === "win32")(
  "corrections --judge claude classifies through the local CLI into its own cache",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "quench-cli-harness-"));
    const sessions = join(dir, ".claude/projects/demo");
    await mkdir(sessions, { recursive: true });
    const line = (type: string, text: string, at: string) =>
      JSON.stringify(
        type === "user"
          ? { type, timestamp: at, message: { role: "user", content: text } }
          : {
              type,
              timestamp: at,
              message: {
                id: at,
                model: "model",
                content: [{ type: "text", text }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
      );
    await Bun.write(
      join(sessions, "s.jsonl"),
      [
        line("user", "build", "2026-10-20T10:00:00Z"),
        line("assistant", "done", "2026-10-20T10:00:01Z"),
        line("user", "no, the other file", "2026-10-20T10:00:03Z"),
        line("assistant", "fixed", "2026-10-20T10:00:04Z"),
        line("user", "thanks, ship it", "2026-10-20T10:00:05Z"),
      ].join("\n") + "\n",
    );
    const jevCache = join(dir, ".quench/local/judgments.jsonl");
    const jevLine = `${JSON.stringify({ judge: Jev.id, key: "k", verdict: { kind: "info", sender: "person", confidence: 1 } })}\n`;
    await Bun.write(jevCache, jevLine);
    const fake = await fakeHarnessPath({
      answer: '{"kind": "correction", "sender": "person", "confidence": 0.9}',
    });
    const args = ["corrections", "--days", "36500", "--no-host-history", "--judge", "claude"];
    const env = {
      PATH: fake.PATH,
    };

    const dry = await quenchAt(dir, ...args, "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("judged by claude/claude-haiku-5-5/reply-v3");
    expect(dry.stdout).toContain(
      "2 replies not judged yet would be sent to claude -p in 2 requests",
    );
    expect(JSON.parse((await quenchAt(dir, ...args, "--dry-run", "--json")).stdout).calls).toBe(2);
    expect(await fakeCalls(fake)).toEqual([]);

    const run = await quenchAtWith(env, dir, ...args, "--json");
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    expect([out.judge, out.newlyJudged, out.pending, out.fromPeople.kinds.correction]).toEqual([
      "claude/claude-haiku-5-5/reply-v3",
      2,
      0,
      2,
    ]);
    expect((await fakeCalls(fake)).length).toBe(2);
    expect(await Bun.file(jevCache).text()).toBe(jevLine);
    const own = await VerdictCache.open(
      join(dir, ".quench/local"),
      "claude/claude-haiku-5-5/reply-v3",
    );
    expect(own.size).toBe(2);

    const again = await quenchAtWith(env, dir, ...args, "--json");
    expect(JSON.parse(again.stdout).newlyJudged).toBe(0);
    expect((await fakeCalls(fake)).length).toBe(2);

    const missing = await quenchAtWith({ PATH: dir }, dir, ...args);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("claude was not found on PATH");
    expect((await quench("report", "--judge", "claude")).stderr).toContain(
      "--judge is only available for corrections",
    );
    expect((await quench("corrections", "--judge", "gpt")).stderr).toContain(
      "--judge must be jev or claude",
    );
  },
);

test.skipIf(process.platform !== "win32")(
  "corrections --judge claude refuses on Windows before reading or spawning anything",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "quench-cli-windows-"));
    const fake = await fakeHarnessPath({
      answer: '{"kind": "correction", "sender": "person", "confidence": 0.9}',
    });
    for (const extra of [[], ["--dry-run"]]) {
      const run = await quenchAtWith(
        { PATH: fake.PATH },
        dir,
        "corrections",
        "--judge",
        "claude",
        ...extra,
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("--judge claude is not supported on Windows yet; use Jev");
    }
    expect(await fakeCalls(fake)).toEqual([]);
    expect(await Bun.file(join(dir, ".quench/local/judgments")).exists()).toBe(false);
  },
);

test("unknown commands and bad input fail with a message", async () => {
  expect((await quench("frobnicate")).code).toBe(1);
  expect((await quench("report", "--days", "zero")).stderr).toContain(
    "--days must be a positive number",
  );
  expect((await quench("runs", "/nope.jsonl")).stderr).toContain("does not exist");
});
