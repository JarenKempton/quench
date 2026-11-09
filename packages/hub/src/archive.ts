import {
  retentionCutoff,
  stripLogs,
  stripMetrics,
  valueText,
  type KeyValue,
  type LogsRequest,
  type MetricsRequest,
  type SessionResult,
  type TaskResult,
  type TranscriptUpload,
} from "@quench/fleet";
import type { ClickHouse, Params } from "./clickhouse.ts";
import type { DataDir } from "./data.ts";
import { receiveTranscript, Rejected } from "./intake.ts";
import { migrate } from "./schema.ts";

export { Rejected };

export class Busy extends Error {}

const attrs = (list: KeyValue[] | undefined) =>
  Object.fromEntries((list ?? []).map((kv) => [kv.key, valueText(kv.value)]));

export function nanoTime(value: string | number | undefined, fallback: Date) {
  let nanos: bigint;
  try {
    nanos =
      value === undefined || value === "" || value === "0" || value === 0 ? 0n : BigInt(value);
  } catch {
    nanos = 0n;
  }
  if (nanos <= 0n) nanos = BigInt(fallback.getTime()) * 1_000_000n;
  const iso = new Date(Number(nanos / 1_000_000n)).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${String(nanos % 1_000_000_000n).padStart(9, "0")}`;
}

const msTime = (iso: string) => iso.replace("T", " ").replace(/Z$|[+-]\d\d:\d\d$/, "");

const stringArray = (values: string[]) =>
  `[${values.map((v) => `'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`).join(",")}]`;

const num = (v: string | number | undefined) => (v === undefined ? 0 : Number(v));

function resourceOf(
  machine: string,
  resource: { attributes?: KeyValue[] | undefined } | undefined,
  scope:
    | {
        name?: string | undefined;
        version?: string | undefined;
        attributes?: KeyValue[] | undefined;
      }
    | undefined,
  schemaUrl: string | undefined,
) {
  const ResourceAttributes: Record<string, string> = {
    ...attrs(resource?.attributes),
    "quench.machine": machine,
  };
  return {
    ResourceAttributes,
    ResourceSchemaUrl: schemaUrl ?? "",
    ScopeName: scope?.name ?? "",
    ScopeVersion: scope?.version ?? "",
    ScopeAttributes: attrs(scope?.attributes),
    ServiceName: ResourceAttributes["service.name"] ?? "",
  };
}

export function logRows(machine: string, request: LogsRequest, now: Date) {
  const rows: object[] = [];
  for (const rl of request.resourceLogs ?? [])
    for (const sl of rl.scopeLogs ?? []) {
      const resource = resourceOf(machine, rl.resource, sl.scope, rl.schemaUrl);
      for (const r of sl.logRecords ?? []) {
        const LogAttributes = attrs(r.attributes);
        rows.push({
          Timestamp: nanoTime(r.timeUnixNano ?? r.observedTimeUnixNano, now),
          TraceId: r.traceId ?? "",
          SpanId: r.spanId ?? "",
          TraceFlags: (r.flags ?? 0) & 0xff,
          SeverityText: r.severityText ?? "",
          SeverityNumber: r.severityNumber ?? 0,
          EventName: r.eventName || LogAttributes["event.name"] || "",
          Body: r.body?.stringValue ?? "",
          LogAttributes,
          ...resource,
        });
      }
    }
  return rows;
}

export function metricRows(machine: string, request: MetricsRequest, now: Date) {
  const sum: object[] = [];
  const gauge: object[] = [];
  const histogram: object[] = [];
  for (const rm of request.resourceMetrics ?? [])
    for (const sm of rm.scopeMetrics ?? []) {
      const resource = resourceOf(machine, rm.resource, sm.scope, rm.schemaUrl);
      for (const m of sm.metrics ?? []) {
        const base = (p: {
          attributes?: KeyValue[] | undefined;
          startTimeUnixNano?: string | number | undefined;
          timeUnixNano?: string | number | undefined;
          flags?: number | undefined;
        }) => ({
          ...resource,
          MetricName: m.name,
          MetricDescription: m.description ?? "",
          MetricUnit: m.unit ?? "",
          Attributes: attrs(p.attributes),
          StartTimeUnix: nanoTime(p.startTimeUnixNano, now),
          TimeUnix: nanoTime(p.timeUnixNano, now),
          Flags: p.flags ?? 0,
        });
        for (const p of m.sum?.dataPoints ?? [])
          sum.push({
            ...base(p),
            Value: num(p.asDouble ?? p.asInt),
            AggregationTemporality: m.sum?.aggregationTemporality ?? 0,
            IsMonotonic: m.sum?.isMonotonic ?? false,
          });
        for (const p of m.gauge?.dataPoints ?? [])
          gauge.push({ ...base(p), Value: num(p.asDouble ?? p.asInt) });
        for (const p of m.histogram?.dataPoints ?? [])
          histogram.push({
            ...base(p),
            Count: num(p.count),
            Sum: num(p.sum),
            BucketCounts: (p.bucketCounts ?? []).map(num),
            ExplicitBounds: (p.explicitBounds ?? []).map(num),
            Min: num(p.min),
            Max: num(p.max),
            AggregationTemporality: m.histogram?.aggregationTemporality ?? 0,
          });
      }
    }
  return { sum, gauge, histogram };
}

export function sessionRow(machine: string, s: SessionResult, fallback: string, now: Date) {
  return {
    Machine: machine,
    Harness: s.harness,
    SessionId: s.sessionId,
    Parent: s.parent ?? "",
    Path: s.path,
    Sha256: s.sha256,
    Cwd: s.cwd ?? "",
    Branch: s.branch ?? "",
    StartedAt: msTime(s.startedAt ?? fallback),
    StartKnown: s.startedAt !== null,
    EndedAt: s.endedAt === null ? null : msTime(s.endedAt),
    Runs: s.runs,
    FinishedRuns: s.finishedRuns,
    Models: s.models,
    InputTokens: s.inputTokens,
    CacheReadTokens: s.cacheReadTokens,
    CacheWriteTokens: s.cacheWriteTokens,
    OutputTokens: s.outputTokens,
    ToolCalls: s.toolCalls,
    ToolErrors: s.toolErrors,
    Compactions: s.compactions,
    Subagents: s.subagents,
    Replies: s.replies,
    Corrections: s.corrections,
    UnclassifiedReplies: s.unclassifiedReplies,
    Signals: s.signals,
    SkillsInvoked: s.skillsInvoked,
    JudgeId: s.judgeId,
    AnalysisVersion: s.analysisVersion,
    ComputedAt: msTime(now.toISOString()),
  };
}

export function taskRow(machine: string, t: TaskResult, now: Date) {
  return {
    Machine: machine,
    TaskId: t.taskId,
    StartedAt: msTime(t.startedAt),
    EndedAt: msTime(t.endedAt),
    Split: t.split,
    Boundary: t.boundary,
    Markers: t.markers,
    Members: t.members.map((m) => ({
      Harness: m.harness,
      SessionId: m.sessionId,
      FirstTurn: m.firstTurn,
      LastTurn: m.lastTurn,
    })),
    Harnesses: t.harnesses,
    Sessions: t.sessions,
    Runs: t.runs,
    Guidance: t.guidance,
    GuidanceRule: t.guidanceRule ?? "",
    GuidanceTurns: t.guidanceTurns,
    GuidanceCost: t.guidanceCost,
    AnalysisVersion: t.analysisVersion,
    ComputedAt: msTime(now.toISOString()),
    Removed: t.removed ? 1 : 0,
  };
}

const API_EVENTS = "('claude_code.api_request', 'codex.api_request')";
const ERROR_EVENTS = "('claude_code.api_error')";
const TOOL_EVENTS = "('claude_code.tool_result', 'codex.tool_result')";

export type SessionFilter = {
  machine?: string;
  harness?: string;
  session?: string;
  from?: string;
  to?: string;
  limit: number;
};

type SessionRow = Record<string, unknown> & {
  Machine: string;
  Harness: string;
  OtelEvents: number | null;
  CostUsd: number | null;
  CostEvents: number | null;
  ApiRequests: number | null;
  ApiErrors: number | null;
  LatencyP50Ms: number | null;
  LatencyP95Ms: number | null;
  ToolFailures: number | null;
};

const MISSING_OTEL =
  "no OTel events for this session: OTel is off for this harness or machine, so cost, latency and per-call errors are unknown";
const NO_COST = "this harness's OTel records no cost";

function otelOf(row: SessionRow) {
  const { OtelEvents, CostUsd, CostEvents, ApiRequests, ApiErrors, LatencyP50Ms, LatencyP95Ms } =
    row;
  if (!OtelEvents)
    return {
      available: false,
      costUsd: null,
      apiRequests: null,
      apiErrors: null,
      latencyMs: null,
      toolFailures: null,
      missing: [MISSING_OTEL],
    };
  return {
    available: true,
    costUsd: CostEvents ? CostUsd : null,
    apiRequests: ApiRequests,
    apiErrors: ApiErrors,
    latencyMs: ApiRequests ? { p50: LatencyP50Ms, p95: LatencyP95Ms } : null,
    toolFailures: row.ToolFailures,
    missing: CostEvents ? [] : [NO_COST],
  };
}

export class Archive {
  private sweeper: ReturnType<typeof setInterval> | null = null;

  private constructor(
    readonly ch: ClickHouse,
    readonly data: DataDir,
    readonly retention: string,
    private readonly now: () => number,
    private readonly log: (line: string) => void,
  ) {}

  static async open(
    ch: ClickHouse,
    data: DataDir,
    retention: string,
    now: () => number = Date.now,
    log: (line: string) => void = () => {},
  ) {
    await migrate(ch, retention);
    const archive = new Archive(ch, data, retention, now, log);
    await archive.sweep();
    archive.sweeper = setInterval(
      () => void archive.sweep().catch((e) => log(`archive sweep failed: ${e.message}`)),
      86_400_000,
    );
    archive.sweeper.unref?.();
    return archive;
  }

  close() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  async logs(machine: string, request: LogsRequest) {
    const { request: clean } = stripLogs(request);
    const rows = logRows(machine, clean, new Date(this.now()));
    await this.ch.insert("otel_logs", rows);
    return rows.length;
  }

  async metrics(machine: string, raw: unknown, request: MetricsRequest) {
    const { request: clean } = stripMetrics(raw, request);
    const { sum, gauge, histogram } = metricRows(machine, clean, new Date(this.now()));
    await this.ch.insert("otel_metrics_sum", sum);
    await this.ch.insert("otel_metrics_gauge", gauge);
    await this.ch.insert("otel_metrics_histogram", histogram);
    return sum.length + gauge.length + histogram.length;
  }

  async sessions(machine: string, sessions: SessionResult[]) {
    const now = new Date(this.now());
    const known = await this.modifiedAt(machine, sessions);
    const rows = sessions.map((s) =>
      sessionRow(machine, s, known.get(`${s.harness}\0${s.path}`) ?? now.toISOString(), now),
    );
    await this.ch.insert("quench_sessions", rows);
    return rows.length;
  }

  async tasks(machine: string, tasks: TaskResult[]) {
    const now = new Date(this.now());
    const rows = tasks.map((t) => taskRow(machine, t, now));
    await this.ch.insert("quench_tasks", rows);
    return rows.length;
  }

  private async modifiedAt(machine: string, sessions: SessionResult[]) {
    if (!sessions.length) return new Map<string, string>();
    const rows = await this.ch.rows<{ Harness: string; Path: string; ModifiedAt: string }>(
      `SELECT Harness, Path, toString(ModifiedAt) AS ModifiedAt FROM quench_transcripts FINAL
       WHERE Machine = {machine:String} AND Path IN {paths:Array(String)}`,
      { machine, paths: stringArray(sessions.map((s) => s.path)) },
    );
    return new Map(
      rows.map((r) => [`${r.Harness}\0${r.Path}`, `${r.ModifiedAt.replace(" ", "T")}Z`]),
    );
  }

  private parts(machine: string, harness: string, path: string) {
    const segments = path.split("/");
    segments[segments.length - 1] = `${segments.at(-1)}.zst`;
    return ["archive", machine, harness, ...segments];
  }

  private receiving = false;

  async transcript(machine: string, upload: TranscriptUpload, body: AsyncIterable<Uint8Array>) {
    if (this.receiving) throw new Busy("the hub is receiving another transcript; retry shortly");
    this.receiving = true;
    try {
      const got = await receiveTranscript(this.data, body);
      if (got.sha256 !== upload.sha256) {
        await this.data.remove(...got.tmp);
        throw new Rejected("the transcript does not match its sha256");
      }
      await this.data.move(got.tmp, this.parts(machine, upload.harness, upload.path));
      await this.ch.insert("quench_transcripts", [
        {
          Machine: machine,
          Harness: upload.harness,
          SessionId: upload.sessionId,
          Path: upload.path,
          Sha256: upload.sha256,
          Bytes: got.raw,
          StoredBytes: got.stored,
          SecretFindings: got.secrets.findings,
          SecretRules: [...got.secrets.rules].sort(),
          ModifiedAt: msTime(upload.modifiedAt),
          ArchivedAt: msTime(new Date(this.now()).toISOString()),
        },
      ]);
      return { bytes: got.raw, stored: got.stored, secretFindings: got.secrets.findings };
    } finally {
      this.receiving = false;
    }
  }

  async readTranscript(machine: string, harness: string, path: string) {
    return this.data.read(this.parts(machine, harness, path));
  }

  async listTranscripts(filter: SessionFilter) {
    const { where, params } = this.where(filter, "ModifiedAt");
    return this.ch.rows(
      `SELECT Machine, Harness, SessionId, Path, Sha256, Bytes, StoredBytes, SecretFindings,
              SecretRules, ModifiedAt, ArchivedAt
       FROM quench_transcripts FINAL ${where}
       ORDER BY ModifiedAt DESC LIMIT {limit:UInt32}`,
      params,
    );
  }

  private where(filter: SessionFilter, time: string) {
    const clauses: string[] = [];
    const params: Params = { limit: filter.limit };
    if (filter.machine) {
      clauses.push("Machine = {machine:String}");
      params.machine = filter.machine;
    }
    if (filter.harness) {
      clauses.push("Harness = {harness:String}");
      params.harness = filter.harness;
    }
    if (filter.session) {
      clauses.push("SessionId = {session:String}");
      params.session = filter.session;
    }
    if (filter.from) {
      clauses.push(`${time} >= parseDateTime64BestEffort({from:String}, 3)`);
      params.from = filter.from;
    }
    if (filter.to) {
      clauses.push(`${time} < parseDateTime64BestEffort({to:String}, 3)`);
      params.to = filter.to;
    }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  async listSessions(filter: SessionFilter) {
    const { where, params } = this.where(filter, "StartedAt");
    const rows = await this.ch.rows<SessionRow>(
      `WITH s AS (
         SELECT * FROM quench_sessions FINAL ${where}
         ORDER BY StartedAt DESC LIMIT {limit:UInt32}
       ),
       o AS (
         SELECT Machine, SessionId,
           count() AS OtelEvents,
           sumIf(toFloat64OrZero(LogAttributes['cost_usd']), EventName = 'claude_code.api_request') AS CostUsd,
           countIf(EventName = 'claude_code.api_request' AND LogAttributes['cost_usd'] != '') AS CostEvents,
           countIf(EventName IN ${API_EVENTS}) AS ApiRequests,
           countIf(EventName IN ${ERROR_EVENTS}
             OR (EventName IN ${API_EVENTS} AND toUInt16OrZero(LogAttributes['http.response.status_code']) >= 400)) AS ApiErrors,
           quantileIf(0.5)(toFloat64OrZero(LogAttributes['duration_ms']), EventName IN ${API_EVENTS}) AS LatencyP50Ms,
           quantileIf(0.95)(toFloat64OrZero(LogAttributes['duration_ms']), EventName IN ${API_EVENTS}) AS LatencyP95Ms,
           countIf(EventName IN ${TOOL_EVENTS} AND LogAttributes['success'] = 'false') AS ToolFailures
         FROM otel_logs
         WHERE (Machine, SessionId) IN (SELECT Machine, SessionId FROM s)
         GROUP BY Machine, SessionId
       )
       SELECT s.*, o.OtelEvents, o.CostUsd, o.CostEvents, o.ApiRequests, o.ApiErrors,
              o.LatencyP50Ms, o.LatencyP95Ms, o.ToolFailures
       FROM s LEFT JOIN o ON s.Machine = o.Machine AND s.SessionId = o.SessionId
       ORDER BY s.StartedAt DESC`,
      params,
      { join_use_nulls: 1 },
    );
    return rows.map((row) => {
      const {
        OtelEvents: _e,
        CostUsd: _c,
        CostEvents: _ce,
        ApiRequests: _a,
        ApiErrors: _ae,
        LatencyP50Ms: _p50,
        LatencyP95Ms: _p95,
        ToolFailures: _t,
        ...session
      } = row;
      return { ...session, otel: otelOf(row) };
    });
  }

  async sweep() {
    const cutoff = retentionCutoff(this.retention, new Date(this.now()));
    if (!cutoff) return 0;
    const expired = await this.ch.rows<{ Machine: string; Harness: string; Path: string }>(
      `SELECT Machine, Harness, Path FROM quench_transcripts FINAL
       WHERE ModifiedAt < parseDateTime64BestEffort({cutoff:String}, 3)`,
      { cutoff: cutoff.toISOString() },
    );
    for (const row of expired) {
      const parts = this.parts(row.Machine, row.Harness, row.Path);
      await this.data.remove(...parts);
    }
    if (expired.length) this.log(`archive: removed ${expired.length} transcripts past retention`);
    return expired.length;
  }
}
