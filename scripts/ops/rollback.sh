#!/usr/bin/env bash
# =============================================================================
# 生产回滚（scripts/ops/rollback.sh）
#
# 前提（向前兼容 migration 策略，见 docs/ROLLBACK.md）：
#   - 旧 release 镜像不可变保留（tag = SHA），可直接指回
#   - 数据库 migration 只允许向前；回滚 = 应用回旧镜像 + 保持当前 schema
#     （要求部署的 migration 与旧 release 向前兼容，deploy.sh 的备份兜底）
#   - 绝不自动执行 destructive down migration
#
# 用法：./scripts/ops/rollback.sh <previous_git_sha> [--hard]
#   默认（安全路径）：应用切回旧镜像，保留当前数据库 schema
#   --hard：仅当旧 release 与当前 schema 不兼容时人工评估后使用——
#           先恢复最近备份（restore-postgres.sh 流程），再切应用
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE="docker compose -f ${PROJECT_DIR}/compose.production.yml"

PREVIOUS_SHA="${1:?用法: rollback.sh <previous_git_sha> [--hard]}"
PREVIOUS_SHA="${PREVIOUS_SHA:0:40}"
MODE="${2:-}"

echo "[rollback] 回滚目标: ${PREVIOUS_SHA}（mode=${MODE:-safe}）"

# 旧镜像必须存在（不可变 tag 保留）
if ! docker image inspect "campus-marketplace-app:${PREVIOUS_SHA}" >/dev/null 2>&1; then
  echo "[rollback] 旧镜像 campus-marketplace-app:${PREVIOUS_SHA} 不存在" >&2
  echo "[rollback] 可用镜像: docker images 'campus-marketplace-app'" >&2
  exit 1
fi

if [[ "${MODE}" == "--hard" ]]; then
  echo "[rollback] --hard：先恢复最近备份到当前库（人工确认 schema 不兼容时才允许）" >&2
  latest_dump="$(ls -1t "${BACKUP_DIR:-/var/backups/campus-marketplace}"/*.dump 2>/dev/null | head -1 || true)"
  [[ -n "${latest_dump}" ]] || { echo "[rollback] 无可用备份，中止" >&2; exit 1; }
  echo "[rollback] 将恢复 ${latest_dump} → 当前生产库（30 秒内 Ctrl+C 取消）"
  sleep 30
  "${SCRIPT_DIR}/restore-postgres.sh" "${latest_dump}" "${POSTGRES_DB:?}" && true
fi

echo "[rollback] 应用切回 ${PREVIOUS_SHA}"
GIT_SHA="${PREVIOUS_SHA}" ${COMPOSE} up -d --no-deps --wait app

echo "[rollback] 验证健康与 release"
body="$(curl -fsS "${APP_URL:?}/api/health")"
echo "${body}"
echo "${body}" | grep -q "\"status\":\"ok\"" || { echo "[rollback] 健康检查失败" >&2; exit 1; }

release="$(echo "${body}" | sed -n 's/.*"release":"\([^"]*\)".*/\1/p')"
if [[ "${release}" != "${PREVIOUS_SHA}" ]]; then
  echo "[rollback] release 不一致: health=${release} 期望=${PREVIOUS_SHA}" >&2
  exit 1
fi

echo "$(date -Is) ROLLBACK RELEASE_SHA=${PREVIOUS_SHA} MODE=${MODE:-safe}" >> "${PROJECT_DIR}/.releases.log"
echo "[rollback] SUCCESS → ${PREVIOUS_SHA}"
