import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { createZstdCompress } from "node:zlib";
import { join } from "node:path";
import { MAX_TRANSCRIPT_BYTES, sha256, type SessionResult, type TaskResult } from "@quench/fleet";
import { Owner, startHub, stopHubs, temp, type Running } from "./helpers.ts";

const CLICKHOUSE = process.env.QUENCH_TEST_CLICKHOUSE;
const skip = !CLICKHOUSE;
const MiB = 1024 * 1024;

let running: Running;
let owner: Owner;
let token = "";
let data = "";

async function zeroBomb(bytes: number) {
  const z = createZstdCompress();
  const out: Buffer[] = [];
  z.on("data", (c: Buffer) => out.push(c));
  const done = new Promise((r) => z.on("end", r));
  const block = new Uint8Array(MiB);
  for (let left = bytes; left > 0; left -= MiB)
    await new Promise<void>((r) => z.write(block.subarray(0, Math.min(MiB, left)), () => r()));
  z.end();
  await done;
  return new Uint8Array(Buffer.concat(out));
}

const maxRss = () => process.resourceUsage().maxRSS * (process.platform === "darwin" ? 1 : 1024);

const freePort = () => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
};

beforeAll(async () => {
  if (skip) return;
  const root = temp("archive");
  data = join(root, "data");
  running = await startHub(data, {
    archive: { bin: CLICKHOUSE, dir: join(root, "clickhouse"), port: freePort() },
  });
  owner = new Owner(running.url, running.cert);
  await owner.login();
  const { code } = await owner.addMachine("laptop");
  const paired = await call("/api/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  token = ((await paired.json()) as { token: string }).token;
}, 120_000);

afterAll(() => stopHubs(), 60_000);

function call(path: string, init: RequestInit = {}) {
  return fetch(`${running.url}${path}`, {
    ...init,
    ...(running.cert ? { tls: { ca: running.cert } } : {}),
  });
}

const asMachine = (path: string, init: RequestInit = {}) =>
  call(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
  });

const header = (path: string, digest: string) =>
  encodeURIComponent(
    JSON.stringify({
      harness: "claude-code",
      path,
      sha256: digest,
      sessionId: path.replace(/\W/g, "-"),
      modifiedAt: "2026-10-20T10:00:00.000Z",
    }),
  );

const put = (
  path: string,
  raw: Uint8Array | string,
  body: RequestInit["body"] = Bun.zstdCompressSync(raw),
) =>
  asMachine("/api/v1/transcripts", {
    method: "PUT",
    headers: { "x-quench-transcript": header(path, sha256(raw)) },
    body,
  });

const result = (runs: number, analysisVersion: number): SessionResult => ({
  harness: "claude-code",
  sessionId: "versioned",
  parent: null,
  path: "projects/demo/versioned.jsonl",
  sha256: "0".repeat(64),
  cwd: "/work/demo",
  branch: "main",
  startedAt: "2026-10-20T10:00:00.000Z",
  endedAt: "2026-10-20T11:00:00.000Z",
  runs,
  finishedRuns: runs,
  models: ["claude-opus-5-5"],
  inputTokens: 1,
  cacheReadTokens: 1,
  cacheWriteTokens: 1,
  outputTokens: 1,
  toolCalls: 0,
  toolErrors: 0,
  compactions: 0,
  subagents: 0,
  replies: {},
  corrections: {},
  unclassifiedReplies: 0,
  signals: {},
  skillsInvoked: [],
  judgeId: "",
  analysisVersion,
});

const runsOf = async () => {
  const response = await owner.fetch("/api/v1/archive/sessions?machine=laptop&session=versioned");
  const { sessions } = (await response.json()) as { sessions: { Runs: number }[] };
  return sessions.map((s) => s.Runs);
};

test.skipIf(skip)("a newer analysis wins even when an older one is posted after it", async () => {
  for (const [runs, version] of [
    [22, 2],
    [11, 1],
  ] as const) {
    const posted = await asMachine("/api/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [result(runs, version)] }),
    });
    expect(posted.status).toBe(200);
  }
  expect(await runsOf()).toEqual([22]);
  await running.archive!.ch.exec("OPTIMIZE TABLE quench_sessions FINAL");
  expect(await runsOf()).toEqual([22]);
});

const task = (runs: number, removed = false): TaskResult => ({
  taskId: "a".repeat(32),
  removed,
  startedAt: "2026-10-20T10:00:00.000Z",
  endedAt: "2026-10-20T11:00:00.000Z",
  split: "marker",
  boundary: "session-start",
  markers: ["branch:t3/abc"],
  members: [
    { harness: "claude-code", sessionId: "lane", firstTurn: 0, lastTurn: 4 },
    { harness: "codex", sessionId: "later", firstTurn: 0, lastTurn: 1 },
  ],
  harnesses: ["claude-code", "codex"],
  sessions: 2,
  runs,
  guidance: "unknown",
  guidanceUnreliableRule: "lane#2",
  guidanceTurns: 1,
  guidanceCost: 0.00005,
  analysisVersion: 1,
});

const postTask = (t: TaskResult) =>
  asMachine("/api/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks: [t] }),
  });

const tasksNow = () =>
  running.archive!.ch.rows<{
    Runs: number;
    Members: unknown[];
    Guidance: string;
    GuidanceUnreliableRule: string;
    GuidanceCost: number;
  }>(
    "SELECT Runs, Members, Guidance, GuidanceUnreliableRule, GuidanceCost FROM quench_tasks FINAL WHERE Machine = 'laptop'",
  );

test.skipIf(skip)("a task row replaces itself and a removed task disappears", async () => {
  expect((await postTask(task(6))).status).toBe(200);
  expect((await postTask(task(7))).status).toBe(200);
  const [row, ...rest] = await tasksNow();
  expect(rest).toEqual([]);
  expect(row!.Runs).toBe(7);
  expect(row!.Members).toHaveLength(2);
  expect(row).toMatchObject({
    Guidance: "unknown",
    GuidanceUnreliableRule: "lane#2",
    GuidanceCost: 0.00005,
  });
  expect((await postTask({ ...task(7), taskId: "nope" })).status).toBe(400);
  expect((await postTask(task(0, true))).status).toBe(200);
  expect(await tasksNow()).toEqual([]);
  await running.archive!.ch.exec("OPTIMIZE TABLE quench_tasks FINAL");
  expect(await tasksNow()).toEqual([]);
});

test.skipIf(skip)("the secret scan flags a synthetic token on arrival", async () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const fake = `ghp_${Array.from(crypto.getRandomValues(new Uint8Array(36)), (b) => alphabet[b % 62]).join("")}`;
  const raw = `${'{"type":"user","message":{"content":"hello"}}\n'.repeat(40_000)}{"type":"user","message":{"content":"export GH_TOKEN=${fake}"}}\n`;
  const response = await put("projects/demo/leaky.jsonl", raw);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ secretFindings: 1, bytes: raw.length });
  const listed = await owner.fetch(
    "/api/v1/archive/transcripts?machine=laptop&session=projects-demo-leaky-jsonl",
  );
  const { transcripts } = (await listed.json()) as {
    transcripts: { SecretFindings: number; SecretRules: string[] }[];
  };
  expect(transcripts).toEqual([
    expect.objectContaining({ SecretFindings: 1, SecretRules: ["github-pat"] }),
  ]);
  expect(JSON.stringify(transcripts)).not.toContain(fake);
});

test.skipIf(skip)(
  "a zstd bomb is refused at the raw cap with bounded memory and no event-loop stall, and nothing is kept",
  async () => {
    const bomb = await zeroBomb(MAX_TRANSCRIPT_BYTES + 144 * MiB);
    expect(bomb.length).toBeLessThan(64 * 1024);
    Bun.gc(true);
    const before = maxRss();
    let last = performance.now();
    let stall = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      stall = Math.max(stall, now - last);
      last = now;
    }, 5);
    const response = await asMachine("/api/v1/transcripts", {
      method: "PUT",
      headers: { "x-quench-transcript": header("projects/demo/bomb.jsonl", "f".repeat(64)) },
      body: bomb,
    });
    clearInterval(tick);
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toContain("decompressed");
    expect(stall).toBeLessThan(500);
    expect(maxRss() - before).toBeLessThan(192 * MiB);
    expect(existsSync(join(data, "tmp")) ? readdirSync(join(data, "tmp")) : []).toEqual([]);
    expect(
      existsSync(
        join(data, "archive", "laptop", "claude-code", "projects", "demo", "bomb.jsonl.zst"),
      ),
    ).toBe(false);
  },
  120_000,
);

test.skipIf(skip)(
  "a second upload while one is in flight gets 429 and the first still lands",
  async () => {
    const raw = "x".repeat(4 * MiB);
    const compressed = Bun.zstdCompressSync(raw);
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(compressed.subarray(0, 8));
        await held;
        controller.enqueue(compressed.subarray(8));
        controller.close();
      },
    });
    const first = put("projects/demo/slow.jsonl", raw, slow);
    await Bun.sleep(300);
    const second = await put("projects/demo/other.jsonl", "y\n");
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("5");
    release();
    expect((await first).status).toBe(200);
    expect((await put("projects/demo/other.jsonl", "y\n")).status).toBe(200);
  },
);

test.skipIf(skip)(
  "archive reads are owner-only, send no CORS headers, and reject bad times",
  async () => {
    const path =
      "/api/v1/archive/transcript?machine=laptop&harness=claude-code&path=projects%2Fdemo%2Fother.jsonl";
    const mine = await owner.fetch(path);
    expect(mine.status).toBe(200);
    const refused = [
      await asMachine(path),
      await call(path),
      await call(path, { headers: { origin: "https://evil.example" } }),
      await call(path, { headers: { cookie: "quench_hub=forged" } }),
    ];
    for (const response of [mine, ...refused]) {
      expect([...response.headers.keys()].filter((k) => k.startsWith("access-control"))).toEqual(
        [],
      );
    }
    expect(refused.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    for (const bad of ["from=yesterday", "to=2026-13-45", "from=1' OR 1=1"]) {
      const response = await owner.fetch(`/api/v1/archive/sessions?${bad}`);
      expect(response.status).toBe(400);
    }
    expect(
      (await owner.fetch("/api/v1/archive/sessions?from=2026-10-01&to=2026-11-01T00:00:00Z"))
        .status,
    ).toBe(200);
  },
);
