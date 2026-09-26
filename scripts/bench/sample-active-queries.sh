#!/usr/bin/env bash
# FINAL REPAIR A — DB 查询采样器（benchmark-only，不入生产路径）。
# 以固定频率采样 campus_perf 中 active 查询的文本（截断至 90 字符），
# 用于归因单路由 p50 差异的主导查询。
# 用法：bash scripts/bench/sample-active-queries.sh <样本数> <输出文件>
COUNT="${1:-120}"
OUT="${2:-/dev/stdout}"
: > "$OUT"
for i in $(seq 1 "$COUNT"); do
  docker exec campus-marketplace-postgres psql -U postgres -d campus_perf -t -A \
    -c "SELECT left(regexp_replace(query,'[[:space:]]+',' ','g'),90) FROM pg_stat_activity WHERE datname='campus_perf' AND state='active' AND query NOT LIKE '%pg_stat_activity%'" 2>/dev/null >> "$OUT"
done
