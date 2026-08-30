#!/usr/bin/env bash
# =============================================================================
# Backup → Restore Drill（scripts/ops/restore-drill.sh）
#
# 在不影响生产库的前提下验证备份可用性：
#   备份 → 独立验证库 → pg_restore → Prisma/SQL 完整性冒烟 → 核对核心表
#   → 清理验证库
#
# 用法：./scripts/ops/restore-drill.sh [backup.dump]
#   缺省取 BACKUP_DIR 内最新备份；没有备份时先执行一次 backup-postgres.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env.production"
COMPOSE="docker compose -f ${PROJECT_DIR}/compose.production.yml"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:?请在 .env.production 设置 POSTGRES_USER}"
POSTGRES_DB="${POSTGRES_DB:?请在 .env.production 设置 POSTGRES_DB}"
BACKUP_DIR="${BACKUP_DIR:?请在 .env.production 设置 BACKUP_DIR}"
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

echo "[drill] 创建独立验证库 ${DRILL_DB}（不影响 ${POSTGRES_DB}）"
${COMPOSE} exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -c \
  "CREATE DATABASE \"${DRILL_DB}\";"

echo "[drill] pg_restore → ${DRILL_DB}"
if ! ${COMPOSE} exec -T postgres pg_restore -U "${POSTGRES_USER}" -d "${DRILL_DB}" \
    --no-owner --exit-on-error < "${DUMP_FILE}"; then
  echo "[drill] RESTORE FAILED，清理验证库" >&2
  ${COMPOSE} exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -c \
    "DROP DATABASE IF EXISTS \"${DRILL_DB}\";"
  exit 1
fi
echo "[drill] restore OK"

echo "[drill] 完整性冒烟"
core_tables=("User" "Product" "ErrandTask" "ServiceListing" "RentalListing" "Order" "OrderItem" "Conversation" "Message" "Review" "UploadedAsset" "Campus" "_prisma_migrations")
failed=0
printf "%-20s %s\n" "TABLE" "COUNT"
for table in "${core_tables[@]}"; do
  count=$(${COMPOSE} exec -T postgres psql -U "${POSTGRES_USER}" -d "${DRILL_DB}" -tAc \
    "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo "MISSING")
  printf "%-20s %s\n" "${table}" "${count}"
  [[ "${count}" == "MISSING" ]] && failed=1
done

# 迁移完整性：备份库中已完成的迁移数必须 > 0
migrations=$(${COMPOSE} exec -T postgres psql -U "${POSTGRES_USER}" -d "${DRILL_DB}" -tAc \
  "SELECT COUNT(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL;")
echo "[drill] 已完成迁移记录: ${migrations}"
[[ "${migrations}" -gt 0 ]] || failed=1

# 引用完整性抽检：孤儿产品引用（seller 不存在）必须为 0
orphans=$(${COMPOSE} exec -T postgres psql -U "${POSTGRES_USER}" -d "${DRILL_DB}" -tAc \
  "SELECT COUNT(*) FROM \"Product\" p LEFT JOIN \"User\" u ON p.\"sellerId\" = u.id WHERE u.id IS NULL;")
echo "[drill] Product→User 孤儿引用: ${orphans}"
[[ "${orphans}" == "0" ]] || failed=1

echo "[drill] 清理验证库 ${DRILL_DB}"
${COMPOSE} exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -c \
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
