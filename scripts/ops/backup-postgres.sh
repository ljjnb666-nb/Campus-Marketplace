#!/usr/bin/env bash
# =============================================================================
# PostgreSQL 生产备份（scripts/ops/backup-postgres.sh）
#
# 用法：./scripts/ops/backup-postgres.sh
#   （BACKUP_DIR 等全部从 .env.production 读取，操作员无需手工 export）
#
# - pg_dump custom 格式（-Fc），支持 pg_restore 并行/选择性恢复
# - 文件名带 timestamp；退出非 0 表示失败
# - 同时生成 SHA256 校验文件
# - retention：清理超过 BACKUP_RETENTION_DAYS（默认 14）天的本地备份
# - 密码：pg_dump 通过容器内 env 认证，不落命令行/日志
#
# 机器可读状态产物（Phase 4 TASK 7）：
#   ${BACKUP_DIR}/backup-status.json —— 成功与失败都必须可靠写入，
#   供 backup-health-check / ops:check 判定 LAST_BACKUP_STATUS/
#   LAST_BACKUP_TIME/CHECKSUM_STATUS/OFFSITE_STATUS。
#   状态文件只含非敏感 metadata（文件名/时间/布尔状态）。
#   写状态文件本身失败绝不吞掉备份的真实退出码（best effort + trap 保底）。
#
# 异地备份语义（绝不产生虚假的异地备份安全感）：
#   - BACKUP_OFFSITE_TARGET 为空 → 本地备份成功即成功，显式报告 OFFSITE_NOT_CONFIGURED
#   - BACKUP_OFFSITE_TARGET 已配置 → aws CLI 缺失、dump 上传、checksum 上传
#     任一失败 → 整体非 0 退出（本次备份判定 FAILED，不得宣称备份成功）
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_production_env

BACKUP_DIR="$(require_env_var BACKUP_DIR)"
# 统一 env contract：shell export > .env.production > 默认 14（不得绕过 lib）
RETENTION_DAYS="$(optional_env_var BACKUP_RETENTION_DAYS 14)"
POSTGRES_USER="$(require_env_var POSTGRES_USER)"
DB_NAME="$(require_env_var POSTGRES_DB)"
OFFSITE_TARGET="$(optional_env_var BACKUP_OFFSITE_TARGET "")"

mkdir -p "${BACKUP_DIR}"

STATUS_FILE="${BACKUP_DIR}/backup-status.json"
PENDING_STATUS="failed"      # 任何未走到 success 收尾的退出都按 failed 记录
PENDING_STAGE="init"
PENDING_FILENAME=""
PENDING_CHECKSUM="false"
PENDING_OFFSITE="not_configured"

write_backup_status() {
  # 早期失败（env 契约未过）时 STATUS_FILE 可能未定义：跳过即可
  if [[ -z "${STATUS_FILE:-}" ]]; then
    return 0
  fi
  local completed_at
  completed_at="$(date -Is)"
  # best effort：状态文件写失败只报警，不改变备份流程本身的退出码
  if ! printf '{"status":"%s","completedAt":"%s","filename":%s,"checksumVerified":%s,"offsiteStatus":"%s","stage":"%s"}\n' \
    "${PENDING_STATUS}" "${completed_at}" \
    "$(printf '%s' "${PENDING_FILENAME}" | sed 's/"/\\"/g' | awk '{ if (length($0)>0) printf "\"%s\"", $0; else printf "null" }')" \
    "${PENDING_CHECKSUM}" "${PENDING_OFFSITE}" "${PENDING_STAGE}" \
    > "${STATUS_FILE}.tmp" 2>/dev/null; then
    echo "[backup] WARN：无法写入状态文件 ${STATUS_FILE}（不影响备份退出码）" >&2
    return 0
  fi
  if ! mv -f "${STATUS_FILE}.tmp" "${STATUS_FILE}" 2>/dev/null; then
    echo "[backup] WARN：无法提交状态文件 ${STATUS_FILE}（不影响备份退出码）" >&2
  fi
}

on_exit() {
  local rc=$?
  write_backup_status
  exit "${rc}"
}
trap on_exit EXIT

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="${BACKUP_DIR}/${DB_NAME}-${TIMESTAMP}.dump"
PENDING_STAGE="dump"

echo "[backup] 开始备份 ${DB_NAME} → ${DUMP_FILE}"
# 通过 postgres 容器内执行 pg_dump（凭据只在容器内 env，不落命令行/日志）
compose_run exec -T postgres pg_dump \
  -U "${POSTGRES_USER}" \
  -d "${DB_NAME}" \
  -Fc \
  > "${DUMP_FILE}"

if [[ ! -s "${DUMP_FILE}" ]]; then
  PENDING_STAGE="empty_dump"
  echo "[backup] 备份文件为空，判定失败" >&2
  rm -f "${DUMP_FILE}"
  exit 1
fi
PENDING_FILENAME="$(basename "${DUMP_FILE}")"

SIZE_BYTES="$(wc -c < "${DUMP_FILE}" | tr -d ' ')"
SHA256="$(sha256sum "${DUMP_FILE}" | awk '{print $1}')"
echo "${SHA256}  $(basename "${DUMP_FILE}")" > "${DUMP_FILE}.sha256"

echo "[backup] 备份完成"
echo "[backup] 文件:   ${DUMP_FILE}"
echo "[backup] 大小:   ${SIZE_BYTES} bytes"
echo "[backup] SHA256: ${SHA256}"
PENDING_CHECKSUM="true"

# ---- 异地备份 ----
PENDING_STAGE="offsite"
if [[ -z "${OFFSITE_TARGET}" ]]; then
  echo "[backup] OFFSITE_NOT_CONFIGURED：未配置 BACKUP_OFFSITE_TARGET，备份仅存在于本机（独立目录），无异地副本"
else
  if ! command -v aws >/dev/null 2>&1; then
    PENDING_OFFSITE="failed"
    echo "[backup] FAIL：已配置 BACKUP_OFFSITE_TARGET 但未安装 aws CLI，异地备份无法完成" >&2
    echo "[backup] 本次备份判定 FAILED（不得在缺少异地副本的情况下宣称备份成功）" >&2
    exit 1
  fi
  echo "[backup] 复制到异地：${OFFSITE_TARGET}"
  if ! aws s3 cp "${DUMP_FILE}" "${OFFSITE_TARGET}/$(basename "${DUMP_FILE}")"; then
    PENDING_OFFSITE="failed"
    echo "[backup] FAIL：dump 上传异地失败" >&2
    exit 1
  fi
  if ! aws s3 cp "${DUMP_FILE}.sha256" "${OFFSITE_TARGET}/$(basename "${DUMP_FILE}").sha256"; then
    PENDING_OFFSITE="failed"
    echo "[backup] FAIL：checksum 上传异地失败" >&2
    exit 1
  fi
  PENDING_OFFSITE="success"
  echo "[backup] 异地副本完成：${OFFSITE_TARGET}/$(basename "${DUMP_FILE}")"
fi

# ---- 本地 retention ----
PENDING_STAGE="retention"
echo "[backup] 清理 ${RETENTION_DAYS} 天前的本地备份"
find "${BACKUP_DIR}" -name "*.dump" -mtime "+${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -name "*.dump.sha256" -mtime "+${RETENTION_DAYS}" -delete

PENDING_STATUS="success"
PENDING_STAGE="complete"
echo "[backup] DONE ${TIMESTAMP}"
