import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOtlp } from "../src/commands/agent-otlp.ts";
import { CANARY, syntheticLogs, syntheticMetrics } from "./otlp-fixture.ts";

let root = "";
afterAll(() => root && rm(root, { recursive: true, force: true }));

test("the agent's OTLP receiver strips planted values before anything is spooled to send", async () => {
  root = await mkdtemp(join(tmpdir(), "quench-otlp-"));
  const otlp = await startOtlp(root, "127.0.0.1:0");
  const post = (path: string, body: unknown, type = "application/json") =>
    fetch(`http://127.0.0.1:${otlp.port}${path}`, {
      method: "POST",
      headers: { "content-type": type },
      body: JSON.stringify(body),
    });
  try {
    expect((await post("/v1/logs", syntheticLogs("s1", "c1"))).status).toBe(200);
    expect((await post("/v1/metrics", syntheticMetrics("s1"))).status).toBe(200);
    expect((await post("/v1/logs", {}, "application/x-protobuf")).status).toBe(415);
    await otlp.flush();
  } finally {
    await otlp.stop();
  }

  const files = (await readdir(join(root, "otlp"))).sort();
  expect(files).toHaveLength(2);
  const sent = await Promise.all(
    files.map(async (f) =>
      new TextDecoder().decode(Bun.zstdDecompressSync(await readFile(join(root, "otlp", f)))),
    ),
  );
  for (const text of sent) expect(text).not.toContain(CANARY);
  const logs = JSON.parse(sent.find((t) => t.includes("resourceLogs"))!);
  const names = logs.resourceLogs.flatMap(
    (r: { scopeLogs: { logRecords: { eventName: string }[] }[] }) =>
      r.scopeLogs.flatMap((s) => s.logRecords.map((l) => l.eventName)),
  );
  expect(names).not.toContain("codex.sse_event");
  expect(names).toHaveLength(9);
  expect(sent.join("")).toContain('"note.length"');
  expect(sent.join("")).toContain('"cost_usd"');
  expect(otlp.stats.dropped).toMatchObject({
    "event:codex.sse_event": 1,
    "attribute:prompt": 2,
    "attribute:arguments": 1,
    "attribute:output": 1,
    "attribute:tool_parameters": 1,
    "attribute:user.email": 4,
    "attribute:user.account_uuid": 3,
    "attribute:long": 1,
    "attribute:nested": 1,
    "metric:exponentialHistogram": 1,
    body: 1,
  });
  expect(otlp.stats.error).toContain("connection.json");
});
