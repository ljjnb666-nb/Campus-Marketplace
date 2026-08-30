#!/usr/bin/env bash
# =============================================================================
# rollback / restore shell-level regression tests
#
# 通过 PATH stub（docker/curl）与 OPS_* 测试钩子在沙箱中执行真实脚本，
# 覆盖：
#   1. safe rollback 不碰 DB（restore 不被调用）
#   2. hard restore 失败 → app 回滚不执行（exit != 0）
#   3. hard restore 成功 → app 回滚才执行（exit == 0）
#   4. 缺少备份文件 → 失败
#   5. SHA256 不一致 → 失败
#   6. 缺少 --production-restore 显式确认 → 失败
#   7. --target-db 与生产库名不一致 → 失败
# 由 tests/ops/ops-scripts.test.ts（vitest）调用并断言整体退出码。
# =============================================================================
set -uo pipefail

PASS=0
FAIL=0
CALL_LOG=""          # 沙箱内动作日志
SANDBOX=""

log() { CALL_LOG="${CALL_LOG}$1"$'\n'; }

fail_test() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass_test() { PASS=$((PASS + 1)); }

assert_log_contains() {
  if printf '%s' "$CALL_LOG" | grep -qF "$1"; then pass_test; else fail_test "log 缺少: $1（实际: $(printf '%s' "$CALL_LOG" | tr '\n' ';')）"; fi
}
assert_log_not_contains() {
  if printf '%s' "$CALL_LOG" | grep -qF "$1"; then fail_test "log 不应包含: $1"; else pass_test; fi
}
assert_exit() {
  if [[ "$1" == "$2" ]]; then pass_test; else fail_test "$3: 期望 exit=$1 实际=$2"; fi
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

make_sandbox() {
  [[ -n "${SANDBOX}" ]] && rm -rf "${SANDBOX}"
  SANDBOX="$(mktemp -d)"
  mkdir -p "${SANDBOX}/bin" "${SANDBOX}/backups"
  cat > "${SANDBOX}/.env.production" <<'ENV'
SITE_ADDRESS=campus.example.edu.cn
POSTGRES_USER=campus_app
POSTGRES_PASSWORD=SandboxOnly-Not-For-Real-Deploy
POSTGRES_DB=campus_marketplace
REDIS_PASSWORD=SandboxOnly-Not-For-Real-Deploy
REDIS_URL=redis://:SandboxOnly-Not-For-Real-Deploy@redis:6379
NEXTAUTH_URL=https://campus.example.edu.cn
NEXTAUTH_SECRET=sandbox-only-not-a-real-secret-0123456789
APP_NAME=校园集市
DEFAULT_CAMPUS_SLUG=main-campus
BACKUP_DIR=PLACEHOLDER_BACKUP_DIR
BACKUP_OFFSITE_TARGET=
BACKUP_RETENTION_DAYS=14
ENV
  sed -i "s|PLACEHOLDER_BACKUP_DIR|${SANDBOX}/backups|" "${SANDBOX}/.env.production"

  # ---- docker stub ----
  cat > "${SANDBOX}/bin/docker" <<STUB
#!/usr/bin/env bash
ARGS="\$*"
case "\$ARGS" in
  *"image inspect"*)
    [[ "\$ARGS" == *"EXPECTED_PREV_SHA"* ]] && exit 0 || exit 1 ;;
  *"compose"*"stop app"*)
    echo "app_stop_called" >> "${SANDBOX}/calls.log"; exit 0 ;;
  *"compose"*"ps -q app"*)
    # 返回非空 = app 容器存在，走 stop 分支
    echo "container-id"; exit 0 ;;
  *"compose"*"ps --status running --services"*)
    # stop 之后 app 不在运行列表
    exit 0 ;;
  *"compose"*"up -d"*)
    echo "app_up_called:\$ARGS" >> "${SANDBOX}/calls.log"; exit 0 ;;
  *"compose"*"exec -T postgres psql"*)
    echo "psql_called:\$ARGS" >> "${SANDBOX}/calls.log"; exit 0 ;;
  *"compose"*"exec -T postgres pg_dump"*)
    echo "pg_dump_called" >> "${SANDBOX}/calls.log"; echo "DUMMYDUMP"; exit 0 ;;
  *"compose"*"exec -T postgres pg_restore"*)
    echo "pg_restore_called" >> "${SANDBOX}/calls.log"; exit 0 ;;
  *) echo "[docker-stub] unhandled: \$ARGS" >> "${SANDBOX}/calls.log"; exit 0 ;;
esac
STUB
  chmod +x "${SANDBOX}/bin/docker"

  # ---- curl stub（health 返回期望的 release）----
  cat > "${SANDBOX}/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo '{"status":"ok","release":"EXPECTED_PREV_SHA","timestamp":"2026-01-01T00:00:00Z"}'
exit 0
STUB
  chmod +x "${SANDBOX}/bin/curl"

  # ---- restore stub（可配置成败，记录调用；模式运行时读取）----
  cat > "${SANDBOX}/bin/restore-stub" <<STUB
#!/usr/bin/env bash
echo "restore_called:\$*" >> "${SANDBOX}/calls.log"
case "\${RESTORE_STUB_MODE:-success}" in
  success) exit 0 ;;
  failure) exit 1 ;;
esac
STUB
  chmod +x "${SANDBOX}/bin/restore-stub"
}

run_rollback() {
  CALL_LOG=""
  rm -f "${SANDBOX}/calls.log"
  RESTORE_STUB_MODE="${RESTORE_STUB_MODE:-success}" \
  OPS_PROJECT_DIR="${SANDBOX}" \
  OPS_RESTORE_SCRIPT="${SANDBOX}/bin/restore-stub" \
  OPS_SLEEP_SECONDS=0 \
  PATH="${SANDBOX}/bin:${PATH}" \
  bash "${REPO_ROOT}/scripts/ops/rollback.sh" EXPECTED_PREV_SHA "${2:-}" > /tmp/rb-out.$$ 2>&1
  local rc=$?
  [[ -f "${SANDBOX}/calls.log" ]] && CALL_LOG="$(cat "${SANDBOX}/calls.log")"
  return "${rc}"
}

PREV_SHA="$(printf 'a%.0s' {1..40})"

echo "== 1. safe rollback 不碰 DB =="
RESTORE_STUB_MODE=success make_sandbox
run_rollback "${PREV_SHA}"; rc=$?
assert_exit 0 "$rc" "safe rollback"
assert_log_contains "app_up_called"
assert_log_not_contains "restore_called"
assert_log_not_contains "app_stop_called"

echo "== 2. hard restore 失败 → app 回滚不执行 =="
printf 'DUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
echo "deadbeef  db-20260101.dump" > "${SANDBOX}/backups/db-20260101.dump.sha256"
CALL_LOG=""; rm -f "${SANDBOX}/calls.log"
RESTORE_STUB_MODE=failure \
OPS_PROJECT_DIR="${SANDBOX}" OPS_RESTORE_SCRIPT="${SANDBOX}/bin/restore-stub" OPS_SLEEP_SECONDS=0 \
PATH="${SANDBOX}/bin:${PATH}" \
bash "${REPO_ROOT}/scripts/ops/rollback.sh" EXPECTED_PREV_SHA --hard >/tmp/rb-hard-fail.$$ 2>&1; rc=$?
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_exit 1 "$rc" "hard rollback with restore failure"
assert_log_contains "restore_called"
assert_log_not_contains "app_up_called"

echo "== 3. hard restore 成功 → app 回滚才执行 =="
run_rollback "${PREV_SHA}" --hard; rc=$?
assert_exit 0 "$rc" "hard rollback with restore success"
assert_log_contains "restore_called"
assert_log_contains "app_up_called"

echo "== 4. 缺少备份文件 → 失败（不调用 restore）=="
make_sandbox   # 新沙箱，BACKUP_DIR 为空
run_rollback "${PREV_SHA}" --hard; rc=$?
assert_exit 1 "$rc" "missing backup"
assert_log_not_contains "restore_called"

echo "== 5. SHA256 不一致 → 失败（真实 restore 脚本）=="
make_sandbox
printf 'REALDUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
echo "0000000000000000000000000000000000000000000000000000000000000000  db-20260101.dump" > "${SANDBOX}/backups/db-20260101.dump.sha256"
OPS_PROJECT_DIR="${SANDBOX}" OPS_SLEEP_SECONDS=0 PATH="${SANDBOX}/bin:${PATH}" \
  bash "${REPO_ROOT}/scripts/ops/restore-production-postgres.sh" \
    --production-restore --backup-file "${SANDBOX}/backups/db-20260101.dump" \
    --target-db campus_marketplace >/tmp/rp-sha.$$ 2>&1; rc=$?
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_exit 1 "$rc" "sha mismatch"
assert_log_not_contains "app_stop_called"

echo "== 6. 缺少 --production-restore 显式确认 → 失败 =="
make_sandbox
printf 'REALDUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
OPS_PROJECT_DIR="${SANDBOX}" PATH="${SANDBOX}/bin:${PATH}" \
  bash "${REPO_ROOT}/scripts/ops/restore-production-postgres.sh" \
    --backup-file "${SANDBOX}/backups/db-20260101.dump" \
    --target-db campus_marketplace >/tmp/rp-noflag.$$ 2>&1; rc=$?
assert_exit 1 "$rc" "missing --production-restore"

echo "== 7. --target-db 与生产库名不一致 → 失败 =="
make_sandbox
printf 'REALDUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
echo "$(sha256sum "${SANDBOX}/backups/db-20260101.dump" | awk '{print $1}')  db-20260101.dump" > "${SANDBOX}/backups/db-20260101.dump.sha256"
OPS_PROJECT_DIR="${SANDBOX}" PATH="${SANDBOX}/bin:${PATH}" \
  bash "${REPO_ROOT}/scripts/ops/restore-production-postgres.sh" \
    --production-restore --backup-file "${SANDBOX}/backups/db-20260101.dump" \
    --target-db some_other_db >/tmp/rp-mismatch.$$ 2>&1; rc=$?
assert_exit 1 "$rc" "target-db mismatch"
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_log_not_contains "app_stop_called"

# 清理沙箱
rm -rf "${SANDBOX}" /tmp/rb-out.$$ /tmp/rb-hard-fail.$$ /tmp/rp-sha.$$ /tmp/rp-noflag.$$ /tmp/rp-mismatch.$$ 2>/dev/null

echo "=============================="
echo "PASS=${PASS} FAIL=${FAIL}"
if [[ "${FAIL}" != "0" ]]; then exit 1; fi
exit 0
