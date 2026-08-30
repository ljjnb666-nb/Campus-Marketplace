#!/usr/bin/env bash
# =============================================================================
# Backup → Restore Drill（scripts/ops/restore-drill.sh）
#
# 在不影响生产库的前提下验证备份可用性：
#   备份 → 独立验证库 → pg_restore → 完整性冒烟（核心表/迁移记录/孤儿引用）
#   → 清理验证库
#
# 用法：./scripts/ops/restore-drill.sh [backup.dump]
#   缺省取 BACKUP_DIR 内最新备份；没有备份时先执行一次 backup-postgres.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_production_env

POSTGRES_USER="$(require_env_var POSTGRES_USER)"
PRODUCTION_DB="$(require_env_var POSTGRES_DB)"
BACKUP_DIR="$(require_env_var BACKUP_DIR)"
DRILL_DB="restore_drill_$(date +%Y%m%d%H%M%S)"

DUMP_FILE="${1:-}"
if [[ -z "${DUMP_FILE}" ]]; then
  "${SCRIPT_DIR}/backup-postgres.sh"
  DUMP_FILE="$(ls -1t "${BACKUP_DIR}"/*.dump | head -1)"
fi

echo "[drill] 备份文件: ${DUMP_FILE}"
SIZE_BYTES="$(wc -c < "${DUMP_FILE}" | tr -d ' ')"
SHA256="$(sha256sum "${DUMP_FILE}" | awk '{print $1}')"
TIMESTAMP="$(date -Is)"
echo "[drill] 大小: ${SIZE_BYTES} bytes  SHA256: ${SHA256}  时间: ${TIMESTAMP}"

echo "[drill] 创建独立验证库 ${DRILL_DB}（不影响 ${PRODUCTION_DB}）"
compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -c \
  "CREATE DATABASE \"${DRILL_DB}\";"

echo "[drill] pg_restore → ${DRILL_DB}"
if ! compose_run exec -T postgres pg_restore -U "${POSTGRES_USER}" -d "${DRILL_DB}" \
    --no-owner --exit-on-error < "${DUMP_FILE}"; then
  echo "[drill] RESTORE FAILED，清理验证库" >&2
  compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -c \
    "DROP DATABASE IF EXISTS \"${DRILL_DB}\";"
  exit 1
fi
echo "[drill] restore OK"

echo "[drill] 完整性冒烟"
core_tables=("User" "Product" "ErrandTask" "ServiceListing" "RentalListing" "RentalOrder" "Order" "Conversation" "Message" "Review" "UploadedAsset" "Campus")
failed=0
printf "%-20s %s\n" "TABLE" "COUNT"
for table in "${core_tables[@]}"; do
  count="$(compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d "${DRILL_DB}" -tAc \
    "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo "MISSING")"
  printf "%-20s %s\n" "${table}" "${count}"
  [[ "${count}" == "MISSING" ]] && failed=1
done

# 迁移完整性：Prisma 内部迁移记录表单独验证（不属于业务核心表）
migrations="$(compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d "${DRILL_DB}" -tAc \
  "SELECT COUNT(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL;" 2>/dev/null || echo "MISSING")"
echo "[drill] 已完成迁移记录: ${migrations}"
[[ "${migrations}" != "MISSING" && "${migrations}" -gt 0 ]] || failed=1

# 引用完整性抽检：孤儿产品引用（seller 不存在）必须为 0
orphans="$(compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d "${DRILL_DB}" -tAc \
  "SELECT COUNT(*) FROM \"Product\" p LEFT JOIN \"User\" u ON p.\"sellerId\" = u.id WHERE u.id IS NULL;")"
echo "[drill] Product→User 孤儿引用: ${orphans}"
[[ "${orphans}" == "0" ]] || failed=1

echo "[drill] 清理验证库 ${DRILL_DB}"
compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -c \
  "DROP DATABASE IF EXISTS \"${DRILL_DB}\";"

if [[ "${failed}" == "1" ]]; then
  echo "[drill] DRILL FAILED" >&2
  exit 1
fi

echo "[drill] ============================================"
echo "[drill] DRILL PASS"
echo "[drill] backup_size=${SIZE_BYTES} bytes"
echo "[drill] backup_sha256=${SHA256}"
echo "[drill] backup_timestamp=${TIMESTAMP}"
echo "[drill] restore_target=${DRILL_DB}（已清理）"
echo "[drill] ============================================"
