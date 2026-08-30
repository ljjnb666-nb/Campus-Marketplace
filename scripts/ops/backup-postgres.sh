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
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
POSTGRES_USER="$(require_env_var POSTGRES_USER)"
DB_NAME="$(require_env_var POSTGRES_DB)"
OFFSITE_TARGET="$(parse_env_file "$ENV_FILE" | sed -n 's/^BACKUP_OFFSITE_TARGET=//p' | tail -1)"

mkdir -p "${BACKUP_DIR}"

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
  echo "[backup] 备份文件为空，判定失败" >&2
  rm -f "${DUMP_FILE}"
  exit 1
fi

SIZE_BYTES="$(wc -c < "${DUMP_FILE}" | tr -d ' ')"
SHA256="$(sha256sum "${DUMP_FILE}" | awk '{print $1}')"
echo "${SHA256}  $(basename "${DUMP_FILE}")" > "${DUMP_FILE}.sha256"

echo "[backup] 备份完成"
echo "[backup] 文件:   ${DUMP_FILE}"
echo "[backup] 大小:   ${SIZE_BYTES} bytes"
echo "[backup] SHA256: ${SHA256}"

# ---- 异地备份 ----
if [[ -z "${OFFSITE_TARGET}" ]]; then
  echo "[backup] OFFSITE_NOT_CONFIGURED：未配置 BACKUP_OFFSITE_TARGET，备份仅存在于本机（独立目录），无异地副本"
else
  if ! command -v aws >/dev/null 2>&1; then
    echo "[backup] FAIL：已配置 BACKUP_OFFSITE_TARGET=${OFFSITE_TARGET} 但未安装 aws CLI，异地备份无法完成" >&2
    echo "[backup] 本次备份判定 FAILED（不得在缺少异地副本的情况下宣称备份成功）" >&2
    exit 1
  fi
  echo "[backup] 复制到异地：${OFFSITE_TARGET}"
  if ! aws s3 cp "${DUMP_FILE}" "${OFFSITE_TARGET}/$(basename "${DUMP_FILE}")"; then
    echo "[backup] FAIL：dump 上传异地失败" >&2
    exit 1
  fi
  if ! aws s3 cp "${DUMP_FILE}.sha256" "${OFFSITE_TARGET}/$(basename "${DUMP_FILE}").sha256"; then
    echo "[backup] FAIL：checksum 上传异地失败" >&2
    exit 1
  fi
  echo "[backup] 异地副本完成：${OFFSITE_TARGET}/$(basename "${DUMP_FILE}")"
fi

# ---- 本地 retention ----
echo "[backup] 清理 ${RETENTION_DAYS} 天前的本地备份"
find "${BACKUP_DIR}" -name "*.dump" -mtime "+${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -name "*.dump.sha256" -mtime "+${RETENTION_DAYS}" -delete

echo "[backup] DONE ${TIMESTAMP}"
