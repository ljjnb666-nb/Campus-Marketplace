#!/usr/bin/env bash
# =============================================================================
# 生产数据库恢复（scripts/ops/restore-production-postgres.sh）
#
# 这是唯一允许覆盖当前生产库的入口，语义强确认、任何一步失败立即非 0 退出：
#
#   ./scripts/ops/restore-production-postgres.sh \
#     --production-restore \
#     --backup-file <backup.dump> \
#     --target-db <POSTGRES_DB 的字面值>
#
# 流程（顺序固定）：
#   1. 参数与环境校验（--production-restore 缺失即拒绝；--target-db 必须与
#      .env.production 的 POSTGRES_DB 完全一致——这是操作员对生产目标的显式确认）
#   2. 备份文件存在性 + SHA256 强校验（.sha256 伴随文件必须存在且一致）
#   3. 停止应用写流量（compose stop app 并确认已停止）
#   4. 终止目标库现存连接
#   5. DROP + CREATE + pg_restore（--exit-on-error）
#   6. 完整性检查：业务核心表逐一 COUNT、_prisma_migrations 已完成迁移数 > 0、
#      孤儿引用抽检
#   7. 成功：应用保持停止状态，打印后续步骤（rollback.sh --hard 会继续切应用）
#      失败：非 0 退出，应用同样保持停止，绝不带坏库恢复服务
#
# 本脚本从不重启应用、从不执行任何 migration（恢复出的库自带 _prisma_migrations）。
# 任何失败状态下都不要手工重启应用——先人工检查，再决定恢复备份或修复。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_production_env

PRODUCTION_RESTORE_FLAG=""
BACKUP_FILE=""
TARGET_DB=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --production-restore) PRODUCTION_RESTORE_FLAG="1"; shift ;;
    --backup-file) BACKUP_FILE="${2:?--backup-file 需要文件路径}"; shift 2 ;;
    --target-db) TARGET_DB="${2:?--target-db 需要库名}"; shift 2 ;;
    *) echo "[prod-restore] 未知参数: $1" >&2; exit 1 ;;
  esac
done

fail() {
  echo "[prod-restore] FAILED: $1" >&2
  echo "[prod-restore] 应用保持停止状态，人工检查后再决定下一步" >&2
  exit 1
}

[[ "${PRODUCTION_RESTORE_FLAG}" == "1" ]] || fail "缺少 --production-restore 显式确认（本脚本会覆盖生产库）"
[[ -n "${BACKUP_FILE}" ]] || fail "缺少 --backup-file <backup.dump>"
[[ -n "${TARGET_DB}" ]] || fail "缺少 --target-db <库名>（必须显式给出生产库名作为确认）"
[[ -f "${BACKUP_FILE}" ]] || fail "备份文件不存在: ${BACKUP_FILE}"

POSTGRES_USER="$(require_env_var POSTGRES_USER)" || fail "无法解析 POSTGRES_USER"
PRODUCTION_DB="$(require_env_var POSTGRES_DB)" || fail "无法解析 POSTGRES_DB"

# 显式确认目标：必须与 .env.production 的生产库名完全一致
if [[ "${TARGET_DB}" != "${PRODUCTION_DB}" ]]; then
  fail "--target-db (${TARGET_DB}) 与 .env.production 的 POSTGRES_DB (${PRODUCTION_DB}) 不一致；拒绝恢复到非生产目标，请改用 restore-postgres.sh"
fi

# SHA256 强校验：伴随文件必须存在且一致
SHA_FILE="${BACKUP_FILE}.sha256"
[[ -f "${SHA_FILE}" ]] || fail "缺少 SHA256 伴随文件 ${SHA_FILE}（无法验证备份完整性）"
echo "[prod-restore] 校验 SHA256..."
(cd "$(dirname "${BACKUP_FILE}")" && sha256sum --check --status "$(basename "${BACKUP_FILE}").sha256") \
  || fail "SHA256 校验失败：备份文件损坏或被篡改，拒绝恢复"
echo "[prod-restore] SHA256 一致"

# 停止应用写流量（app 容器不存在 = 本就没有来自应用的写流量）
app_containers=""
if ! app_containers="$(compose_run ps -q app 2>/dev/null)"; then
  app_containers=""
fi
if [[ -z "${app_containers}" ]]; then
  echo "[prod-restore] app 容器不存在，无应用写流量"
else
  echo "[prod-restore] 停止 app 服务（停止写流量）"
  compose_run stop app
  if compose_run ps --status running --services | grep -qx "app"; then
    fail "app 服务未能停止，拒绝在写流量未停止时覆盖生产库"
  fi
  echo "[prod-restore] app 已停止"
fi

# 终止现存连接
echo "[prod-restore] 终止 ${TARGET_DB} 现存连接"
compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -v ON_ERROR_STOP=1 <<SQL \
  || fail "无法终止目标库现存连接"
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = '${TARGET_DB}' AND pid <> pg_backend_pid();
SQL

# DROP + CREATE + restore（任何失败立即退出；app 保持停止）
echo "[prod-restore] DROP + CREATE ${TARGET_DB}"
compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d postgres -v ON_ERROR_STOP=1 <<SQL \
  || fail "DROP/CREATE 数据库失败"
DROP DATABASE IF EXISTS "${TARGET_DB}";
CREATE DATABASE "${TARGET_DB}";
SQL

echo "[prod-restore] pg_restore 开始"
compose_run exec -T postgres pg_restore \
  -U "${POSTGRES_USER}" \
  -d "${TARGET_DB}" \
  --no-owner \
  --exit-on-error \
  < "${BACKUP_FILE}" \
  || fail "pg_restore 失败"

# 完整性检查
echo "[prod-restore] 完整性检查"
CORE_TABLES=("User" "Product" "ErrandTask" "ServiceListing" "RentalListing" "Order" "Campus" "UploadedAsset")
for table in "${CORE_TABLES[@]}"; do
  count="$(compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" -tAc \
    "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo "MISSING")"
  echo "[prod-restore] ${table}: ${count}"
  [[ "${count}" != "MISSING" ]] || fail "核心表 ${table} 缺失"
done

migrations="$(compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" -tAc \
  "SELECT COUNT(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL;" 2>/dev/null || echo "MISSING")"
echo "[prod-restore] 已完成迁移记录: ${migrations}"
if [[ "${migrations}" == "MISSING" || "${migrations}" -eq 0 ]]; then
  fail "_prisma_migrations 无已完成迁移记录"
fi

orphans="$(compose_run exec -T postgres psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" -tAc \
  "SELECT COUNT(*) FROM \"Product\" p LEFT JOIN \"User\" u ON p.\"sellerId\" = u.id WHERE u.id IS NULL;")"
echo "[prod-restore] Product→User 孤儿引用: ${orphans}"
[[ "${orphans}" == "0" ]] || fail "存在孤儿引用，恢复不完整"

echo "[prod-restore] ============================================"
echo "[prod-restore] PRODUCTION RESTORE OK → ${TARGET_DB}"
echo "[prod-restore] 应用当前处于停止状态。继续切回旧镜像请运行 rollback.sh --hard 的后续流程，"
echo "[prod-restore] 或 $(compose_cmd) start app 直接以当前镜像恢复服务。"
echo "[prod-restore] ============================================"
