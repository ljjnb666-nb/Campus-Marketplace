#!/usr/bin/env bash
# FINAL REPAIR B — LR-070 真实恢复证据（B3/B8 RECOVERY）：
#
# 使用隔离 Redis 容器（:6390，独立于共享 :6379）证明：
#   1. HEALTHY：隔离 Redis 正常时计数真实进入 Redis
#   2. OUTAGE：stop 容器 → 首次失败有界 + 冷却后立即回退
#   3. RECOVERY：start 同一容器 → 同一 client（进程不重启）在 ioredis
#      自动重连 ready 后，下一个请求立即恢复真实 Redis 计数
#
# 运行：bash scripts/resilience/redis-recovery-proof.sh
set -euo pipefail

PORT=6390
CONTAINER=lr070-recovery-redis
PASSWORD=lr070proof
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "$PORT:6379" redis:7-alpine \
  redis-server --requirepass "$PASSWORD" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" redis-cli -a "$PASSWORD" ping 2>/dev/null | grep -q PONG; then
    break
  fi
  sleep 1
done
echo "[recovery-proof] isolated redis ready on :$PORT"

# PHASE 1+2+3 由 tsx 脚本执行（同一进程内同一 client，跨 stop/start）
REDIS_URL="redis://:${PASSWORD}@localhost:${PORT}" \
npx tsx "$SCRIPT_DIR/redis-recovery-proof.ts"
