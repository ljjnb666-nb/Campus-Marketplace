#!/usr/bin/env bash
# =============================================================================
# 生产 ops-check 执行合同 — canonical invocation 回归测试（R1 / P1-01）
#
# 验证文档指定的唯一 canonical 生产命令在真实 compose 拓扑中的端到端行为，
# 以及诊断非变异合同（R1 评审修复 CANONICAL_OPS_CHECK_MUTATES_OBSERVED_DEPENDENCIES）：
#
#   GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env.production \
#     -f compose.production.yml --profile ops run --rm --no-deps --build ops-check
#
# 本脚本运行的就是上面这条命令（与 docs/OPS_CHECK gate 同一字符串，
# 不额外追加任何参数）：
#   OPS-DIAG-03 healthy topology → 6 checks PASS，overall PASS
#     （证明 --no-deps 没有破坏正常检查）
#   OPS-DIAG-01 redis stopped → 前置记录 stopped → canonical →
#     redis_connectivity FAIL + overall FAIL → redis 必须 STILL STOPPED
#     （关键断言：诊断命令不得把被观察依赖拉起来）→ 恢复 redis
#   OPS-DIAG-02 postgres stopped → 同上，database_connectivity FAIL →
#     STILL STOPPED → 恢复 postgres
#
# 前提（满足时才执行，否则打印 SKIP 供人工在演练拓扑上运行）：
#   - docker 可用
#   - campus-marketplace-production 拓扑在运行（app healthy）
#   - .env.production 存在且 BACKUP_DIR 指向的宿主机目录存在
#   - BACKUP_OFFSITE_TARGET 已配置且最近备份 offsite=success（production
#     backup_ready 合同要求异地副本；未配置时 Phase 3B 语义下 overall FAIL
#     属正确行为，不纳入本测试）
#
# 退出码/输出契约：FAIL=0 才 exit 0（由 tests/ops/ops-scripts.test.ts 断言）。
# 非 skip 路径打印 SKIP=0。由 tests/ops/ops-scripts.test.ts（vitest，bash+docker
# 可用时）调用；也可在演练主机上手动执行：bash tests/ops/ops-check-canonical.test.sh
# =============================================================================
set -uo pipefail

PASS=0
FAIL=0

fail_test() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass_test() { PASS=$((PASS + 1)); }
assert_contains() {
  if printf '%s' "$2" | grep -qF "$1"; then pass_test; else fail_test "内容缺少: $1"; fi
}
assert_not_contains() {
  if printf '%s' "$2" | grep -qF "$1"; then fail_test "内容不应包含: $1"; else pass_test; fi
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.production"
COMPOSE_ARGS=(--env-file .env.production -f compose.production.yml --profile ops)
OUT="$(mktemp)"
trap 'rm -f "${OUT}"' EXIT

# ---- 前提探测（不满足 = SKIP：测试基础设施不足，不算失败）----
if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP=1 FAIL=0 PASS=0（docker 不可用）"
  exit 0
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "SKIP=1 FAIL=0 PASS=0（无 .env.production）"
  exit 0
fi
BACKUP_DIR_VALUE="$(grep -E '^BACKUP_DIR=' "${ENV_FILE}" | tail -1 | cut -d= -f2-)"
OFFSITE_VALUE="$(grep -E '^BACKUP_OFFSITE_TARGET=' "${ENV_FILE}" | tail -1 | cut -d= -f2-)"
if [[ -z "${BACKUP_DIR_VALUE}" || ! -d "${BACKUP_DIR_VALUE}" ]]; then
  echo "SKIP=1 FAIL=0 PASS=0（BACKUP_DIR 未配置或目录不存在）"
  exit 0
fi
if [[ -z "${OFFSITE_VALUE}" ]]; then
  echo "SKIP=1 FAIL=0 PASS=0（BACKUP_OFFSITE_TARGET 未配置：production 合同下 overall FAIL 属 Phase 3B 设计语义，无法验证 overall PASS）"
  exit 0
fi
RUNNING="$(docker compose "${COMPOSE_ARGS[@]}" ps --status running --services 2>/dev/null | grep -c app || true)"
if [[ "${RUNNING}" -lt 1 ]]; then
  echo "SKIP=1 FAIL=0 PASS=0（生产拓扑未运行）"
  exit 0
fi

HEAD_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"

# 唯一 canonical 命令（与 docs/OBSERVABILITY.md §7、
# tests/ops/ops-check-topology.test.ts 的 CANONICAL_OPS_CHECK_COMMAND
# 保持字节语义一致；本测试绝不额外追加/删除任何参数）
run_canonical() {
  GIT_SHA="${HEAD_SHA}" docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps --build ops-check > "${OUT}" 2>&1
  return $?
}

svc_running() {
  docker compose "${COMPOSE_ARGS[@]}" ps --status running --services 2>/dev/null | grep -qx "$1"
}

wait_healthy() { # $1 = 容器名
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if [[ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo none)" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# =============================================================================
# OPS-DIAG-03：healthy topology → 6 checks 全 PASS（--no-deps 不破坏正常检查）
# =============================================================================
run_canonical
RC=$?
if [[ "${RC}" -eq 0 ]]; then pass_test; else fail_test "DIAG-03 canonical 命令退出码非 0: ${RC}"; fi
assert_contains '"name":"environment_contract","status":"pass"' "$(cat "${OUT}")"
assert_contains '"name":"release_identity","status":"pass"' "$(cat "${OUT}")"
assert_contains '"name":"database_connectivity","status":"pass"' "$(cat "${OUT}")"
assert_contains '"name":"redis_connectivity","status":"pass"' "$(cat "${OUT}")"
assert_contains '"name":"storage_connectivity","status":"pass"' "$(cat "${OUT}")"
assert_contains '"name":"backup_health","status":"pass"' "$(cat "${OUT}")"
assert_contains '"result":"PASS","mode":"production","checks":6,"failed":[]' "$(cat "${OUT}")"

# release identity provenance：canonical 命令以 HEAD 构建，输出不得出现
# unknown/local 身份被当作 PASS（身份来自 bake，不允许运行时伪装）
assert_not_contains 'release=unknown' "$(cat "${OUT}")"

# =============================================================================
# OPS-DIAG-01：redis stopped → FAIL → STILL STOPPED（非变异关键断言）
# =============================================================================
docker compose "${COMPOSE_ARGS[@]}" stop redis > /dev/null 2>&1
REDIS_STARTED_BY_DIAG=0
if svc_running redis; then
  fail_test "DIAG-01 前置失败：redis 未能停止"
else
  pass_test # REDIS_STOPPED_BEFORE = YES
fi

run_canonical
RC=$?
if [[ "${RC}" -ne 0 ]]; then pass_test; else fail_test "DIAG-01：依赖停止时 canonical 却 exit 0"; fi
assert_contains '"name":"redis_connectivity","status":"fail"' "$(cat "${OUT}")"
assert_contains '"result":"FAIL","mode":"production"' "$(cat "${OUT}")"

if svc_running redis; then
  fail_test "DIAG-01 非变异断言失败：canonical 启动了 stopped redis（MUTATING DIAGNOSTIC）"
  docker compose "${COMPOSE_ARGS[@]}" stop redis > /dev/null 2>&1
else
  pass_test # REDIS_STOPPED_AFTER = YES
fi
docker compose "${COMPOSE_ARGS[@]}" start redis > /dev/null 2>&1 && REDIS_STARTED_BY_DIAG=1
if [[ "${REDIS_STARTED_BY_DIAG}" == "1" ]]; then
  wait_healthy "campus-marketplace-production-redis-1" || fail_test "DIAG-01 收尾：redis 未恢复 healthy"
fi

# =============================================================================
# OPS-DIAG-02：postgres stopped → FAIL → STILL STOPPED（非变异关键断言）
# =============================================================================
docker compose "${COMPOSE_ARGS[@]}" stop postgres > /dev/null 2>&1
PG_STARTED_BY_DIAG=0
if svc_running postgres; then
  fail_test "DIAG-02 前置失败：postgres 未能停止"
else
  pass_test # POSTGRES_STOPPED_BEFORE = YES
fi

run_canonical
RC=$?
if [[ "${RC}" -ne 0 ]]; then pass_test; else fail_test "DIAG-02：依赖停止时 canonical 却 exit 0"; fi
assert_contains '"name":"database_connectivity","status":"fail"' "$(cat "${OUT}")"
assert_contains '"result":"FAIL","mode":"production"' "$(cat "${OUT}")"

if svc_running postgres; then
  fail_test "DIAG-02 非变异断言失败：canonical 启动了 stopped postgres（MUTATING DIAGNOSTIC）"
  docker compose "${COMPOSE_ARGS[@]}" stop postgres > /dev/null 2>&1
else
  pass_test # POSTGRES_STOPPED_AFTER = YES
fi
docker compose "${COMPOSE_ARGS[@]}" start postgres > /dev/null 2>&1 && PG_STARTED_BY_DIAG=1
if [[ "${PG_STARTED_BY_DIAG}" == "1" ]]; then
  wait_healthy "campus-marketplace-production-postgres-1" || fail_test "DIAG-02 收尾：postgres 未恢复 healthy"
fi

# ---- 无秘密输出（与 .env.production 中的真实值比对，绝不回显）----
# 注意：--build 会透传 BuildKit 构建日志，其中含 Dockerfile 内公开的
# build-placeholder 占位值（非秘密，见 Dockerfile 注释）；秘密扫描作用于
# ops-check 自身的 JSON 结果行与全输出的真实 env 值。
SECRET_PATTERNS=()
while IFS= read -r line; do
  key="${line%%=*}"
  value="${line#*=}"
  case "${key}" in
    POSTGRES_PASSWORD|REDIS_PASSWORD|NEXTAUTH_SECRET|S3_SECRET_ACCESS_KEY|MINIO_ROOT_PASSWORD|METRICS_BEARER_TOKEN)
      [[ -n "${value}" ]] && SECRET_PATTERNS+=("${value}") ;;
  esac
done < "${ENV_FILE}"
if [[ ${#SECRET_PATTERNS[@]} -gt 0 ]]; then
  for secret in "${SECRET_PATTERNS[@]}"; do
    assert_not_contains "${secret}" "$(cat "${OUT}")"
  done
fi
# ops-check 结果行（{"name":...}）绝不包含连接串/凭据形态
JSON_LINES="$(grep -oE '^\{"name".*' "${OUT}" || true)"
assert_not_contains "postgresql://" "${JSON_LINES}"
assert_not_contains "redis://:" "${JSON_LINES}"
assert_not_contains "aws_secret_access_key" "${JSON_LINES}"

echo "SKIP=0 PASS=${PASS} FAIL=${FAIL}"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
