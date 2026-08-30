#!/usr/bin/env bash
# =============================================================================
# 生产回滚（scripts/ops/rollback.sh）
#
# 用法：
#   ./scripts/ops/rollback.sh <previous_git_sha>          # 安全路径（默认）
#   ./scripts/ops/rollback.sh <previous_git_sha> --hard   # schema 不兼容时
#
# 安全路径（默认）：只把应用切回旧镜像；数据库 schema 保持向前（向前兼容
# migration 约束见 docs/ROLLBACK.md），完全不触碰数据库。
#
# --hard：仅当旧 release 与当前 schema 不兼容、需回退数据时使用：
#   1. 先执行 restore-production-postgres.sh（强确认、停写、SHA256、
#      完整性检查；脚本任一步失败立即非 0 退出）
#   2. 恢复成功才允许把应用切回旧镜像
#   3. 最后 health / release 验证
# 恢复失败 → 立即非 0 退出，应用切换绝不执行（app 保持停止，人工介入）。
# 绝不自动执行 destructive down migration。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_production_env

# OPS_RESTORE_SCRIPT 仅供自动化测试注入 stub（生产路径不受影响）
RESTORE_SCRIPT="${OPS_RESTORE_SCRIPT:-${SCRIPT_DIR}/restore-production-postgres.sh}"

PREVIOUS_SHA="${1:?用法: rollback.sh <previous_git_sha> [--hard]}"
PREVIOUS_SHA="${PREVIOUS_SHA:0:40}"
MODE="${2:-}"

if [[ "${MODE}" != "" && "${MODE}" != "--hard" ]]; then
  echo "[rollback] 未知模式: ${MODE}（可选：留空 = safe，--hard = 含数据回退）" >&2
  exit 1
fi

echo "[rollback] 回滚目标: ${PREVIOUS_SHA}（mode=${MODE:-safe}）"

# 旧镜像必须存在（不可变 tag 保留）
if ! docker image inspect "campus-marketplace-app:${PREVIOUS_SHA}" >/dev/null 2>&1; then
  echo "[rollback] 旧镜像 campus-marketplace-app:${PREVIOUS_SHA} 不存在" >&2
  echo "[rollback] 可用镜像: docker images 'campus-marketplace-app'" >&2
  exit 1
fi

APP_URL="$(app_url_from_env)"

# -----------------------------------------------------------------------------
# 应用切换的唯一路径（safe 与 --hard 共用）：显式以目标 SHA 选择镜像。
#
# 不允许任何 fallback（:local / :unknown / 当前 HEAD / shell 残留的 GIT_SHA）：
# 1. 以 GIT_SHA=<target> 调 compose，让 image: campus-marketplace-app:${GIT_SHA:-local}
#    解析为准确 tag；
# 2. 在真正 up 之前用 compose config --images 读取插值后的最终镜像并 hard assert
#    必须等于 campus-marketplace-app:<target>，否则立即非 0 退出、不执行回滚。
# -----------------------------------------------------------------------------
switch_app_to() {
  local target_sha="$1" resolved_images=""

  if ! resolved_images="$(GIT_SHA="${target_sha}" compose_run config --images)"; then
    echo "[rollback][FAIL] compose config --images 解析失败，拒绝回滚" >&2
    exit 1
  fi

  if ! printf '%s\n' "${resolved_images}" | grep -Fxq "campus-marketplace-app:${target_sha}"; then
    echo "[rollback][FAIL] 解析后的 app 镜像不是 campus-marketplace-app:${target_sha}，拒绝回滚" >&2
    echo "---- resolved images ----" >&2
    printf '%s\n' "${resolved_images}" >&2
    echo "-------------------------" >&2
    exit 1
  fi
  echo "[rollback] resolved app image = campus-marketplace-app:${target_sha}"

  if ! GIT_SHA="${target_sha}" compose_run up -d --no-deps --wait app; then
    echo "[rollback] 应用启动失败（镜像 ${target_sha}）" >&2
    exit 1
  fi
}

if [[ "${MODE}" == "--hard" ]]; then
  echo "[rollback] --hard：先恢复最近备份到生产库（仅在旧 release 与当前 schema 不兼容时）" >&2
  BACKUP_DIR="$(require_env_var BACKUP_DIR)"
  latest_dump=""
  if ! latest_dump="$(ls -1t "${BACKUP_DIR}"/*.dump 2>/dev/null | head -1)"; then
    latest_dump=""
  fi
  if [[ -z "${latest_dump}" ]]; then
    echo "[rollback] BACKUP_DIR 中无可用备份，中止（绝不无备份覆盖生产库）" >&2
    exit 1
  fi
  echo "[rollback] 将恢复 ${latest_dump} → 生产库，并停止应用写流量"
  echo "[rollback] 30 秒内 Ctrl+C 取消"
  sleep 30

  # 关键路径：恢复失败必须阻断应用切换。restore-production-postgres.sh
  # 任一步失败都以非 0 退出，这里显式检查，绝不吞错。
  if ! bash "${RESTORE_SCRIPT}" \
      --production-restore \
      --backup-file "${latest_dump}" \
      --target-db "$(require_env_var POSTGRES_DB)"; then
    echo "[rollback] 生产库恢复失败——应用回滚已阻断（app 保持停止），人工介入" >&2
    exit 1
  fi
  echo "[rollback] 生产库恢复成功，继续切换应用镜像"
fi

# 应用切回旧镜像（safe 路径唯一步骤；hard 路径在恢复成功后才到达这里），
# safe 与 hard 共用 switch_app_to 的 exact-image selection
echo "[rollback] 应用切回 ${PREVIOUS_SHA}"
switch_app_to "${PREVIOUS_SHA}"

# health / release 验证
echo "[rollback] 验证 ${APP_URL}/api/health"
body="$(curl -fsS "${APP_URL}/api/health")"
echo "${body}"
echo "${body}" | grep -q '"status":"ok"' || {
  echo "[rollback] 健康检查失败" >&2
  exit 1
}

release="$(echo "${body}" | sed -n 's/.*"release":"\([^"]*\)".*/\1/p')"
if [[ "${release}" != "${PREVIOUS_SHA}" ]]; then
  echo "[rollback] release 不一致: health=${release} 期望=${PREVIOUS_SHA}" >&2
  exit 1
fi

echo "$(date -Is) ROLLBACK RELEASE_SHA=${PREVIOUS_SHA} MODE=${MODE:-safe}" >> "${PROJECT_DIR}/.releases.log"
echo "[rollback] SUCCESS → ${PREVIOUS_SHA}"
