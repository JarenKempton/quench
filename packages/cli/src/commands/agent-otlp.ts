import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  LogsRequest,
  MAX_OTLP_BYTES,
  MetricsRequest,
  stripLogs,
  stripMetrics,
  type Dropped,
} from "@quench/fleet";
import { postOtlp } from "@quench/hub/client";
import { isLoopback } from "@quench/hub";

export const SPOOL_BYTES = 256 * 1024 * 1024;
export const DEFAULT_OTLP = "127.0.0.1:4318";

export type OtlpStats = {
  listening: string;
  accepted: number;
  dropped: Dropped;
  spoolDropped: number;
  forwarded: number;
  error: string | null;
};

export function otlpListen(raw: string) {
  const match = /^\[?([^\]]*?)\]?:(\d+)$/.exec(raw);
  if (!match) throw new Error("--otlp must be <host>:<port>, such as 127.0.0.1:4318");
  const hostname = match[1]!;
  if (!isLoopback(hostname))
    throw new Error("--otlp must listen on a loopback address such as 127.0.0.1");
  return { hostname, port: Number(match[2]) };
}

const add = (into: Dropped, from: Dropped) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

async function body(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_OTLP_BYTES) return null;
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_OTLP_BYTES) return null;
  const encoding = req.headers.get("content-encoding");
  if (!encoding) return bytes;
  if (encoding !== "gzip") return null;
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_OTLP_BYTES });
  } catch {
    return null;
  }
}

const parse = (bytes: Uint8Array) => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
};

export async function startOtlp(dir: string, listen: string) {
  const spool = join(dir, "otlp");
  await mkdir(spool, { recursive: true, mode: 0o700 });
  const address = otlpListen(listen);
  const stats: OtlpStats = {
    listening: listen,
    accepted: 0,
    dropped: {},
    spoolDropped: 0,
    forwarded: 0,
    error: null,
  };
  let sequence = 0;

  const trim = async () => {
    const files = (await readdir(spool)).filter((f) => f.endsWith(".zst")).sort();
    const sizes = await Promise.all(files.map((f) => stat(join(spool, f)).then((s) => s.size)));
    let total = sizes.reduce((a, b) => a + b, 0);
    for (let i = 0; total > SPOOL_BYTES && i < files.length; i++) {
      await rm(join(spool, files[i]!), { force: true });
      total -= sizes[i]!;
      stats.spoolDropped++;
    }
  };

  let flushing: Promise<void> = Promise.resolve();
  const flush = () => {
    flushing = flushing.then(async () => {
      for (const file of (await readdir(spool)).filter((f) => f.endsWith(".zst")).sort()) {
        const kind = file.includes("-logs") ? "logs" : "metrics";
        try {
          await postOtlp(dir, kind, await readFile(join(spool, file)));
          await rm(join(spool, file), { force: true });
          stats.forwarded++;
          stats.error = null;
        } catch (error) {
          stats.error = (error as Error).message;
          return;
        }
      }
    });
    return flushing;
  };

  const accept = async (kind: "logs" | "metrics", raw: unknown) => {
    let kept: number;
    let clean: unknown;
    if (kind === "logs") {
      const parsed = LogsRequest.safeParse(raw);
      if (!parsed.success) return false;
      const stripped = stripLogs(parsed.data);
      add(stats.dropped, stripped.dropped);
      ({ kept, request: clean } = stripped);
    } else {
      const parsed = MetricsRequest.safeParse(raw);
      if (!parsed.success) return false;
      const stripped = stripMetrics(raw, parsed.data);
      add(stats.dropped, stripped.dropped);
      ({ kept, request: clean } = stripped);
    }
    stats.accepted += kept;
    if (kept) {
      const name = `${Date.now().toString().padStart(14, "0")}-${String(sequence++).padStart(6, "0")}-${kind}.zst`;
      await writeFile(join(spool, name), Bun.zstdCompressSync(JSON.stringify(clean)), {
        mode: 0o600,
      });
      await trim();
      void flush();
    }
    return true;
  };

  const server = Bun.serve({
    ...address,
    maxRequestBodySize: MAX_OTLP_BYTES,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const kind = path === "/v1/logs" ? "logs" : path === "/v1/metrics" ? "metrics" : null;
      if (!kind || req.method !== "POST")
        return Response.json({ error: "not found" }, { status: 404 });
      if (!(req.headers.get("content-type") ?? "").includes("json"))
        return Response.json(
          { error: "send OTLP as JSON (http/json); protobuf is not accepted" },
          { status: 415 },
        );
      const bytes = await body(req);
      if (!bytes)
        return Response.json({ error: "body too large or badly encoded" }, { status: 413 });
      const ok = await accept(kind, parse(bytes));
      if (!ok) return Response.json({ error: `invalid OTLP ${kind}` }, { status: 400 });
      return Response.json({});
    },
  });
  void flush();
  return {
    stats,
    port: server.port,
    flush,
    async stop() {
      await server.stop(true);
      await flushing;
    },
  };
}

export const otlpLine = (stats: OtlpStats) =>
  `; otel ${stats.accepted} kept, ${Object.values(stats.dropped).reduce((a, b) => a + b, 0)} stripped, ${stats.forwarded} batches sent${stats.spoolDropped ? `, ${stats.spoolDropped} batches lost to the spool cap` : ""}${stats.error ? `, ${stats.error}` : ""}`;

export const otelSettings = (listen: string) => {
  const origin = `http://${listen}`;
  return `Quench never edits harness config. To send OTel through this agent, set these yourself:

Claude Code (environment, e.g. in ~/.claude/settings.json "env"):
  CLAUDE_CODE_ENABLE_TELEMETRY=1
  OTEL_LOGS_EXPORTER=otlp
  OTEL_METRICS_EXPORTER=otlp
  OTEL_EXPORTER_OTLP_PROTOCOL=http/json
  OTEL_EXPORTER_OTLP_ENDPOINT=${origin}

Codex (~/.codex/config.toml):
  [otel]
  log_user_prompt = false
  exporter = { otlp-http = { endpoint = "${origin}/v1/logs", protocol = "json" } }

Then run the agent with --otlp ${listen}. Before anything leaves this machine the agent drops
codex.sse_event, prompts, tool arguments and output, user.email and account ids, and any
attribute longer than 256 characters.
`;
};
