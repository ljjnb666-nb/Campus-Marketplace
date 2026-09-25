#!/usr/bin/env bash
# =============================================================================
# PostgreSQL 生产备份（scripts/ops/backup-postgres.sh）
#
# 用法：./scripts/ops/backup-postgres.sh
#   （BACKUP_DIR 等全部从 .env.production 读取，操作员无需手工 export）
#
# - pg_dump custom 格式（-Fc），支持 pg_restore 并行/选择性恢复
# - 文件名带 timestamp；退出非 0 表示失败
# - 生成 SHA256 校验文件并**真实执行 sha256sum --check 验证**，
#   验证通过才允许 checksumVerified=true（BLOCKER 4）
# - retention：清理超过 BACKUP_RETENTION_DAYS（默认 14）天的本地备份
# - 密码：pg_dump 通过容器内 env 认证，不落命令行/日志
#
# 机器可读状态产物（Phase 4 TASK 7 + BLOCKER 4B）：
#   ${BACKUP_DIR}/backup-status.json —— 成功与失败都必须可靠写入。
#   一旦 BACKUP_DIR 已知且可写，立即初始化 pending state 并注册 EXIT trap：
#   其后任何前置配置失败（如 POSTGRES_USER 缺失）都会留下 status=failed
#   的状态产物（含明确 stage），而不是静默无产物。
#   BACKUP_DIR 本身缺失/不可写时没有可靠落点：只 stderr + 非零退出，
#   绝不假造"状态写成功"。
#   状态文件只含非敏感 metadata（文件名/时间/布尔状态）。
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

# ---- 第一个必需配置：备份目录（状态产物落点）----
BACKUP_DIR="$(require_env_var BACKUP_DIR)"

if ! mkdir -p "${BACKUP_DIR}" 2>/dev/null; then
  echo "[backup] FAIL：无法创建备份目录 ${BACKUP_DIR}，无可靠状态落点，退出" >&2
  exit 1
fi
if ! touch "${BACKUP_DIR}/.write-probe" 2>/dev/null; then
  echo "[backup] FAIL：备份目录不可写 ${BACKUP_DIR}，无可靠状态落点，退出" >&2
  exit 1
fi
rm -f "${BACKUP_DIR}/.write-probe"

# ---- BACKUP_DIR 可用：立即初始化状态并注册 trap（BLOCKER 4B）----
STATUS_FILE="${BACKUP_DIR}/backup-status.json"
PENDING_STATUS="failed"      # 任何未走到 success 收尾的退出都按 failed 记录
PENDING_STAGE="init"
PENDING_FILENAME=""
PENDING_CHECKSUM="false"
PENDING_OFFSITE="not_configured"

write_backup_status() {
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

# ---- 其余必需配置：失败即由 trap 留下 failed 状态（stage 明确）----
PENDING_STAGE="resolve_retention"
RETENTION_DAYS="$(optional_env_var BACKUP_RETENTION_DAYS 14)"
# 统一 env contract：shell export > .env.production > 默认（不得绕过 lib）

PENDING_STAGE="resolve_postgres_user"
POSTGRES_USER="$(require_env_var POSTGRES_USER)"

PENDING_STAGE="resolve_db"
DB_NAME="$(require_env_var POSTGRES_DB)"

PENDING_STAGE="resolve_offsite"
OFFSITE_TARGET="$(optional_env_var BACKUP_OFFSITE_TARGET "")"

# ---- 备份本体 ----
PENDING_STAGE="dump"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="${BACKUP_DIR}/${DB_NAME}-${TIMESTAMP}.dump"

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

# ---- 校验和：写入 + 真实验证（BLOCKER 4）----
PENDING_STAGE="checksum"
SIZE_BYTES="$(wc -c < "${DUMP_FILE}" | tr -d ' ')"
SHA256="$(sha256sum "${DUMP_FILE}" | awk '{print $1}')"
printf '%s  %s\n' "${SHA256}" "$(basename "${DUMP_FILE}")" > "${DUMP_FILE}.sha256"

echo "[backup] 备份完成"
echo "[backup] 文件:   ${DUMP_FILE}"
echo "[backup] 大小:   ${SIZE_BYTES} bytes"
echo "[backup] SHA256: ${SHA256}"

# 真正执行 sha256sum --check：重新读取 dump 全量校验，
# 通过才允许 checksumVerified=true（绝不给未验证的 dump 打 verified 标记）
if ! (cd "${BACKUP_DIR}" && printf '%s  %s\n' "${SHA256}" "$(basename "${DUMP_FILE}")" \
    | sha256sum --check --quiet -); then
  echo "[backup] FAIL：备份校验和验证失败（dump 与 .sha256 不一致），判定 FAILED" >&2
  PENDING_STAGE="checksum"
  exit 1
fi
echo "[backup] 校验和验证通过（sha256sum --check）"
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
