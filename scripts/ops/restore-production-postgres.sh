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
#   3. 停止全部生产 DB writers（app + storage-cleanup + async-worker，Phase 9A：
#      cleanup worker 自本 release 起也是 DB writer）并逐一验证已停止；
#      容器不存在 = 无该 writer（pre-worker release 兼容）；
#      任一存在且无法停止 → FAIL CLOSED，绝不继续 DROP/RESTORE
#   4. 终止目标库现存连接（仅在全部 writers 停止之后）
#   5. DROP + CREATE + pg_restore（--exit-on-error）
#   6. 完整性检查：业务核心表逐一 COUNT、_prisma_migrations 已完成迁移数 > 0、
#      孤儿引用抽检
#   7. 成功：production writers 保持停止状态，打印后续步骤（rollback.sh --hard
#      会按目标 release policy 继续切换 app / storage-cleanup / async-worker）
#      失败：非 0 退出，production writers 同样全部保持停止，绝不带坏库恢复服务
#
# 本脚本从不重启任何 writer、从不执行任何 migration（恢复出的库自带
# _prisma_migrations）。任何失败状态下都不要手工重启 app / storage-cleanup / async-worker
# ——先人工检查，再决定恢复备份或修复。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
# Prevent a redirected checkout from addressing the production Compose namespace.
check_ops_project_scope
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

# -----------------------------------------------------------------------------
# 失败消息卫生：必须区分"破坏性恢复是否已可能发生"——
#   - quiesce 完成前的失败：绝不声称 writers 已停止（此时可能有 writer 仍在
#     运行，或尚未进入停止阶段），只声明未执行任何破坏性恢复操作；
#   - quiesce 成功后（app + storage-cleanup + async-worker 均验证停止）的失败：全部
#     production writers 确实保持停止。
# WRITERS_QUIESCED 仅在全部三个 writer 都验证停止后置 1。
# -----------------------------------------------------------------------------
WRITERS_QUIESCED=0

fail() {
  echo "[prod-restore] FAILED: $1" >&2
  if [[ "${WRITERS_QUIESCED}" == "1" ]]; then
    echo "[prod-restore] production writers（app / storage-cleanup / async-worker）保持停止状态，人工检查后再决定下一步" >&2
  else
    echo "[prod-restore] 未执行任何破坏性恢复操作；写流量状态未完全确认，人工检查全部 writers 后再继续" >&2
  fi
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

# Exclude scheduled backup/retention for the entire destructive restore.
# The lock must be acquired before any writer is stopped or DB is dropped.
BACKUP_DIR="$(require_env_var BACKUP_DIR)" || fail "无法获取备份目录，不能申请备份/恢复互斥锁"
[[ -d "${BACKUP_DIR}" ]] || fail "备份目录不存在，不能申请互斥锁"
exec 9>"${BACKUP_DIR}/.backup-restore.lock" || fail "无法打开备份/恢复互斥锁"
flock -n 9 || fail "BACKUP_RESTORE_LOCK_BUSY：另一备份或恢复正在执行，禁止破坏性恢复"

# Backup and destructive restore must never run at the same time.
# Acquire the same host-local FD as backup-postgres.sh before quiescing writers,
# checksum checks or DROP/CREATE; never wait indefinitely for a scheduler.
LOCK_DIR="$(require_env_var BACKUP_DIR)" || fail "BACKUP_RESTORE_LOCK_DIR_UNAVAILABLE"
[[ -d "${LOCK_DIR}" ]] || fail "BACKUP_RESTORE_LOCK_DIR_UNAVAILABLE"
LOCK_FILE="${LOCK_DIR}/${BACKUP_RESTORE_LOCK_NAME}"
if ! exec {BACKUP_RESTORE_LOCK_FD}> "${LOCK_FILE}"; then
  fail "BACKUP_RESTORE_LOCK_UNAVAILABLE"
fi
if ! flock -n "${BACKUP_RESTORE_LOCK_FD}"; then
  fail "BACKUP_RESTORE_LOCK_BUSY: another backup/restore is active"
fi

# SHA256 强校验：伴随文件必须存在且一致
SHA_FILE="${BACKUP_FILE}.sha256"
[[ -f "${SHA_FILE}" ]] || fail "缺少 SHA256 伴随文件 ${SHA_FILE}（无法验证备份完整性）"
echo "[prod-restore] 校验 SHA256..."
(cd "$(dirname "${BACKUP_FILE}")" && sha256sum --check --status "$(basename "${BACKUP_FILE}").sha256") \
  || fail "SHA256 校验失败：备份文件损坏或被篡改，拒绝恢复"
echo "[prod-restore] SHA256 一致"

# Persist an out-of-database quarantine before touching production writers/DB.
# Fail closed if the marker cannot be written. Never remove it automatically.
# A local file is defense in depth and does not substitute for an external
# authority / cross-host approval gate.
(umask 077; printf 'RECOVERY_HOLD=1\n' > "${RECOVERY_HOLD_FILE}") \
  || fail "无法持久化恢复安全封锁标记，禁止执行生产恢复"
[[ -f "${RECOVERY_HOLD_FILE}" && ! -L "${RECOVERY_HOLD_FILE}" ]] \
  || fail "恢复封锁标记不可信，禁止执行生产恢复"
echo "[prod-restore] RECOVERY HOLD ACTIVE: production deploy/rollback must remain blocked"

# -----------------------------------------------------------------------------
# 停止全部生产 DB writers（Phase 9A）：app + storage-cleanup + async-worker 都是
# 数据库写入方，覆盖生产库之前必须全部 quiesce。
# 语义（全部 fail closed——writer 状态未知 ≠ writer 已停止）：
#   - compose ps 命令失败 → FAIL CLOSED（绝不把命令失败当成"无容器/已停止"）
#   - compose ps 成功 + 输出为空 → 容器不存在 = 无该 writer 写流量 → OK
#     （storage-cleanup 不存在同时兼容 pre-worker release）
#   - compose ps 成功 + 容器存在 → 停止；stop 命令失败 → FAIL CLOSED
#   - 停止后验证同样两阶段：compose ps 失败 → FAIL CLOSED；只有命令成功后
#     才判定"仍在 running → FAIL / 不在 running → 已停止"
# 顺序：先全部停止并验证，然后才允许终止 DB 连接 / DROP / CREATE / restore。
# -----------------------------------------------------------------------------
stop_production_writer() {
  local svc="$1"
  local containers=""
  if ! containers="$(compose_run ps -q "${svc}")"; then
    fail "无法确认 ${svc} writer 状态（compose ps 失败）；未执行任何破坏性恢复操作"
  fi
  if [[ -z "${containers}" ]]; then
    echo "[prod-restore] ${svc} 容器不存在，无该 writer 写流量"
    return 0
  fi
  echo "[prod-restore] 停止 ${svc} 服务（停止写流量）"
  if ! compose_run stop "${svc}"; then
    fail "${svc} 停止命令失败，写流量未确认停止；未执行任何破坏性恢复操作"
  fi
  local running_services=""
  if ! running_services="$(compose_run ps --status running --services)"; then
    fail "无法确认 ${svc} 停止状态（compose ps 失败）；未执行任何破坏性恢复操作"
  fi
  if printf '%s\n' "${running_services}" | grep -qx "${svc}"; then
    fail "${svc} 服务未能停止，写流量未停止；未执行任何破坏性恢复操作"
  fi
  echo "[prod-restore] ${svc} 已停止"
}

stop_production_writer app
stop_production_writer storage-cleanup
stop_production_writer async-worker
# 三个 writer 均验证停止：此后失败的恢复操作不会造成新的写流量
WRITERS_QUIESCED=1

# 终止现存连接——此时全部 production writers（app / storage-cleanup）已验证停止
echo "[prod-restore] 终止 ${TARGET_DB} 现存连接（全部 production writers 已停止）"
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

# A restore rewinds security state as well as business rows. Sessions revoked after
# the backup and single-use recovery links consumed after the backup would otherwise
# become valid again. This must finish before rollback.sh may start any writer.
# No active AccountSession table means an old JWT-only release cannot be forcibly
# invalidated via database authority: fail closed and require an operator-reviewed
# secret rotation/recovery procedure before reopening traffic.
echo "[prod-restore] 撤销备份中恢复的所有登录会话与一次性恢复链接"
if ! compose_run exec -T postgres psql -X -U "${POSTGRES_USER}" -d "${TARGET_DB}" -v ON_ERROR_STOP=1 <<'SECURITY_SQL'
BEGIN;
DO $recovery_security$
BEGIN
  -- Credential hashes are also rewound by pg_restore. Never allow a restored
  -- password to mint a new session until the mailbox/MFA reset flow succeeds.
  -- Old snapshots without this schema must fail closed with writers stopped.
  IF to_regclass('public."User"') IS NULL THEN
    RAISE EXCEPTION 'RECOVERY_USER_SCHEMA_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User'
      AND column_name = 'credentialRecoveryRequired'
  ) THEN
    RAISE EXCEPTION 'RECOVERY_CREDENTIAL_HOLD_SCHEMA_MISSING';
  END IF;
  UPDATE "User"
  SET "credentialRecoveryRequired" = TRUE
  WHERE "credentialRecoveryRequired" = FALSE;
  IF EXISTS (SELECT 1 FROM "User" WHERE "credentialRecoveryRequired" IS DISTINCT FROM TRUE) THEN
    RAISE EXCEPTION 'RECOVERY_CREDENTIAL_HOLD_INCOMPLETE';
  END IF;
  IF to_regclass('public."AccountSession"') IS NULL THEN
    RAISE EXCEPTION 'RECOVERY_ACCOUNT_SESSION_SCHEMA_MISSING';
  END IF;
  UPDATE "AccountSession"
  SET "revokedAt" = CURRENT_TIMESTAMP
  WHERE "revokedAt" IS NULL;
  IF EXISTS (SELECT 1 FROM "AccountSession" WHERE "revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'RECOVERY_SESSION_REVOCATION_INCOMPLETE';
  END IF;

  IF to_regclass('public."AccountChallenge"') IS NOT NULL THEN
    UPDATE "AccountChallenge"
    SET "consumedAt" = CURRENT_TIMESTAMP
    WHERE "consumedAt" IS NULL;
    IF EXISTS (SELECT 1 FROM "AccountChallenge" WHERE "consumedAt" IS NULL) THEN
      RAISE EXCEPTION 'RECOVERY_CHALLENGE_INVALIDATION_INCOMPLETE';
    END IF;
  END IF;
END
$recovery_security$;
COMMIT;
SECURITY_SQL
then
  fail "恢复后的登录会话或账号恢复链接未能全部失效；禁止重新开放应用"
fi
echo "[prod-restore] 历史会话及链接已失效；所有恢复账号已进入凭据隔离，旧密码不得直接重新登录"
echo "[prod-restore] 灾后隔离账号禁止普通邮件重置解锁；必须等待独立可信身份恢复流程，禁止人工批量清除此标记"

echo "[prod-restore] ============================================"
echo "[prod-restore] DATABASE RESTORE AND CREDENTIAL ISOLATION OK → ${TARGET_DB} (LOGIN REOPEN NOT AUTHORIZED)"
echo "[prod-restore] production writers（app / storage-cleanup / async-worker）当前均处于停止状态。"
echo "[prod-restore] SECURITY HOLD：恢复完成不等于允许重新开放；禁止直接重启 app / storage-cleanup / async-worker。"
echo "[prod-restore] 必须先使用独立于恢复数据库的身份/邮箱/MFA/RBAC 事实完成对账，并取得独立审批。"
echo "[prod-restore] 生产 rollback.sh --hard 当前默认禁止启动（RECOVERY_EXTERNAL_IDENTITY_APPROVAL_REQUIRED）。"
echo "[prod-restore] 在完成独立审批门禁的开发、审计与演练之前，任何 writer 均必须保持停止。"
echo "[prod-restore] ============================================"
