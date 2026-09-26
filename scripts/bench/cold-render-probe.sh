#!/usr/bin/env bash
# 严格受控的单次 cold render 实验（每步验证）。
set -u
cd "$(dirname "$0")/../.."

stop_server() {
  pids=$(powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess" 2>/dev/null | tr -d '\r' | sort -u)
  for pid in $pids; do
    [ -n "$pid" ] && powershell.exe -NoProfile -Command "Stop-Process -Id $pid -Force" 2>/dev/null
  done
  sleep 2
  remain=$(powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count" 2>/dev/null | tr -d '\r' | tail -1)
  echo "[verify] listeners after stop: ${remain:-ERR}"
}

snap() {
  docker exec campus-marketplace-postgres psql -U postgres -d campus_perf -t -A \
    -c "SELECT relname||'='||(seq_scan+idx_scan) FROM pg_stat_user_tables WHERE relname IN ('Product','ErrandTask','ServiceListing','Campus') ORDER BY 1" | tr '\n' ' '
  echo
}

stop_server
( set -a; source .env.bench; set +a; npx next start -p 3000 > bench-server-cold.log 2>&1 & )
for i in $(seq 1 60); do
  sleep 0.5
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://localhost:3000/api/health" 2>/dev/null || true)
  [ "$code" = "200" ] && break
done
sleep 1
newpid=$(powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess" 2>/dev/null | tr -d '\r' | tail -1)
echo "[verify] server pid: $newpid"
grep -E "Ready|数据库连接" bench-server-cold.log | tail -2

echo "BEFORE: $(snap)"
( for i in $(seq 1 40); do
    docker exec campus-marketplace-postgres psql -U postgres -d campus_perf -t -A \
      -c "SELECT CASE WHEN state='active' THEN left(query,70) ELSE '' END FROM pg_stat_activity WHERE datname='campus_perf' AND query NOT LIKE '%pg_stat%';" 2>/dev/null
    sleep 0.1
  done > /tmp/render-activity.txt &
)
curl -s -o /dev/null -w "[render] %{http_code} %{time_total}s\n" "http://localhost:3000/"
sleep 4
echo "AFTER:  $(snap)"
echo "=== captured active queries during render ==="
grep -v "^$" /tmp/render-activity.txt | sort | uniq -c | sort -rn | head -10
