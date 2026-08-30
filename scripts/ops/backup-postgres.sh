#!/usr/bin/env bash
# =============================================================================
# PostgreSQL 生产备份（scripts/ops/backup-postgres.sh）
#
# 用法：BACKUP_DIR=/var/backups/campus-marketplace ./scripts/ops/backup-postgres.sh
#   （或从 .env.production 读取 BACKUP_DIR）
#
# - pg_dump custom 格式（-Fc），支持 pg_restore 并行/选择性恢复
# - 文件名带 timestamp；退出非 0 表示失败
# - 同时生成 SHA256 校验文件
# - retention：清理超过 BACKUP_RETENTION_DAYS（默认 14）天的本地备份
# - 可选异地：BACKUP_OFFSITE_TARGET=s3://bucket/prefix（需 AWS CLI 已配置）
# - 任何输出不含密码（pg_dump 通过容器内 env 读取）
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env.production"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:?请设置 BACKUP_DIR（独立磁盘/分区，勿与数据库同一盘）}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
COMPOSE="docker compose -f ${PROJECT_DIR}/compose.production.yml"

mkdir -p "${BACKUP_DIR}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DB_NAME="${POSTGRES_DB:?请在 .env.production 设置 POSTGRES_DB}"
DUMP_FILE="${BACKUP_DIR}/${DB_NAME}-${TIMESTAMP}.dump"

echo "[backup] 开始备份 ${DB_NAME} → ${DUMP_FILE}"
# 通过 postgres 容器内执行 pg_dump（凭据只在容器内 env，不落命令行/日志）
${COMPOSE} exec -T postgres pg_dump \
  -U "${POSTGRES_USER:?请在 .env.production 设置 POSTGRES_USER}" \
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

# ---- 异地备份（可选）----
if [[ -n "${BACKUP_OFFSITE_TARGET:-}" ]]; then
  if command -v aws >/dev/null 2>&1; then
    echo "[backup] 复制到异地：${BACKUP_OFFSITE_TARGET}"
    aws s3 cp "${DUMP_FILE}" "${BACKUP_OFFSITE_TARGET}/$(basename "${DUMP_FILE}")"
    aws s3 cp "${DUMP_FILE}.sha256" "${BACKUP_OFFSITE_TARGET}/$(basename "${DUMP_FILE}").sha256"
  else
    echo "[backup][WARN] 未安装 aws CLI，跳过异地备份" >&2
  fi
fi

# ---- 本地 retention ----
echo "[backup] 清理 ${RETENTION_DAYS} 天前的本地备份"
find "${BACKUP_DIR}" -name "*.dump" -mtime "+${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -name "*.dump.sha256" -mtime "+${RETENTION_DAYS}" -delete

echo "[backup] DONE ${TIMESTAMP}"
