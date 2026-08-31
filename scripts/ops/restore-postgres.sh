#!/usr/bin/env bash
# =============================================================================
# PostgreSQL 恢复到非生产目标（scripts/ops/restore-postgres.sh）
#
# 用法：
#   ./scripts/ops/restore-postgres.sh <backup.dump> <target_db>
#
# - 恢复到指定 target_db；**拒绝 target_db == 生产库名**（覆盖生产库必须走
#   restore-production-postgres.sh，其有独立的强确认/停写/完整性流程）
# - 恢复前校验 SHA256（存在 .sha256 伴随文件时）
# - 业务核心表检查与 Prisma migration table 检查分离：
#   * 核心业务表用表名逐一 COUNT（缺失即 FAIL）
#   * _prisma_migrations 是 Prisma 内部迁移记录表，单独验证已完成迁移数 > 0
#
# 正式生产恢复见 restore-production-postgres.sh；流程文档 docs/BACKUP_RESTORE.md。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_production_env

DUMP_FILE="${1:?用法: restore-postgres.sh <backup.dump> <target_db>}"
TARGET_DB="${2:?用法: restore-postgres.sh <backup.dump> <target_db>}"

if [[ ! -f "${DUMP_FILE}" ]]; then
  echo "[restore] 备份文件不存在: ${DUMP_FILE}" >&2
  exit 1
fi

POSTGRES_USER="$(require_env_var POSTGRES_USER)"
PRODUCTION_DB="$(require_env_var POSTGRES_DB)"

echo "[restore] 目标库: ${TARGET_DB}（当前生产库 ${PRODUCTION_DB}，二者不同才会继续）"
if [[ "${TARGET_DB}" == "${PRODUCTION_DB}" ]]; then
  echo "[restore] 拒绝：目标库名与生产库相同。覆盖生产库必须走" \
       "restore-production-postgres.sh --production-restore（停写→校验→恢复→完整性检查）" >&2
  exit 1
fi

# SHA256 校验（伴随文件存在时强制一致）
if [[ -f "${DUMP_FILE}.sha256" ]]; then
  echo "[restore] 校验 SHA256..."
  if ! (cd "$(dirname "${DUMP_FILE}")" && sha256sum --check --status "$(basename "${DUMP_FILE}").sha256"); then
    echo "[restore] SHA256 校验失败，备份文件可能损坏或被篡改" >&2
    exit 1
  fi
  echo "[restore] SHA256 一致"
fi

echo "[restore] 创建独立目标库 ${TARGET_DB}（已存在则清空重建）"
compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TARGET_DB}';
DROP DATABASE IF EXISTS "${TARGET_DB}";
CREATE DATABASE "${TARGET_DB}";
SQL

echo "[restore] pg_restore 开始"
compose_run exec -T postgres pg_restore \
  -U "${POSTGRES_USER}" \
  -d "${TARGET_DB}" \
  --no-owner \
  --exit-on-error \
  < "${DUMP_FILE}"

echo "[restore] 完整性校验"

# ---- 业务核心表（逐一 COUNT，缺失即 FAIL）----
CORE_TABLES=("User" "Product" "ErrandTask" "ServiceListing" "RentalListing" "Order" "Campus" "UploadedAsset")
restore_failed=0
for table in "${CORE_TABLES[@]}"; do
  count="$(compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" -tAc \
    "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo "MISSING")"
  echo "[restore] ${table}: ${count}"
  if [[ "${count}" == "MISSING" ]]; then
    echo "[restore] 核心表 ${table} 缺失，恢复失败" >&2
    restore_failed=1
  fi
done

# ---- Prisma migration 记录（内部表，与业务表分开验证）----
migrations="$(compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" -tAc \
  "SELECT COUNT(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL;" 2>/dev/null || echo "MISSING")"
echo "[restore] 已完成迁移记录: ${migrations}"
if [[ "${migrations}" == "MISSING" || "${migrations}" -eq 0 ]]; then
  echo "[restore] _prisma_migrations 无已完成迁移记录，恢复不完整" >&2
  restore_failed=1
fi

# ---- 引用完整性抽检：孤儿产品引用必须为 0 ----
orphans="$(compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" -tAc \
  "SELECT COUNT(*) FROM \"Product\" p LEFT JOIN \"User\" u ON p.\"sellerId\" = u.id WHERE u.id IS NULL;")"
echo "[restore] Product→User 孤儿引用: ${orphans}"
if [[ "${orphans}" != "0" ]]; then
  restore_failed=1
fi

if [[ "${restore_failed}" != "0" ]]; then
  echo "[restore] FAILED（目标库 ${TARGET_DB} 保留供排查）" >&2
  exit 1
fi

echo "[restore] DONE → ${TARGET_DB}"
echo "[restore] 验证完成后清理: $(compose_cmd) exec postgres psql -U <user> -d postgres -c 'DROP DATABASE \"${TARGET_DB}\"'"
