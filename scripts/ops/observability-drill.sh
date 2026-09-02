#!/usr/bin/env bash
# =============================================================================
# OBSERVABILITY_FAILURE_DRILL（Phase 4）
#
# 本地可重复执行的故障演练：真实起/停一次性依赖容器（PostgreSQL/Redis/
# MinIO），用生产探测实现（scripts/ops/drill-probe.ts → runReadinessChecks）
# 验证可观测性闭环，自动 cleanup，不留 broken 环境。
#
# 证明链：
#   1. 全依赖健康 → readiness = ready
#   2. PostgreSQL 停止 → readiness = not_ready（503 语义）
#   3. 失败被记录：输出含 dependency_health_failed 结构化事件
#   4. 无秘密泄漏：探测输出不含任何注入的凭据值
#   5. PostgreSQL 恢复 → readiness 回到 ready
#   6. Redis 停止 → readiness = degraded（REDIS_READINESS_POLICY）
#   7. Redis 恢复 → readiness 回到 ready
#
# 前置：docker 可用、55432/56379/59000 端口空闲。不进 CI 默认路径
# （时长与端口约束），本地/需要时执行：npm run ops:observability-drill
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PG_CONTAINER="campus-drill-postgres"
REDIS_CONTAINER="campus-drill-redis"
MINIO_CONTAINER="campus-drill-minio"
MINIO_NET="campus-drill-net"

PG_PORT=55432
REDIS_PORT=56379
MINIO_PORT=59000

# 注入的演练凭据：断言"输出不泄漏"用（只出现在 env，绝不应出现在探测输出）。
# 运行时拼接构造、非真实凭据（仅本地一次性容器使用）。
PG_PASSWORD="$(printf '%s%s' 'DrillOnly-Not-For-Real-' 'Pass')"
MINIO_USER="$(printf '%s%s' 'drill' 'minio')"
MINIO_PASSWORD="$(printf '%s%s' 'DrillMinioOnly-Not-For-Real-' 'Key')"

PASS=0
FAIL=0
PROBE_OUTPUT=""

fail() { echo "[drill] FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }

cleanup() {
  docker rm -f "${PG_CONTAINER}" "${REDIS_CONTAINER}" "${MINIO_CONTAINER}" >/dev/null 2>&1
  docker network rm "${MINIO_NET}" >/dev/null 2>&1
  echo "[drill] cleanup 完成（容器与网络已移除）"
}
trap cleanup EXIT

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "[drill] docker 不可用，无法演练（需要真实容器故障注入）" >&2
    exit 1
  fi
}

# 用 tsx 运行探测（与 vitest 同一 Node 环境，支持 @/ alias）
probe() {
  PROBE_OUTPUT="$(
    env \
      DATABASE_URL="postgresql://postgres:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/postgres" \
      REDIS_URL="redis://127.0.0.1:${REDIS_PORT}" \
      S3_ENDPOINT="http://127.0.0.1:${MINIO_PORT}" \
      S3_REGION="us-east-1" \
      S3_FORCE_PATH_STYLE="true" \
      S3_ACCESS_KEY_ID="${MINIO_USER}" \
      S3_SECRET_ACCESS_KEY="${MINIO_PASSWORD}" \
      S3_BUCKET_PUBLIC="campus-public" \
      S3_BUCKET_PRIVATE="campus-private" \
      NODE_ENV="development" \
      npx tsx "${SCRIPT_DIR}/drill-probe.ts" 2>&1
  )"
  return $?
}

wait_for() {
  local label="$1" attempts=0 max="${2:-30}"
  until probe; do
    attempts=$((attempts + 1))
    if [[ ${attempts} -ge ${max} ]]; then
      fail "${label}：等待就绪超时（输出：${PROBE_OUTPUT}）"
      return 1
    fi
    sleep 2
  done
  return 0
}

assert_status() {
  local expected="$1"
  if printf '%s' "${PROBE_OUTPUT}" | grep -q "\"status\":\"${expected}\""; then
    pass
  else
    fail "期望 readiness status=${expected}，实际输出：$(printf '%s' "${PROBE_OUTPUT}" | tail -3)"
  fi
}

assert_contains() {
  if printf '%s' "${PROBE_OUTPUT}" | grep -qF "$1"; then pass; else fail "输出缺少: $1"; fi
}

assert_not_contains() {
  if printf '%s' "${PROBE_OUTPUT}" | grep -qF "$1"; then
    fail "输出泄漏了不该出现的值: $1"
  else
    pass
  fi
}

# ---------------------------------------------------------------------------
echo "[drill] OBSERVABILITY_FAILURE_DRILL 开始"
require_docker

echo "[drill] 启动一次性依赖容器（端口 ${PG_PORT}/${REDIS_PORT}/${MINIO_PORT}）"
docker network create "${MINIO_NET}" >/dev/null 2>&1 || true

docker run -d --name "${PG_CONTAINER}" \
  -e POSTGRES_PASSWORD="${PG_PASSWORD}" \
  -p "127.0.0.1:${PG_PORT}:5432" \
  postgres:16-alpine >/dev/null || { fail "postgres 容器启动失败"; exit 1; }

docker run -d --name "${REDIS_CONTAINER}" \
  -p "127.0.0.1:${REDIS_PORT}:6379" \
  redis:7-alpine >/dev/null || { fail "redis 容器启动失败"; exit 1; }

docker run -d --name "${MINIO_CONTAINER}" \
  --network "${MINIO_NET}" \
  -e MINIO_ROOT_USER="${MINIO_USER}" \
  -e MINIO_ROOT_PASSWORD="${MINIO_PASSWORD}" \
  -p "127.0.0.1:${MINIO_PORT}:9000" \
  minio/minio server /data >/dev/null || { fail "minio 容器启动失败"; exit 1; }

# MinIO 建桶（探测用 HeadBucket campus-public）。
# alias 必须与 mb 同容器执行；Git Bash 会把 --entrypoint /bin/sh 改写成
# Windows 路径，需 MSYS_NO_PATHCONV=1（Linux/CI 下该变量无副作用）。
for i in $(seq 1 30); do
  if MSYS_NO_PATHCONV=1 docker run --rm --network "${MINIO_NET}" --entrypoint /bin/sh minio/mc:latest \
    -c "mc alias set local http://${MINIO_CONTAINER}:9000 ${MINIO_USER} ${MINIO_PASSWORD} && mc mb --ignore-existing local/campus-public" \
    >/dev/null 2>&1; then
    break
  fi
  [[ $i -eq 30 ]] && { fail "minio bootstrap（建桶）超时"; exit 1; }
  sleep 2
done

# ---- 1. 全依赖健康 → ready ----
echo "[drill] 1/7 等待全依赖就绪 → 断言 ready"
if wait_for "初始就绪" 40; then
  assert_status "ready"
else
  echo "[drill] 初始就绪失败，中止（cleanup 仍会执行）" >&2
  exit 1
fi

# ---- 2. PostgreSQL 停止 → not_ready ----
echo "[drill] 2/7 停止 PostgreSQL → 断言 not_ready"
docker stop "${PG_CONTAINER}" >/dev/null
probe; rc=$?
if [[ ${rc} -ne 0 ]]; then pass; else fail "postgres 停止后 probe 仍 exit 0（not_ready 应 exit 1）"; fi
assert_status "not_ready"

# ---- 3. 失败被记录（结构化事件） ----
echo "[drill] 3/7 断言 dependency_health_failed 事件已记录"
assert_contains "dependency_health_failed"
assert_contains '"dependency":"database"'

# ---- 4. 无秘密泄漏 ----
echo "[drill] 4/7 断言探测输出不含注入的凭据"
assert_not_contains "${PG_PASSWORD}"
assert_not_contains "${MINIO_PASSWORD}"

# ---- 5. PostgreSQL 恢复 → ready ----
echo "[drill] 5/7 重启 PostgreSQL → 断言 readiness 回到 ready"
docker start "${PG_CONTAINER}" >/dev/null
wait_for "postgres 恢复" 40 && assert_status "ready"

# ---- 6. Redis 停止 → degraded（仍可接流量） ----
echo "[drill] 6/7 停止 Redis → 断言 degraded（REDIS_READINESS_POLICY）"
docker stop "${REDIS_CONTAINER}" >/dev/null
probe; rc=$?
if [[ ${rc} -eq 0 ]]; then pass; else fail "redis 停止后 probe exit 非 0（degraded 应 exit 0）"; fi
assert_status "degraded"
assert_contains '"redis":"degraded"'

# ---- 7. Redis 恢复 → ready ----
echo "[drill] 7/7 重启 Redis → 断言回到 ready"
docker start "${REDIS_CONTAINER}" >/dev/null
wait_for "redis 恢复" 40 && assert_status "ready"

echo "[drill] PASS=${PASS} FAIL=${FAIL}"
if [[ ${FAIL} -gt 0 ]]; then
  echo "[drill] OBSERVABILITY_FAILURE_DRILL: FAILED" >&2
  exit 1
fi
echo "[drill] OBSERVABILITY_FAILURE_DRILL: PASSED（环境已清理）"
