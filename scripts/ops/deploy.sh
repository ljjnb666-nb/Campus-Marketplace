#!/usr/bin/env bash
# =============================================================================
# 生产部署（scripts/ops/deploy.sh）
#
# 流程：preflight（env 校验）
#   → 构建 immutable 镜像（tag = GIT_SHA）
#   → migrate deploy（一次性容器，禁止 app 启动时并发迁移）
#   → 迁移验证（无 pending migration）
#   → app 滚动更新
#   → RELEASE READINESS GATE（scripts/ops/release-readiness-check.ts，
#     deploy 与 rollback 共用的唯一权威 verifier：health + ready + release 身份
#     + 严格 ready + 全依赖 ok，fail closed）
#   → 记录 release 日志（仅 verifier PASS 后）
#
# 用法：./scripts/ops/deploy.sh [git_sha]   # 缺省为当前 HEAD
# 所有 env（SITE_ADDRESS/POSTGRES_* 等）从 .env.production 读取，无需手工 export。
# OPS_RELEASE_VERIFIER 仅供自动化测试注入 stub（生产路径不受影响）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_production_env

GIT_SHA="${1:-$(git -C "${PROJECT_DIR}" rev-parse HEAD)}"
GIT_SHA="${GIT_SHA:0:40}"
APP_URL="${APP_URL:-$(app_url_from_env)}"
# OPS_HEALTH_TIMEOUT 仅供自动化测试压短门禁轮询预算（生产路径默认 120s）
HEALTH_TIMEOUT="${OPS_HEALTH_TIMEOUT:-120}"

# OPS_RELEASE_VERIFIER 仅供自动化测试注入 stub verifier（参数：expected_sha）。
# 生产路径必须走 scripts/ops/release-readiness-check.ts（deploy 与 rollback
# 共用的唯一 release gate 权威，禁止在本脚本内另写 grep/sed JSON 解析）。
run_release_gate() {
  local expected_sha="$1"
  if [[ -n "${OPS_RELEASE_VERIFIER:-}" ]]; then
    bash "${OPS_RELEASE_VERIFIER}" "${expected_sha}"
    return
  fi
  npx --prefix "${PROJECT_DIR}" tsx "${SCRIPT_DIR}/release-readiness-check.ts" \
    --base-url "${APP_URL}" \
    --expected-sha "${expected_sha}" \
    --timeout-seconds "${HEALTH_TIMEOUT}"
}

echo "[deploy] RELEASE_SHA=${GIT_SHA}"

# 1) preflight
echo "[deploy] step 1/6 生产 env 校验"
npx --prefix "${PROJECT_DIR}" tsx scripts/production-env-check.ts --file "${ENV_FILE}"

# 2) 构建不可变镜像（GIT_SHA 进 build args，/api/health 可回报）
echo "[deploy] step 2/6 构建镜像（tag=${GIT_SHA}）"
GIT_SHA="${GIT_SHA}" compose_run build app migrate

# 3) 迁移（先备份，后迁移）
echo "[deploy] step 3/6 备份当前数据库"
"${SCRIPT_DIR}/backup-postgres.sh"

echo "[deploy] step 4/6 migrate deploy"
compose_run --profile ops run --rm migrate

# 迁移验证：再次执行必须显示 no pending migration
MIGRATE_OUT="$(compose_run --profile ops run --rm migrate 2>&1 || true)"
if ! echo "${MIGRATE_OUT}" | grep -qiE "No pending migrations|already in sync"; then
  echo "[deploy] 迁移重复执行未显示 no pending migration，请人工检查：" >&2
  echo "${MIGRATE_OUT}" >&2
  exit 1
fi
echo "[deploy] 迁移验证通过（no pending migration）"

# 5) app 滚动更新
echo "[deploy] step 5/6 滚动更新 app"
if ! GIT_SHA="${GIT_SHA}" compose_run up -d --no-deps --wait app; then
  echo "[deploy] app 启动失败，回滚见 scripts/ops/rollback.sh" >&2
  exit 1
fi

# 6) RELEASE READINESS GATE（RB-06）：/api/health 200 不再等于 DEPLOY SUCCESS。
#    必须 health(ok + exact SHA) 且 ready(ready + exact SHA + DB/Redis/双 bucket 全 ok)。
echo "[deploy] step 6/6 release readiness gate（${APP_URL}）"
if ! run_release_gate "${GIT_SHA}"; then
  echo "[deploy][FAIL] deployment verification failed —— 不写 release log；" >&2
  echo "[deploy][FAIL] 处理后重试，或将应用切回上一 release：scripts/ops/rollback.sh <previous_git_sha>" >&2
  exit 1
fi

# release 日志（仅 verifier PASS 后才写；不记录 dependency URLs/credentials/bucket names）
LOG_FILE="${PROJECT_DIR}/.releases.log"
echo "$(date -Is) RELEASE_SHA=${GIT_SHA} IMAGE=campus-marketplace-app:${GIT_SHA} DEPLOYED_AT=$(date -Is) MIGRATION=deployed READINESS=ready" >> "${LOG_FILE}"
echo "[deploy] SUCCESS ${GIT_SHA}（记录于 ${LOG_FILE}）"
