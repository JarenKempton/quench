#!/usr/bin/env bash
set -euo pipefail
rows=${ROWS:-1200000000}
chunk=${CHUNK:-100000000}
memory=${MEMORY:-3g}
name=quench-scale-$$
image=${IMAGE:-quench-hub:scale}

docker build -q -t "$image" . >/dev/null
spacing=$((31536000000000000 / rows))
docker run -d --name "$name" --memory "$memory" --memory-swap "$memory" \
  -e QUENCH_HUB_PASSWORD=scale-test-password "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null; docker volume prune -f >/dev/null' EXIT
for _ in $(seq 120); do docker logs "$name" 2>&1 | grep -q "Archive in ClickHouse" && break; sleep 1; done
docker logs "$name" 2>&1 | grep "Archive in ClickHouse"

q() {
  docker exec "$name" sh -c 'wget -qO- --content-on-error --header "X-ClickHouse-User: quench" \
    --header "X-ClickHouse-Key: $(cat /data/clickhouse-password)" \
    --post-data "$1" "http://127.0.0.1:8123/?database=quench&$2"' sh "$1" "${2:-}"
}

start=$(date +%s)
for ((offset = 0; offset < rows; offset += chunk)); do
  n=$((rows - offset < chunk ? rows - offset : chunk))
  q "INSERT INTO otel_logs (Timestamp, EventName, ServiceName, Body, LogAttributes, ResourceAttributes)
     SELECT
       toDateTime64('2025-11-06 00:00:00', 9) + toIntervalNanosecond(number * $spacing) AS Timestamp,
       arrayElement(['claude_code.api_request','claude_code.tool_result','claude_code.tool_decision','codex.api_request','codex.tool_result','codex.websocket_event','claude_code.user_prompt','codex.user_prompt'], 1 + number % 8) AS EventName,
       if(number % 8 IN (3, 4, 5, 7), 'codex_cli_rs', 'claude-code') AS ServiceName,
       EventName AS Body,
       map('event.name', EventName,
           'session.id', concat('s-', toString(cityHash64(intDiv(number, 2000)) % 2000000)),
           'model', if(number % 3 = 0, 'claude-opus-5-5', 'gpt-6.1-sol'),
           'duration_ms', toString(number % 9000),
           'cost_usd', toString(round((number % 1000) / 10000, 4)),
           'tool_name', arrayElement(['Bash','Read','Edit','shell','apply_patch'], 1 + number % 5),
           'success', if(number % 17 = 0, 'false', 'true'),
           'input_tokens', toString(number % 200000),
           'output_tokens', toString(number % 4000)) AS LogAttributes,
       map('service.name', ServiceName,
           'quench.machine', arrayElement(['goliath','sb1','sb2','trash-pro','cheap-mini','free-mini'], 1 + intDiv(number, 7) % 6),
           'host.arch', 'amd64', 'os.type', 'linux', 'service.version', '2.1.0') AS ResourceAttributes
     FROM numbers($offset, $n)" "max_insert_threads=1&max_threads=1&max_block_size=65536&min_insert_block_size_rows=262144&min_insert_block_size_bytes=134217728"
  echo "inserted $((offset + n)) rows after $(( $(date +%s) - start ))s"
done

echo "--- size"
q "SELECT sum(rows) AS rows, formatReadableSize(sum(data_compressed_bytes)) AS on_disk, formatReadableSize(sum(data_uncompressed_bytes)) AS raw, round(sum(data_uncompressed_bytes) / sum(data_compressed_bytes), 1) AS ratio, uniqExact(partition) AS partitions FROM system.parts WHERE active AND database = 'quench' AND table = 'otel_logs' FORMAT Vertical"

echo "--- year-long GROUP BY machine, event, day"
q "SELECT count() AS groups, sum(c) AS events FROM (SELECT Machine, EventName, toStartOfDay(TimestampTime) AS day, count() AS c FROM otel_logs WHERE TimestampTime >= '2025-11-06' AND TimestampTime < '2026-11-07' GROUP BY Machine, EventName, day) FORMAT Vertical" "log_comment=scale-day"

echo "--- year-long GROUP BY session, cost and p95 latency"
q "SELECT count() AS sessions, round(sum(cost), 2) AS cost, round(avg(p95)) AS avg_p95_ms FROM (SELECT SessionId, sum(toFloat64OrZero(LogAttributes['cost_usd'])) AS cost, quantile(0.95)(toFloat64OrZero(LogAttributes['duration_ms'])) AS p95 FROM otel_logs GROUP BY SessionId) FORMAT Vertical" "log_comment=scale-session"

q "SYSTEM FLUSH LOGS"
echo "--- per-query peak memory"
q "SELECT log_comment, query_duration_ms, formatReadableSize(memory_usage) AS peak, formatReadableQuantity(read_rows) AS read FROM system.query_log WHERE type = 'QueryFinish' AND log_comment LIKE 'scale-%' ORDER BY event_time FORMAT PrettyCompactMonoBlock"
echo "--- container"
echo "limit $memory, peak $(docker exec "$name" cat /sys/fs/cgroup/memory.peak | numfmt --to=iec), OOM killed: $(docker inspect -f '{{.State.OOMKilled}}' "$name")"
test "$(docker inspect -f '{{.State.Running}}' "$name")" = true
