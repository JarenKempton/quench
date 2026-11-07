import { afterAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Archive } from "../../hub/src/archive.ts";
import { Owner, startHub, stopHubs } from "../../hub/test/helpers.ts";
import { CANARY, syntheticLogs, syntheticMetrics } from "./otlp-fixture.ts";

const CLICKHOUSE = process.env.QUENCH_TEST_CLICKHOUSE;
const NO_CLICKHOUSE = process.platform === "win32" ? "ClickHouse ships no Windows build" : null;
if (process.env.CI && !NO_CLICKHOUSE && !CLICKHOUSE)
  throw new Error("CI must set QUENCH_TEST_CLICKHOUSE to a ClickHouse binary");

const main = join(import.meta.dir, "../src/main.ts");
const fixtures = join(import.meta.dir, "../../history/test/fixtures/home");

let root = "";
const agents: ReturnType<typeof Bun.spawn>[] = [];
afterAll(async () => {
  for (const agent of agents) agent.kill();
  await Promise.all(agents.map((a) => a.exited));
  await stopHubs();
  if (root) await rm(root, { recursive: true, force: true });
}, 60_000);

const env = (home: string) => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: "",
  CODEX_HOME: "",
  PI_CODING_AGENT_DIR: "",
  TYPESAFE_API_KEY: "",
  QUENCH_JUDGE: "",
});

async function quench(home: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, main, ...args], {
    env: env(home),
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

async function age(dir: string, when: Date) {
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }))
    await utimes(join(entry.parentPath, entry.name), when, when);
}

async function freePort() {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

type ApiSession = {
  Machine: string;
  Harness: string;
  SessionId: string;
  Runs: number;
  Models: string[];
  InputTokens: number | null;
  ToolErrors: number;
  Compactions: number;
  otel: {
    available: boolean;
    costUsd: number | null;
    apiRequests: number | null;
    apiErrors: number | null;
    latencyMs: { p50: number; p95: number } | null;
    toolFailures: number | null;
    missing: string[];
  };
};

test.skipIf(!CLICKHOUSE)(
  `a machine without OTel and one with synthetic OTLP archive history and results to a hub with ClickHouse${NO_CLICKHOUSE ? ` (skipped: ${NO_CLICKHOUSE})` : ""}`,
  async () => {
    root = await mkdtemp(join(tmpdir(), "quench-archive-"));
    const sent: string[] = [];
    for (const method of ["logs", "metrics"] as const) {
      const original = Archive.prototype[method] as (...args: unknown[]) => Promise<number>;
      (Archive.prototype as unknown as Record<string, unknown>)[method] = function (
        this: Archive,
        ...args: unknown[]
      ) {
        sent.push(JSON.stringify(args.slice(1)));
        return original.apply(this, args);
      };
    }
    const running = await startHub(join(root, "hub", "data"), {
      archive: {
        bin: CLICKHOUSE!,
        dir: join(root, "hub", "clickhouse"),
        port: await freePort(),
        retention: "5y",
      },
    });
    const owner = new Owner(running.url, running.cert);
    await owner.login();

    const homes: Record<string, string> = {};
    for (const name of ["quiet", "traced"]) {
      const home = join(root, name);
      await mkdir(home, { recursive: true });
      for (const harness of [".claude", ".codex", ".pi"])
        await cp(join(fixtures, harness), join(home, harness), { recursive: true });
      await age(home, new Date(Date.now() - 2 * 3_600_000));
      const { code, pin } = await owner.addMachine(name);
      const connected = await quench(home, [
        "connect",
        running.url,
        "--code",
        code,
        ...(pin ? ["--pin", pin] : []),
      ]);
      expect(connected.code).toBe(0);
      homes[name] = home;
    }

    const quiet = await quench(homes.quiet!, ["agent", "run", "--once", "--interval", "60"]);
    expect(quiet.stderr).toBe("");
    expect(quiet.stdout).toContain("archived 4 sessions (4 results, 4 tasks)");

    const otlpPort = await freePort();
    const agent = Bun.spawn(
      [
        process.execPath,
        main,
        "agent",
        "run",
        "--interval",
        "60",
        "--otlp",
        `127.0.0.1:${otlpPort}`,
      ],
      { env: env(homes.traced!), stdout: "pipe", stderr: "pipe" },
    );
    agents.push(agent);
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${otlpPort}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
    await until("the agent's OTLP receiver", async () => (await post("/v1/logs", {}))?.ok);
    expect((await post("/v1/logs", syntheticLogs("s1", "c1")))!.status).toBe(200);
    expect((await post("/v1/metrics", syntheticMetrics("s1")))!.status).toBe(200);

    const api = async <T>(path: string) => {
      const response = await owner.fetch(path);
      expect(response.status).toBe(200);
      return (await response.json()) as T;
    };
    const sessions = async (machine: string) =>
      (await api<{ sessions: ApiSession[] }>(`/api/v1/archive/sessions?machine=${machine}`))
        .sessions;
    const traced = await until("the traced machine's sessions and OTel", async () => {
      const list = await sessions("traced");
      const s1 = list.find((s) => s.SessionId === "s1");
      return list.length === 4 && s1?.otel.available && list;
    });

    const quietList = await sessions("quiet");
    expect(quietList.map((s) => `${s.Harness}:${s.SessionId}`).sort()).toEqual(
      traced.map((s) => `${s.Harness}:${s.SessionId}`).sort(),
    );
    for (const s of quietList) {
      expect(s.otel.available).toBe(false);
      expect(s.otel.costUsd).toBeNull();
      expect(s.otel.missing[0]).toContain("OTel is off");
    }
    const quietS1 = quietList.find((s) => s.SessionId === "s1")!;
    expect(quietS1.Runs).toBeGreaterThan(0);
    expect(quietS1.Models).toContain("claude-opus-5-5");
    expect(quietS1.InputTokens).toBeGreaterThan(0);
    expect(quietS1.ToolErrors).toBeGreaterThan(0);
    expect(quietS1.Compactions).toBe(1);

    const s1 = traced.find((s) => s.SessionId === "s1")!;
    expect(s1.otel).toMatchObject({
      available: true,
      apiRequests: 2,
      apiErrors: 1,
      toolFailures: 1,
    });
    expect(s1.otel.costUsd).toBeCloseTo(0.75);
    expect(s1.otel.latencyMs!.p95).toBeGreaterThan(s1.otel.latencyMs!.p50);
    const c1 = traced.find((s) => s.SessionId === "c1")!;
    expect(c1.otel).toMatchObject({ available: true, costUsd: null, apiRequests: 1, apiErrors: 0 });
    expect(c1.otel.missing).toEqual(["this harness's OTel records no cost"]);

    const transcripts = (
      await api<{ transcripts: { Harness: string; Path: string; Bytes: number }[] }>(
        "/api/v1/archive/transcripts?machine=quiet",
      )
    ).transcripts;
    expect(transcripts).toHaveLength(4);
    const claude = transcripts.find((t) => t.Path === "projects/-work-demo/s1.jsonl")!;
    const download = await owner.fetch(
      `/api/v1/archive/transcript?machine=quiet&harness=claude-code&path=${encodeURIComponent(claude.Path)}`,
    );
    expect(download.status).toBe(200);
    expect(zstdDecompressSync(new Uint8Array(await download.arrayBuffer()))).toEqual(
      await readFile(join(homes.quiet!, ".claude", claude.Path)),
    );
    const anonymous = await fetch(
      `${running.url}/api/v1/archive/sessions`,
      running.cert ? { tls: { ca: running.cert } } : {},
    );
    expect(anonymous.status).toBe(401);

    const ch = running.archive!.ch;
    const [counts] = await ch.rows<{ logs: number; sse: number; sums: number }>(
      `SELECT (SELECT count() FROM otel_logs) AS logs,
              (SELECT count() FROM otel_logs WHERE EventName = 'codex.sse_event') AS sse,
              (SELECT count() FROM otel_metrics_sum WHERE Machine = 'traced') AS sums`,
    );
    expect(counts).toEqual({ logs: 9, sse: 0, sums: 1 });
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const body of sent) expect(body).not.toContain(CANARY);
    for (const table of [
      "otel_logs",
      "otel_metrics_sum",
      "otel_metrics_gauge",
      "otel_metrics_histogram",
    ])
      expect(await ch.exec(`SELECT * FROM ${table} FORMAT JSONEachRow`)).not.toContain(CANARY);
    expect(await readdir(join(homes.traced!, ".quench/fleet/otlp"))).toEqual([]);
    const taskRows = () =>
      ch.rows<{ Harnesses: string[]; Sessions: number; Split: string }>(
        "SELECT Harnesses, Sessions, Split FROM quench_tasks FINAL WHERE Machine = 'quiet' ORDER BY StartedAt",
      );
    const tasksBefore = await taskRows();
    expect(
      tasksBefore.map((t) => `${t.Harnesses.join("+")}:${t.Sessions}:${t.Split}`).sort(),
    ).toEqual([
      "claude-code:1:heuristic",
      "claude-code:1:heuristic",
      "codex:1:heuristic",
      "pi:1:heuristic",
    ]);

    const again = await quench(homes.quiet!, ["agent", "run", "--once", "--interval", "60"]);
    expect(again.stdout).not.toContain("archived");
    const resumed = join(homes.quiet!, ".claude", claude.Path);
    await Bun.write(
      resumed,
      `${await readFile(resumed, "utf8")}${(await readFile(resumed, "utf8")).split("\n")[0]}\n`,
    );
    await utimes(resumed, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const grown = await quench(homes.quiet!, ["agent", "run", "--once", "--interval", "60"]);
    expect(grown.stdout).toContain("archived 1 sessions (1 results, 0 tasks)");
    expect(await taskRows()).toEqual(tasksBefore);
    const [latest] = await ch.rows<{ Bytes: number }>(
      "SELECT Bytes FROM quench_transcripts FINAL WHERE Machine = 'quiet' AND Path = {path:String}",
      { path: claude.Path },
    );
    expect(latest!.Bytes).toBe((await stat(resumed)).size);
    const [ttl] = await ch.rows<{ engine_full: string }>(
      "SELECT engine_full FROM system.tables WHERE database = 'quench' AND name = 'otel_logs'",
    );
    expect(ttl!.engine_full).toContain("toIntervalYear(5)");
  },
  300_000,
);
