#!/usr/bin/env bash
# =============================================================================
# 生产 ops-check 执行合同 — canonical invocation 回归测试（R1 / P1-01）
#
# 验证文档指定的唯一 canonical 生产命令在真实 compose 拓扑中的端到端行为：
#
#   GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env.production \
#     -f compose.production.yml --profile ops run --rm --build ops-check
#
# 前提（满足时才执行，否则打印 SKIP 供人工在演练拓扑上运行）：
#   - docker 可用
#   - campus-marketplace-production 拓扑在运行（app healthy）
#   - .env.production 存在且 BACKUP_DIR 指向的宿主机目录存在
#   - BACKUP_OFFSITE_TARGET 已配置且最近备份 offsite=success（production
#     backup_ready 合同要求异地副本；未配置时 Phase 3B 语义下 overall FAIL
#     属正确行为，不纳入本测试）
#
# 断言：
#   1. canonical 命令 exit 0，六项检查全 pass，汇总 result=PASS
#   2. release_identity pass（RELEASE_SHA 来自镜像 bake，等于 HEAD）
#   3. 输出不含任何秘密值（连接串/密码/token）
#
# 由 tests/ops/ops-scripts.test.ts（vitest，bash+docker 可用时）调用并
# 断言 FAIL=0；也可在演练主机上手动执行：bash tests/ops/ops-check-canonical.test.sh
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
RUNNING="$(docker compose --env-file "${ENV_FILE}" -f "${REPO_ROOT}/compose.production.yml" ps --status running --services 2>/dev/null | grep -c app || true)"
if [[ "${RUNNING}" -lt 1 ]]; then
  echo "SKIP=1 FAIL=0 PASS=0（生产拓扑未运行）"
  exit 0
fi

# ---- canonical 命令（与 docs/tests/ops/ops-check-topology.test.ts 保持同一字符串）----
HEAD_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
GIT_SHA="${HEAD_SHA}" docker compose --env-file .env.production -f compose.production.yml --profile ops run --rm --build ops-check > "${OUT}" 2>&1
RC=$?

if [[ "${RC}" -eq 0 ]]; then pass_test; else fail_test "canonical 命令退出码非 0: ${RC}"; fi
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

echo "PASS=${PASS} FAIL=${FAIL}"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
