#!/usr/bin/env bash
# =============================================================================
# 生产部署（scripts/ops/deploy.sh）
#
# 流程：preflight（env 校验）
#   → 构建 immutable 镜像（tag = GIT_SHA）
#   → migrate deploy（一次性容器，禁止 app 启动时并发迁移）
#   → 迁移验证（无 pending migration）
#   → app 滚动更新
#   → health / release SHA 验证
#   → 记录 release 日志
#
# 用法：./scripts/ops/deploy.sh [git_sha]   # 缺省为当前 HEAD
# 所有 env（SITE_ADDRESS/POSTGRES_* 等）从 .env.production 读取，无需手工 export。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_production_env

GIT_SHA="${1:-$(git -C "${PROJECT_DIR}" rev-parse HEAD)}"
GIT_SHA="${GIT_SHA:0:40}"
APP_URL="${APP_URL:-$(app_url_from_env)}"
HEALTH_TIMEOUT=120

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

# 6) health + release 验证
echo "[deploy] step 6/6 验证 ${APP_URL}/api/health"
body=""
deadline=$((SECONDS + HEALTH_TIMEOUT))
while (( SECONDS < deadline )); do
  body="$(curl -fsS "${APP_URL}/api/health" 2>/dev/null || true)"
  if echo "${body}" | grep -q '"status":"ok"'; then
    release="$(echo "${body}" | sed -n 's/.*"release":"\([^"]*\)".*/\1/p')"
    if [[ "${release}" == "${GIT_SHA}" ]]; then
      echo "[deploy] release 一致: ${release}"
    else
      echo "[deploy][FAIL] release 不一致: health=${release} deploy=${GIT_SHA}" >&2
      exit 1
    fi
    break
  fi
  sleep 3
done
if ! echo "${body:-}" | grep -q '"status":"ok"'; then
  echo "[deploy] 健康检查超时，回滚见 scripts/ops/rollback.sh" >&2
  exit 1
fi

# release 日志
LOG_FILE="${PROJECT_DIR}/.releases.log"
echo "$(date -Is) RELEASE_SHA=${GIT_SHA} IMAGE=campus-marketplace-app:${GIT_SHA} DEPLOYED_AT=$(date -Is) MIGRATION=deployed" >> "${LOG_FILE}"
echo "[deploy] SUCCESS ${GIT_SHA}（记录于 ${LOG_FILE}）"
