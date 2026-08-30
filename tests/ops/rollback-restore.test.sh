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
  # config --images 按 $GIT_SHA 模拟 compose 插值：GIT_SHA 未设置/为空 → :local
  # （与 compose.production.yml 的 ${GIT_SHA:-local} 行为一致），以此捕捉
  # "rollback 未显式传递 GIT_SHA" 的 bug；CONFIG_STUB_MODE=broken 强制输出
  # 错误镜像，验证 resolved-image assert 会阻断回滚。
  cat > "${SANDBOX}/bin/docker" <<STUB
#!/usr/bin/env bash
ARGS="\$*"
echo "docker called:\$ARGS" >> "${SANDBOX}/calls.log"
case "\$ARGS" in
  *"image inspect"*)
    [[ "\$ARGS" == *"EXPECTED_PREV_SHA"* ]] && exit 0 || exit 1 ;;
  *"config --images"*)
    if [[ -n "\${CONFIG_STUB_MODE:-}" && "\${CONFIG_STUB_MODE}" == "broken" ]]; then
      echo "caddy:2-alpine"; echo "campus-marketplace-app:local"; echo "postgres:16-alpine"
    elif [[ -n "\${GIT_SHA:-}" ]]; then
      echo "caddy:2-alpine"; echo "campus-marketplace-app:\${GIT_SHA}"; echo "campus-marketplace-migrator:\${GIT_SHA}"; echo "postgres:16-alpine"; echo "redis:7-alpine"
    else
      echo "caddy:2-alpine"; echo "campus-marketplace-app:local"; echo "postgres:16-alpine"
    fi
    exit 0 ;;
  *"compose"*"stop app"*)
    echo "app_stop_called" >> "${SANDBOX}/calls.log"; exit 0 ;;
  *"compose"*"ps -q app"*)
    echo "container-id"; exit 0 ;;
  *"compose"*"ps --status running --services"*)
    exit 0 ;;
  *"compose"*"up -d"*)
    echo "app_up_called GIT_SHA=\${GIT_SHA:-<unset>} ARGS=\$ARGS" >> "${SANDBOX}/calls.log"; exit 0 ;;
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

  # ---- curl stub（health 返回的 release 可配置）----
  cat > "${SANDBOX}/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "{\"status\":\"ok\",\"release\":\"${CURL_STUB_RELEASE:-EXPECTED_PREV_SHA}\",\"timestamp\":\"2026-01-01T00:00:00Z\"}"
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
  local sha="$1"
  shift
  local mode=""
  if [[ "${1:-}" == "--hard" ]]; then
    mode="--hard"
    shift
  elif [[ "${1:-}" == "" ]]; then
    shift
  fi
  CALL_LOG=""
  rm -f "${SANDBOX}/calls.log"
  # 一律经 env 命令注入环境：展开形式的 VAR=v 不能作为 assignment 前缀
  env "${EXTRA_ENV[@]}" PATH="${SANDBOX}/bin:${PATH}" \
    RESTORE_STUB_MODE="${RESTORE_STUB_MODE:-success}" \
    OPS_PROJECT_DIR="${SANDBOX}" \
    OPS_RESTORE_SCRIPT="${SANDBOX}/bin/restore-stub" \
    OPS_SLEEP_SECONDS=0 \
    bash "${REPO_ROOT}/scripts/ops/rollback.sh" "${sha}" "${mode}" > /tmp/rb-out.$$ 2>&1
  local rc=$?
  [[ -f "${SANDBOX}/calls.log" ]] && CALL_LOG="$(cat "${SANDBOX}/calls.log")"
  return "${rc}"
}

# docker stub 的 image inspect 只接受该 tag；rollback 的 authoritative SHA 即它
PREV_SHA="EXPECTED_PREV_SHA"
EXTRA_ENV=()

echo "== 1. safe rollback 不碰 DB =="
RESTORE_STUB_MODE=success make_sandbox
run_rollback "${PREV_SHA}"; rc=$?
assert_exit 0 "$rc" "safe rollback"
assert_log_contains "app_up_called"
assert_log_not_contains "restore_called"
assert_log_not_contains "app_stop_called"

echo "== 1b. safe rollback 最终选择 EXACT PREVIOUS_SHA（先 resolve 断言再 up）=="
assert_log_contains "app_up_called GIT_SHA=EXPECTED_PREV_SHA"
assert_log_contains "config --images"
config_line="$(printf '%s' "$CALL_LOG" | grep -n "config --images" | head -1 | cut -d: -f1)"
up_line="$(printf '%s' "$CALL_LOG" | grep -n "app_up_called" | head -1 | cut -d: -f1)"
if [[ -n "$config_line" && -n "$up_line" && "$config_line" -lt "$up_line" ]]; then
  pass_test
else
  fail_test "config --images 必须先于 up 执行（resolved-image assert 前置）"
fi

echo "== 1c. shell 中残留错误 GIT_SHA 时，rollback 参数必须 authoritative =="
RESTORE_STUB_MODE=success make_sandbox
EXTRA_ENV=(GIT_SHA=WRONG_SHA_IN_SHELL)
run_rollback "${PREV_SHA}"; rc=$?
EXTRA_ENV=()
assert_exit 0 "$rc" "safe rollback with poisoned GIT_SHA"
assert_log_contains "app_up_called GIT_SHA=EXPECTED_PREV_SHA"
assert_log_not_contains "GIT_SHA=WRONG_SHA_IN_SHELL"

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

echo "== 3. hard restore 成功 → app 回滚才执行，且选择 EXACT PREVIOUS_SHA =="
run_rollback "${PREV_SHA}" --hard; rc=$?
assert_exit 0 "$rc" "hard rollback with restore success"
assert_log_contains "restore_called"
assert_log_contains "app_up_called GIT_SHA=EXPECTED_PREV_SHA"
assert_log_contains "config --images"

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

echo "== 8. resolved app image != PREVIOUS_SHA → 在切换应用前 fail =="
RESTORE_STUB_MODE=success make_sandbox
EXTRA_ENV=(CONFIG_STUB_MODE=broken)
run_rollback "${PREV_SHA}"; rc=$?
EXTRA_ENV=()
assert_exit 1 "$rc" "resolved image mismatch must abort rollback"
assert_log_contains "config --images"
assert_log_not_contains "app_up_called"

echo "== 9. health release != PREVIOUS_SHA → fail（release 必须等于回滚目标）=="
RESTORE_STUB_MODE=success make_sandbox
EXTRA_ENV=(CURL_STUB_RELEASE=WRONG_RELEASE_SHA)
run_rollback "${PREV_SHA}"; rc=$?
EXTRA_ENV=()
assert_exit 1 "$rc" "health release mismatch must fail rollback"
assert_log_contains "app_up_called"

echo "== 10. optional_env_var：retention 遵守统一 env contract =="
make_sandbox
source_lib="${REPO_ROOT}/scripts/ops/lib.sh"
sed -i 's/^BACKUP_RETENTION_DAYS=.*/BACKUP_RETENTION_DAYS=30/' "${SANDBOX}/.env.production"
# shell unset + env file 30 → 30
if OPS_PROJECT_DIR="${SANDBOX}" bash -c "
  source '${source_lib}' && load_production_env &&
  v=\"\$(optional_env_var BACKUP_RETENTION_DAYS 14)\" &&
  [[ \"\$v\" == \"30\" ]]"; then pass_test; else fail_test "retention: env file 30 应生效"; fi
# shell explicit 7 → 7（shell 优先）
if OPS_PROJECT_DIR="${SANDBOX}" BACKUP_RETENTION_DAYS=7 bash -c "
  source '${source_lib}' && load_production_env &&
  v=\"\$(optional_env_var BACKUP_RETENTION_DAYS 14)\" &&
  [[ \"\$v\" == \"7\" ]]"; then pass_test; else fail_test "retention: shell 显式 7 应优先"; fi
# 完全未配置 → 14
sed -i '/^BACKUP_RETENTION_DAYS=/d' "${SANDBOX}/.env.production"
if OPS_PROJECT_DIR="${SANDBOX}" bash -c "
  source '${source_lib}' && load_production_env &&
  v=\"\$(optional_env_var BACKUP_RETENTION_DAYS 14)\" &&
  [[ \"\$v\" == \"14\" ]]"; then pass_test; else fail_test "retention: 未配置应默认 14"; fi

# 清理沙箱
rm -rf "${SANDBOX}" /tmp/rb-out.$$ /tmp/rb-hard-fail.$$ /tmp/rp-sha.$$ /tmp/rp-noflag.$$ /tmp/rp-mismatch.$$ 2>/dev/null

echo "=============================="
echo "PASS=${PASS} FAIL=${FAIL}"
if [[ "${FAIL}" != "0" ]]; then exit 1; fi
exit 0
