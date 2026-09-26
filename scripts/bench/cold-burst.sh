#!/usr/bin/env bash
# FINAL REPAIR A 审计修复 — cold-start burst 驱动（benchmark-only）。
# 对每个并发档：重启 production server（进程内公开缓存为空）→ 无预热
# 发起固定请求数 burst → 记录 JSON。结果写 bench-results/cold-burst.json。
set -u
cd "$(dirname "$0")/../.."

ROUTES_PATH="${1:-/}"
OUT="${2:-bench-results/cold-burst.json}"

start_server() {
  set -a; source .env.bench; set +a
  npx next start -p 3000 >> bench-server-cold.log 2>&1 &
  for i in $(seq 1 50); do
    sleep 0.5
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://localhost:3000/api/health" 2>/dev/null || true)
    if [ "$code" = "200" ]; then break; fi
  done
  sleep 1
}

stop_server() {
  pid=$(powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess" 2>/dev/null | tr -d '\r' | tail -1)
  [ -n "$pid" ] && powershell.exe -NoProfile -Command "Stop-Process -Id $pid -Force" 2>/dev/null
  sleep 2
}

: > "$OUT"
for spec in "1 30" "25 25" "50 50" "100 100"; do
  set -- $spec
  c=$1; n=$2
  echo "[cold-burst] restart server for c=$c amount=$n"
  stop_server
  start_server
  BENCH_APP_URL="http://localhost:3000${ROUTES_PATH}" node scripts/bench/cold-burst.mjs "$c" "$n" >> "$OUT"
done
stop_server
echo "[cold-burst] written $OUT"
