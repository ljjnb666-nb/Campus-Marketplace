#!/usr/bin/env bash
# FINAL REPAIR A — cold-start burst 驱动（benchmark-only）。
# 对每个并发档：重启 production server（进程内公开缓存为空）→ 无预热
# 发起固定请求数 burst → 汇总为单个合法 JSON 文档。
#
# fail-fast 契约：server 启动/health 失败、任一档 benchmark 失败、结果
# 非法（解析失败 / errors+timeouts≠0 / 并发档不齐）→ 退出非 0，
# 绝不写出 "written ..." 成功信息。
#
# 用法：bash scripts/bench/cold-burst.sh [route_path] [output_json]
#   默认：/ 与 bench-results/cold-burst.json
set -euo pipefail
cd "$(dirname "$0")/../.."

ROUTES_PATH="${1:-/}"
# Git Bash(MSYS) 会把以 / 开头的参数转换为 Windows 路径（"/"→"D:/Git/"）。
# 无法从损坏参数恢复原 route → fail-fast：route 必须以 / 开头（调用方
# 使用 MSYS_NO_PATHCONV=1，或省略参数使用默认 "/"）。
case "$ROUTES_PATH" in
  /*) : ;;
  *)
    echo "[cold-burst] FATAL: route \"$ROUTES_PATH\" 不以 / 开头（MSYS 路径转换破坏了参数）；请用 MSYS_NO_PATHCONV=1 调用或省略该参数（默认 /）" >&2
    exit 1
    ;;
esac
OUT="${2:-bench-results/cold-burst.json}"
TMP="$(mktemp)"
# route 经临时文件传给 node：MSYS 对"传给原生程序的、值形如 POSIX 路径的
# 环境变量"同样做路径转换（CB_ROUTE="/" 会被改写成 D:/Git/），文件内容
# 不经过该转换边界。
TMPROUTE="$(mktemp)"
printf '%s' "$ROUTES_PATH" > "$TMPROUTE"
trap 'rm -f "$TMP" "$TMPROUTE"' EXIT
EXPECTED_CONCURRENCIES=(1 25 50 100)

stop_server() {
  local pids pid remain
  # 无监听时 Get-NetTCPConnection 以非 0 退出（"no matching objects"）——
  # 空 output 即 0 listeners，须容错，否则 pipefail 会静默中断 stop。
  pids=$(powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess" 2>/dev/null | tr -d '\r' | sort -u || true)
  for pid in ${pids:-}; do
    powershell.exe -NoProfile -Command "Stop-Process -Id $pid -Force" 2>/dev/null || true
  done
  sleep 2
  remain=$(powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count" 2>/dev/null | tail -1 || true)
  remain=${remain:-0}
  echo "[cold-burst] listeners after stop: $remain"
  [ "$remain" = "0" ]
}

start_server() {
  set -a; source .env.bench; set +a
  npx next start -p 3000 >> bench-server-cold.log 2>&1 &
  local code=""
  for i in $(seq 1 60); do
    sleep 0.5
    # 用 /api/ready 而非 /api/health：ready 检查 DB 依赖（DB down → 503），
    # 使 health-failure 路径可被端到端触发并 fail-fast。
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://localhost:3000/api/ready" 2>/dev/null || true)
    if [ "$code" = "200" ]; then
      echo "[cold-burst] server healthy"
      return 0
    fi
  done
  echo "[cold-burst] FATAL: server health check never returned 200 (last=$code)" >&2
  return 1
}

stop_server

for spec in "1 30" "25 25" "50 50" "100 100"; do
  read -r c n <<< "$spec"
  echo "[cold-burst] route=[$ROUTES_PATH] restart server for c=$c amount=$n"
  stop_server
  start_server
  BENCH_APP_URL="http://localhost:3000${ROUTES_PATH}" node scripts/bench/cold-burst.mjs "$c" "$n" >> "$TMP"
done
stop_server

# 汇总为单个合法 JSON 文档并校验（fail-fast：任何异常 → 非 0 退出）
CB_TMP="$TMP" CB_TMPROUTE="$TMPROUTE" CB_OUT="$OUT" node --input-type=module -e '
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const { CB_TMP: tmp, CB_TMPROUTE: tmproute, CB_OUT: out } = process.env;
const route = readFileSync(tmproute, "utf8");
const expected = ["1", "25", "50", "100"];
const lines = readFileSync(tmp, "utf8").trim().split("\n").filter(Boolean);
if (lines.length !== expected.length) {
  console.error(`[cold-burst] FATAL: expected ${expected.length} runs, got ${lines.length}`);
  process.exit(1);
}
const runs = lines.map((line, i) => {
  let r;
  try { r = JSON.parse(line); } catch { console.error(`[cold-burst] FATAL: run ${i + 1} is not valid JSON`); process.exit(1); }
  if (String(r.concurrency) !== expected[i]) {
    console.error(`[cold-burst] FATAL: run ${i + 1} concurrency ${r.concurrency} != expected ${expected[i]}`);
    process.exit(1);
  }
  if (r.errors !== 0 || r.timeouts !== 0 || r.non2xx !== 0) {
    console.error(`[cold-burst] FATAL: run c=${r.concurrency} has errors=${r.errors} timeouts=${r.timeouts} non2xx=${r.non2xx}`);
    process.exit(1);
  }
  return r;
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ bench: "cold-burst", route, runs }, null, 2) + "\n");
console.log(`[cold-burst] written ${out} (${runs.length} runs, all clean)`);
'
