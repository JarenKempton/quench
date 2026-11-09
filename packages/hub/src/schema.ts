import { retentionInterval } from "@quench/fleet";
import { ClickHouseError, type ClickHouse } from "./clickhouse.ts";

const ATTRS = "Map(LowCardinality(String), String) CODEC(ZSTD(1))";
const RESOURCE = `
  ResourceAttributes ${ATTRS},
  ResourceSchemaUrl LowCardinality(String),
  ScopeName String,
  ScopeVersion LowCardinality(String),
  ScopeAttributes ${ATTRS},
  ServiceName LowCardinality(String),
  Machine LowCardinality(String) MATERIALIZED ResourceAttributes['quench.machine']`;
const METRIC = `${RESOURCE},
  MetricName LowCardinality(String),
  MetricDescription String CODEC(ZSTD(1)),
  MetricUnit LowCardinality(String),
  Attributes ${ATTRS},
  StartTimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
  TimeUnix DateTime64(9) CODEC(Delta, ZSTD(1)),
  Flags UInt32`;
const METRIC_TAIL = `ENGINE = MergeTree
PARTITION BY toYYYYMM(TimeUnix)
ORDER BY (Machine, ServiceName, MetricName, toUnixTimestamp64Nano(TimeUnix))
SETTINGS ttl_only_drop_parts = 1`;

export const TABLES: { name: string; ttl: string; ddl: string }[] = [
  {
    name: "otel_logs",
    ttl: "TimestampTime",
    ddl: `CREATE TABLE IF NOT EXISTS otel_logs (
  Timestamp DateTime64(9) CODEC(Delta, ZSTD(1)),
  TimestampTime DateTime DEFAULT toDateTime(Timestamp),
  TraceId String CODEC(ZSTD(1)),
  SpanId String CODEC(ZSTD(1)),
  TraceFlags UInt8,
  SeverityText LowCardinality(String),
  SeverityNumber UInt8,
  EventName LowCardinality(String),
  Body String CODEC(ZSTD(1)),
  LogAttributes ${ATTRS},${RESOURCE},
  SessionId String MATERIALIZED if(LogAttributes['session.id'] != '', LogAttributes['session.id'], LogAttributes['conversation.id']),
  INDEX idx_session SessionId TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = MergeTree
PARTITION BY toYYYYMM(TimestampTime)
ORDER BY (Machine, ServiceName, EventName, TimestampTime)
SETTINGS ttl_only_drop_parts = 1`,
  },
  {
    name: "otel_metrics_sum",
    ttl: "toDateTime(TimeUnix)",
    ddl: `CREATE TABLE IF NOT EXISTS otel_metrics_sum (${METRIC},
  Value Float64,
  AggregationTemporality Int32,
  IsMonotonic Bool
) ${METRIC_TAIL}`,
  },
  {
    name: "otel_metrics_gauge",
    ttl: "toDateTime(TimeUnix)",
    ddl: `CREATE TABLE IF NOT EXISTS otel_metrics_gauge (${METRIC},
  Value Float64
) ${METRIC_TAIL}`,
  },
  {
    name: "otel_metrics_histogram",
    ttl: "toDateTime(TimeUnix)",
    ddl: `CREATE TABLE IF NOT EXISTS otel_metrics_histogram (${METRIC},
  Count UInt64,
  Sum Float64,
  BucketCounts Array(UInt64),
  ExplicitBounds Array(Float64),
  Min Float64,
  Max Float64,
  AggregationTemporality Int32
) ${METRIC_TAIL}`,
  },
  {
    name: "quench_sessions",
    ttl: "toDateTime(StartedAt)",
    ddl: `CREATE TABLE IF NOT EXISTS quench_sessions (
  Machine LowCardinality(String),
  Harness LowCardinality(String),
  SessionId String,
  Parent String,
  Path String,
  Sha256 FixedString(64),
  Cwd String,
  Branch String,
  StartedAt DateTime64(3),
  StartKnown Bool,
  EndedAt Nullable(DateTime64(3)),
  Runs UInt32,
  FinishedRuns UInt32,
  Models Array(LowCardinality(String)),
  InputTokens Nullable(UInt64),
  CacheReadTokens Nullable(UInt64),
  CacheWriteTokens Nullable(UInt64),
  OutputTokens Nullable(UInt64),
  ToolCalls UInt32,
  ToolErrors UInt32,
  Compactions UInt32,
  Subagents UInt32,
  Replies Map(LowCardinality(String), UInt32),
  Corrections Map(LowCardinality(String), UInt32),
  UnclassifiedReplies UInt32,
  Signals Map(LowCardinality(String), UInt32),
  SkillsInvoked Array(LowCardinality(String)),
  JudgeId LowCardinality(String),
  AnalysisVersion UInt32,
  ComputedAt DateTime64(3),
  Version UInt64 MATERIALIZED toUInt64(AnalysisVersion) * 10000000000000 + toUInt64(toUnixTimestamp64Milli(ComputedAt))
) ENGINE = ReplacingMergeTree(Version)
PARTITION BY toYYYYMM(StartedAt)
ORDER BY (Machine, Harness, SessionId, Path)
SETTINGS ttl_only_drop_parts = 1`,
  },
  {
    name: "quench_tasks",
    ttl: "toDateTime(StartedAt)",
    ddl: `CREATE TABLE IF NOT EXISTS quench_tasks (
  Machine LowCardinality(String),
  TaskId FixedString(32),
  StartedAt DateTime64(3),
  EndedAt DateTime64(3),
  Split LowCardinality(String),
  Boundary LowCardinality(String),
  Markers Array(String),
  Members Array(Tuple(Harness LowCardinality(String), SessionId String, FirstTurn UInt32, LastTurn UInt32)),
  Harnesses Array(LowCardinality(String)),
  Sessions UInt32,
  Runs UInt32,
  AnalysisVersion UInt32,
  ComputedAt DateTime64(3),
  Removed UInt8,
  Version UInt64 MATERIALIZED toUInt64(AnalysisVersion) * 10000000000000 + toUInt64(toUnixTimestamp64Milli(ComputedAt))
) ENGINE = ReplacingMergeTree(Version, Removed)
PARTITION BY toYYYYMM(StartedAt)
ORDER BY (Machine, TaskId)
SETTINGS ttl_only_drop_parts = 1`,
  },
  {
    name: "quench_transcripts",
    ttl: "toDateTime(ModifiedAt)",
    ddl: `CREATE TABLE IF NOT EXISTS quench_transcripts (
  Machine LowCardinality(String),
  Harness LowCardinality(String),
  SessionId String,
  Path String,
  Sha256 FixedString(64),
  Bytes UInt64,
  StoredBytes UInt64,
  SecretFindings UInt32,
  SecretRules Array(LowCardinality(String)),
  ModifiedAt DateTime64(3),
  ArchivedAt DateTime64(3)
) ENGINE = ReplacingMergeTree(ArchivedAt)
PARTITION BY toYYYYMM(ModifiedAt)
ORDER BY (Machine, Harness, Path)
SETTINGS ttl_only_drop_parts = 1`,
  },
];

export async function migrate(ch: ClickHouse, retention: string) {
  await ch.exec(`CREATE DATABASE IF NOT EXISTS ${ch.database}`, {}, { database: "default" });
  const interval = retentionInterval(retention);
  for (const table of TABLES) {
    await ch.exec(table.ddl);
    if (interval)
      await ch.exec(
        `ALTER TABLE ${table.name} MODIFY TTL ${table.ttl} + ${interval}`,
        {},
        { materialize_ttl_after_modify: 0 },
      );
    else
      await ch.exec(`ALTER TABLE ${table.name} REMOVE TTL`).catch((error) => {
        if (!(error instanceof ClickHouseError) || !/TTL/i.test(error.message)) throw error;
      });
  }
}
