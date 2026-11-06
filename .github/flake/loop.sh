#!/usr/bin/env bash
set -u
runs=$1; files=("${@:2}")
fails=0; slow=0
for i in $(seq "$runs"); do
  bun test --timeout 60000 "${files[@]}" > "$RUNNER_TEMP/it.txt" 2>&1 &
  pid=$!
  start=$SECONDS; sampled=0
  while kill -0 $pid 2>/dev/null; do
    if [ $sampled = 0 ] && [ $((SECONDS - start)) -ge 8 ]; then
      sampled=1
      echo "=== iteration $i STALLED >8s; ps + sample"
      ps -axo pid,ppid,stat,etime,%cpu,command | grep -E "bun|fake|claude" | grep -v grep
      for p in $(pgrep -f "bun test"); do sample "$p" 2 -mayDie 2>/dev/null | sed -n '1,400p' | grep -E "Thread_|^ +[0-9]+ .*(kevent|read|write|wait|psynch|open|fsync|ulock|Bun__|uv_|ThreadPool|posix_spawn|fork)" | head -80; done
    fi
    sleep 0.2
  done
  wait $pid; code=$?
  dur=$((SECONDS - start))
  [ $code = 0 ] || { fails=$((fails+1)); echo "=== iteration $i FAILED ($code)"; grep -E "\(fail\)|timed out|dangling|Expected|Received|error:" "$RUNNER_TEMP/it.txt" | head -20; }
  grep -E "\(pass\).*\[([5-9][0-9]{2}|[0-9]{4,})\.[0-9]+ms\]" "$RUNNER_TEMP/it.txt" | grep -v "descendant holding" | sed "s/^/  it$i slow: /" | head -5
  [ $dur -ge 8 ] && slow=$((slow+1))
done
echo "RESULT runs=$runs fails=$fails stalled=$slow"
