#!/usr/bin/env bash
# =============================================================================
# PostgreSQL 恢复（scripts/ops/restore-postgres.sh）
#
# 用法：
#   ./scripts/ops/restore-postgres.sh <backup.dump> <target_db>
#
# - 恢复到指定 target_db（绝不覆盖当前生产库名，除非显式传 -f 覆盖检查）
# - 恢复前校验 SHA256（存在 .sha256 伴随文件时）
# - pg_restore custom 格式，--no-owner --role=应用角色
#
# 正式生产恢复流程见 docs/BACKUP_RESTORE.md（先停写/评估再操作）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env.production"

DUMP_FILE="${1:?用法: restore-postgres.sh <backup.dump> <target_db>}"
TARGET_DB="${2:?用法: restore-postgres.sh <backup.dump> <target_db>}"

if [[ ! -f "${DUMP_FILE}" ]]; then
  echo "[restore] 备份文件不存在: ${DUMP_FILE}" >&2
  exit 1
fi

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:?请在 .env.production 设置 POSTGRES_USER}"

# SHA256 校验
if [[ -f "${DUMP_FILE}.sha256" ]]; then
  echo "[restore] 校验 SHA256..."
  echo "$(cat "${DUMP_FILE}.sha256")" | sha256sum --check --status -
  echo "[restore] SHA256 一致"
fi

COMPOSE="docker compose -f ${PROJECT_DIR}/compose.production.yml"

echo "[restore] 目标库: ${TARGET_DB}（当前生产库 ${POSTGRES_DB}，二者不同才会继续）"
if [[ "${TARGET_DB}" == "${POSTGRES_DB}" ]]; then
  echo "[restore] 拒绝：目标库名与生产库相同。恢复到当前生产库必须走 docs/BACKUP_RESTORE.md 的完整流程（停写→drop→restore→校验）" >&2
  exit 1
fi

# 独立目标库（已存在则清空重建）
${COMPOSE} exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TARGET_DB}';
DROP DATABASE IF EXISTS "${TARGET_DB}";
CREATE DATABASE "${TARGET_DB}";
SQL

echo "[restore] pg_restore 开始"
${COMPOSE} exec -T postgres pg_restore \
  -U "${POSTGRES_USER}" \
  -d "${TARGET_DB}" \
  --no-owner \
  --exit-on-error \
  < "${DUMP_FILE}"

echo "[restore] 完整性校验（核心表可查询）"
CORE_TABLES=("User" "Product" "ErrandTask" "ServiceListing" "RentalListing" "Order" "Campus" "PrismaMigration")
for table in "${CORE_TABLES[@]}"; do
  count=$(${COMPOSE} exec -T postgres psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" -tAc \
    "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo "MISSING")
  echo "[restore] ${table}: ${count}"
  if [[ "${count}" == "MISSING" ]]; then
    echo "[restore] 核心表 ${table} 缺失，恢复失败" >&2
    exit 1
  fi
done

# 迁移记录一致性
applied=$(${COMPOSE} exec -T postgres psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" -tAc \
  "SELECT COUNT(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL;")
echo "[restore] 已完成迁移记录: ${applied}"

echo "[restore] DONE → ${TARGET_DB}"
echo "[restore] 验证完成后请清理验证库: ${COMPOSE} exec postgres psql -U ${POSTGRES_USER} -d postgres -c 'DROP DATABASE \"${TARGET_DB}\"'"
