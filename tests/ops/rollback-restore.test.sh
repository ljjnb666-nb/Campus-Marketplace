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
assert_contains_file() {
  if grep -qF "$1" "$2" 2>/dev/null; then pass_test; else fail_test "$3: 文件缺少 $1"; fi
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

  # ---- docker stub（有状态）----
  # 用 ${SANDBOX}/running.state 模拟 compose 服务运行状态：
  #   stop <svc>    → 从 state 移除（STOP_FAILURE_STUB_MODE=storage-cleanup
  #                   时不移除，验证 restore 的 FAIL CLOSED）
  #   up -d <svc>   → 加入 state（UP_FAILURE_STUB_MODE=<svc> 时 exit 1）
  #   ps -q <svc>   → state 含该服务则输出 container-id（容器存在）
  #   ps --status running --services → 输出 state（running 服务清单）
  # config --images 按 $GIT_SHA 模拟 compose 插值：GIT_SHA 未设置/为空 → :local
  # （与 compose.production.yml 的 ${GIT_SHA:-local} 行为一致），以此捕捉
  # "rollback 未显式传递 GIT_SHA" 的 bug；CONFIG_STUB_MODE=broken 强制输出
  # 错误镜像，验证 resolved-image assert 会阻断回滚。
  # image inspect：app tag 仅接受 PREV_SHA（0f1e...）；cleanup tag 依
  # CLEANUP_STUB_MODE（默认 post-worker=存在；pre-worker=不存在）。
  cat > "${SANDBOX}/bin/docker" <<STUB
#!/usr/bin/env bash
ARGS="\$*"
echo "docker called:\$ARGS" >> "${SANDBOX}/calls.log"
STATE="${SANDBOX}/running.state"
state_has() { grep -qx "\$1" "\$STATE" 2>/dev/null; }
state_add() { state_has "\$1" || printf '%s\n' "\$1" >> "\$STATE"; }
state_remove() { grep -vx "\$1" "\$STATE" 2>/dev/null > "\${STATE}.tmp" || true; mv "\${STATE}.tmp" "\$STATE" 2>/dev/null || : > "\$STATE"; }
case "\$ARGS" in
  *"image inspect"*)
    if [[ "\$ARGS" == *"campus-marketplace-app:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"* ]]; then
      exit 0
    elif [[ "\$ARGS" == *"campus-marketplace-cleanup:"* ]]; then
      [[ "\${CLEANUP_STUB_MODE:-post-worker}" == "pre-worker" ]] && exit 1 || exit 0
    else
      exit 1
    fi ;;
  *"config --images"*)
    if [[ -n "\${CONFIG_STUB_MODE:-}" && "\${CONFIG_STUB_MODE}" == "broken" ]]; then
      echo "caddy:2-alpine"; echo "campus-marketplace-app:local"; echo "postgres:16-alpine"
    elif [[ -n "\${GIT_SHA:-}" ]]; then
      echo "caddy:2-alpine"; echo "campus-marketplace-app:\${GIT_SHA}"; echo "campus-marketplace-cleanup:\${GIT_SHA}"; echo "campus-marketplace-migrator:\${GIT_SHA}"; echo "postgres:16-alpine"; echo "redis:7-alpine"
    else
      echo "caddy:2-alpine"; echo "campus-marketplace-app:local"; echo "postgres:16-alpine"
    fi
    exit 0 ;;
  *"compose"*"stop app"*)
    echo "app_stop_called" >> "${SANDBOX}/calls.log"; state_remove app; exit 0 ;;
  *"compose"*"stop storage-cleanup"*)
    echo "cleanup_stop_called" >> "${SANDBOX}/calls.log"
    [[ "\${STOP_FAILURE_STUB_MODE:-}" == "storage-cleanup" ]] || state_remove storage-cleanup
    exit 0 ;;
  *"compose"*"ps -q app"*)
    state_has app && echo "container-id" ; exit 0 ;;
  *"compose"*"ps -q storage-cleanup"*)
    state_has storage-cleanup && echo "container-id" ; exit 0 ;;
  *"compose"*"ps --status running --services"*)
    cat "\$STATE" 2>/dev/null; exit 0 ;;
  *"compose"*"up -d"*"storage-cleanup"*)
    echo "cleanup_up_called GIT_SHA=\${GIT_SHA:-<unset>} ARGS=\$ARGS" >> "${SANDBOX}/calls.log"
    if [[ "\${UP_FAILURE_STUB_MODE:-}" == "storage-cleanup" ]]; then exit 1; fi
    state_add storage-cleanup; exit 0 ;;
  *"compose"*"up -d"*)
    echo "app_up_called GIT_SHA=\${GIT_SHA:-<unset>} ARGS=\$ARGS" >> "${SANDBOX}/calls.log"
    if [[ "\${UP_FAILURE_STUB_MODE:-}" == "app" ]]; then exit 1; fi
    state_add app; exit 0 ;;
  *"compose"*"exec -T postgres psql"*)
    echo "psql_called:\$ARGS" >> "${SANDBOX}/calls.log"
    # 完整性检查的 -tAc COUNT 查询（SQL 在参数中）：migrations 计数 > 0，
    # 其余（核心表/孤儿引用）返回 0
    if [[ "\$ARGS" == *"_prisma_migrations"* ]]; then
      echo "3"
    elif [[ "\$ARGS" == *"COUNT(*)"* ]]; then
      echo "0"
    fi
    exit 0 ;;
  *"compose"*"exec -T postgres pg_dump"*)
    echo "pg_dump_called" >> "${SANDBOX}/calls.log"; echo "DUMMYDUMP"; exit 0 ;;
  *"compose"*"exec -T postgres pg_restore"*)
    echo "pg_restore_called" >> "${SANDBOX}/calls.log"; exit 0 ;;
  *) echo "[docker-stub] unhandled: \$ARGS" >> "${SANDBOX}/calls.log"; exit 0 ;;
esac
STUB
  chmod +x "${SANDBOX}/bin/docker"
  # 初始运行状态：默认 app + storage-cleanup 均在运行（post-worker release）；
  # DOCKER_STUB_INITIAL="app" 模拟 pre-worker release（cleanup 容器不存在）
  # shellcheck disable=SC2126
  printf '%s\n' ${DOCKER_STUB_INITIAL:-app storage-cleanup} > "${SANDBOX}/running.state"

  # ---- curl stub（health 返回的 release 可配置）----
  cat > "${SANDBOX}/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "{\"status\":\"ok\",\"release\":\"${CURL_STUB_RELEASE:-0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c}\",\"timestamp\":\"2026-01-01T00:00:00Z\"}"
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

  # ---- npx stub：透传真实 tsx（release gate 一律走真实 release-readiness-check.ts；
  #      RB-06 FINAL-02：不再存在 OPS_RELEASE_VERIFIER 类 stub verifier seam）----
  # Windows（Git Bash）下 node 不能解析 POSIX 路径，需要 cygpath -m 转换
  if command -v cygpath >/dev/null 2>&1; then
    REAL_TSX="$(cygpath -m "${REPO_ROOT}/node_modules/tsx/dist/cli.mjs")"
  else
    REAL_TSX="${REPO_ROOT}/node_modules/tsx/dist/cli.mjs"
  fi
  cat > "${SANDBOX}/bin/npx" <<STUB
#!/usr/bin/env bash
REAL_TSX="${REAL_TSX}"
args=()
skip_next=0
for a in "\$@"; do
  if [[ "\$skip_next" == "1" ]]; then skip_next=0; continue; fi
  if [[ "\$a" == "--prefix" ]]; then skip_next=1; continue; fi
  if [[ "\$a" == "tsx" ]]; then continue; fi
  args+=("\$a")
done
exec node "\${REAL_TSX}" "\${args[@]}"
STUB
  chmod +x "${SANDBOX}/bin/npx"
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
  rm -f "${SANDBOX}/calls.log" "${SANDBOX}/.releases.log"
  # 一律经 env 命令注入环境：展开形式的 VAR=v 不能作为 assignment 前缀
  env "${EXTRA_ENV[@]}" PATH="${SANDBOX}/bin:${PATH}" \
    RESTORE_STUB_MODE="${RESTORE_STUB_MODE:-success}" \
    OPS_PROJECT_DIR="${SANDBOX}" \
    OPS_RESTORE_SCRIPT="${SANDBOX}/bin/restore-stub" \
    OPS_SLEEP_SECONDS=0 \
    OPS_HEALTH_TIMEOUT="${OPS_HEALTH_TIMEOUT-120}" \
    APP_URL="${TEST_APP_URL:-}" \
    bash "${REPO_ROOT}/scripts/ops/rollback.sh" "${sha}" "${mode}" > /tmp/rb-out.$$ 2>&1
  local rc=$?
  [[ -f "${SANDBOX}/calls.log" ]] && CALL_LOG="$(cat "${SANDBOX}/calls.log")"
  return "${rc}"
}

# 启动 fake app（node one-liner；端口经 stdout 写入 bash 管理的文件，避免 MSYS 路径转换问题）
# $1=release $2=ready 模式 $3=输出文件（内容 PORT=<port>）
start_fake_app() {
  node -e '
    const http = require("node:http");
    const [sha, mode] = process.argv.slice(1);
    const server = http.createServer((req, res) => {
      if (!req.url || !req.url.endsWith("/api/ready")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", release: sha, timestamp: "2026-01-01T00:00:00Z" }));
        return;
      }
      if (mode === "ready") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ready", release: sha, dependencies: { database: "ok", redis: "ok", storage: "ok" } }));
      } else if (mode === "degraded") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "degraded", release: sha, dependencies: { database: "ok", redis: "degraded", storage: "ok" } }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ready", release: sha, dependencies: { database: "ok", redis: "ok", storage: "ok" } }));
      }
    });
    server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));
  ' "$1" "$2" > "$3" 2>&1 &
  FAKE_APP_PID=$!
  for _ in $(seq 1 50); do
    grep -q "^PORT=" "$3" 2>/dev/null && return 0
    sleep 0.1
  done
  echo "fake app 未在预期时间内启动" >&2
  return 1
}

fake_port() {
  grep "^PORT=" "$1" | head -1 | cut -d= -f2
}

# docker stub 的 image inspect 只接受该 tag；rollback 的 authoritative SHA 即它
PREV_SHA="0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
# 与 PREV_SHA 不同的合法 40-hex（release mismatch 用例的 fake app 自报值）
OTHER_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EXTRA_ENV=()

echo "== 1. safe rollback 不碰 DB（真实 release gate × fake app 全绿）=="
RESTORE_STUB_MODE=success make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 0 "$rc" "safe rollback"
assert_log_contains "app_up_called"
assert_log_not_contains "restore_called"
assert_log_not_contains "app_stop_called"

echo "== 1b. safe rollback 最终选择 EXACT PREVIOUS_SHA（先 resolve 断言再 up）=="
assert_log_contains "app_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
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
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
EXTRA_ENV=(GIT_SHA=WRONG_SHA_IN_SHELL)
run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
EXTRA_ENV=()
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 0 "$rc" "safe rollback with poisoned GIT_SHA"
assert_log_contains "app_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
assert_log_not_contains "GIT_SHA=WRONG_SHA_IN_SHELL"

echo "== 2. hard restore 失败 → app 回滚不执行 =="
printf 'DUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
echo "deadbeef  db-20260101.dump" > "${SANDBOX}/backups/db-20260101.dump.sha256"
CALL_LOG=""; rm -f "${SANDBOX}/calls.log"
RESTORE_STUB_MODE=failure \
OPS_PROJECT_DIR="${SANDBOX}" OPS_RESTORE_SCRIPT="${SANDBOX}/bin/restore-stub" OPS_SLEEP_SECONDS=0 \
PATH="${SANDBOX}/bin:${PATH}" \
bash "${REPO_ROOT}/scripts/ops/rollback.sh" 0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c --hard >/tmp/rb-hard-fail.$$ 2>&1; rc=$?
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_exit 1 "$rc" "hard rollback with restore failure"
assert_log_contains "restore_called"
assert_log_not_contains "app_up_called"
assert_log_not_contains "cleanup_up_called"

echo "== 3. hard restore 成功 → app 回滚才执行，且选择 EXACT PREVIOUS_SHA（真实 gate 全绿）=="
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
run_rollback "${PREV_SHA}" --hard; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 0 "$rc" "hard rollback with restore success"
assert_log_contains "restore_called"
assert_log_contains "app_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
assert_log_contains "config --images"
# post-worker 目标：cleanup 必须与 app 同 SHA 成对切换
assert_log_contains "cleanup_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"

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

echo "== 5b. restore 成功 → 顺序 = stop app → stop cleanup → 验证停止 → terminate → DROP/restore =="
make_sandbox
printf 'REALDUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
echo "$(sha256sum "${SANDBOX}/backups/db-20260101.dump" | awk '{print $1}')  db-20260101.dump" > "${SANDBOX}/backups/db-20260101.dump.sha256"
OPS_PROJECT_DIR="${SANDBOX}" OPS_SLEEP_SECONDS=0 PATH="${SANDBOX}/bin:${PATH}" \
  bash "${REPO_ROOT}/scripts/ops/restore-production-postgres.sh" \
    --production-restore --backup-file "${SANDBOX}/backups/db-20260101.dump" \
    --target-db campus_marketplace >/tmp/rp-ok.$$ 2>&1; rc=$?
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_exit 0 "$rc" "restore success"
assert_log_contains "app_stop_called"
assert_log_contains "cleanup_stop_called"
assert_log_contains "pg_restore_called"
# 顺序硬门禁：两个 writer 的停止标记都必须先于第一次 psql（terminate connections）
stop_app_line="$(printf '%s' "$CALL_LOG" | grep -n "app_stop_called" | head -1 | cut -d: -f1)"
stop_cleanup_line="$(printf '%s' "$CALL_LOG" | grep -n "cleanup_stop_called" | head -1 | cut -d: -f1)"
first_psql_line="$(printf '%s' "$CALL_LOG" | grep -n "psql_called" | head -1 | cut -d: -f1)"
if [[ -n "$stop_app_line" && -n "$stop_cleanup_line" && -n "$first_psql_line" \
      && "$stop_app_line" -lt "$first_psql_line" && "$stop_cleanup_line" -lt "$first_psql_line" ]]; then
  pass_test
else
  fail_test "必须在 terminate DB connections 之前停止 app 与 storage-cleanup"
fi

echo "== 5c. storage-cleanup 无法停止 → FAIL CLOSED：不 terminate、不 DROP/restore =="
make_sandbox
printf 'REALDUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
echo "$(sha256sum "${SANDBOX}/backups/db-20260101.dump" | awk '{print $1}')  db-20260101.dump" > "${SANDBOX}/backups/db-20260101.dump.sha256"
OPS_PROJECT_DIR="${SANDBOX}" OPS_SLEEP_SECONDS=0 PATH="${SANDBOX}/bin:${PATH}" \
  STOP_FAILURE_STUB_MODE=storage-cleanup \
  bash "${REPO_ROOT}/scripts/ops/restore-production-postgres.sh" \
    --production-restore --backup-file "${SANDBOX}/backups/db-20260101.dump" \
    --target-db campus_marketplace >/tmp/rp-stopfail.$$ 2>&1; rc=$?
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_exit 1 "$rc" "cleanup cannot stop must fail closed"
assert_log_contains "app_stop_called"
assert_log_contains "cleanup_stop_called"
assert_log_not_contains "psql_called"
assert_log_not_contains "pg_restore_called"

echo "== 5d. pre-worker release（cleanup 容器不存在）→ restore 仍成功 =="
DOCKER_STUB_INITIAL="app" make_sandbox
printf 'REALDUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
echo "$(sha256sum "${SANDBOX}/backups/db-20260101.dump" | awk '{print $1}')  db-20260101.dump" > "${SANDBOX}/backups/db-20260101.dump.sha256"
OPS_PROJECT_DIR="${SANDBOX}" OPS_SLEEP_SECONDS=0 PATH="${SANDBOX}/bin:${PATH}" \
  DOCKER_STUB_INITIAL="app" \
  bash "${REPO_ROOT}/scripts/ops/restore-production-postgres.sh" \
    --production-restore --backup-file "${SANDBOX}/backups/db-20260101.dump" \
    --target-db campus_marketplace >/tmp/rp-preworker.$$ 2>&1; rc=$?
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_exit 0 "$rc" "restore with pre-worker topology"
assert_log_contains "app_stop_called"
assert_log_not_contains "cleanup_stop_called"
assert_log_contains "pg_restore_called"

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

echo "== 9. PREVIOUS_SHA 非法（短 SHA）→ INVALID_EXPECTED_SHA，零 side effect =="
RESTORE_STUB_MODE=success make_sandbox
CALL_LOG=""; rm -f "${SANDBOX}/calls.log" "${SANDBOX}/.releases.log"
OPS_PROJECT_DIR="${SANDBOX}" OPS_RESTORE_SCRIPT="${SANDBOX}/bin/restore-stub" \
  OPS_SLEEP_SECONDS=0 PATH="${SANDBOX}/bin:${PATH}" \
  bash "${REPO_ROOT}/scripts/ops/rollback.sh" "abc123" >/tmp/rb-invalid.$$ 2>&1; rc=$?
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_exit 1 "$rc" "invalid PREVIOUS_SHA must fail rollback"
if grep -q "INVALID_EXPECTED_SHA" /tmp/rb-invalid.$$; then pass_test; else fail_test "缺少 INVALID_EXPECTED_SHA 原因"; fi
assert_log_not_contains "restore_called"
assert_log_not_contains "app_up_called"
if [[ -e "${SANDBOX}/.releases.log" ]]; then
  fail_test "invalid SHA 不得写 .releases.log"
else
  pass_test
fi

echo "== 9b. release gate（真实 verifier × fake app 全绿，大写 SHA 正常化）→ 成功日志含 READINESS=ready =="
RESTORE_STUB_MODE=success make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
UPPER_PREV_SHA="$(printf '%s' "${PREV_SHA}" | tr 'a-f' 'A-F')"
OPS_HEALTH_TIMEOUT=15 run_rollback "${UPPER_PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 0 "$rc" "real verifier pass rollback"
assert_contains_file "ROLLBACK RELEASE_SHA=${PREV_SHA}" "${SANDBOX}/.releases.log" "rollback 成功日志"
assert_contains_file "READINESS=ready" "${SANDBOX}/.releases.log" "rollback 成功日志 readiness"

echo "== 9c. release gate（真实 verifier）：ready.release != PREVIOUS_SHA → fail =="
RESTORE_STUB_MODE=success make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${OTHER_SHA}" wrong-release "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
OPS_HEALTH_TIMEOUT=8 run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 1 "$rc" "real verifier release mismatch must fail rollback"
assert_log_contains "app_up_called"
if [[ -e "${SANDBOX}/.releases.log" ]]; then
  fail_test "release mismatch 后不得写 .releases.log"
else
  pass_test
fi

echo "== 9d. release gate（真实 verifier）：health+ready 全绿（exact PREVIOUS_SHA）→ SUCCESS =="
RESTORE_STUB_MODE=success make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
OPS_HEALTH_TIMEOUT=15 run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 0 "$rc" "real verifier all-green rollback"
assert_contains_file "ROLLBACK RELEASE_SHA=${PREV_SHA}" "${SANDBOX}/.releases.log" "real verifier 通过后写成功日志"

echo "== 9e. release gate（真实 verifier）：ready degraded（HTTP 200）→ fail（HTTP 200 ≠ ROLLBACK SUCCESS）=="
RESTORE_STUB_MODE=success make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" degraded "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
OPS_HEALTH_TIMEOUT=8 run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 1 "$rc" "real verifier degraded must fail rollback"
if [[ -e "${SANDBOX}/.releases.log" ]]; then
  fail_test "degraded 后不得写 .releases.log"
else
  pass_test
fi

echo "== 9f. post-worker rollback：cleanup 与 app 成对切换到 EXACT PREVIOUS_SHA + 日志记录 =="
RESTORE_STUB_MODE=success make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 0 "$rc" "post-worker rollback"
assert_log_contains "app_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
assert_log_contains "cleanup_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
assert_contains_file "CLEANUP_IMAGE=campus-marketplace-cleanup:${PREV_SHA}" "${SANDBOX}/.releases.log" "rollback 日志 cleanup image"
assert_contains_file "CLEANUP=running" "${SANDBOX}/.releases.log" "rollback 日志 cleanup 状态"

echo "== 9g. pre-worker 目标（cleanup 镜像不存在）→ 停止 cleanup 而非失败 =="
RESTORE_STUB_MODE=success make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
CLEANUP_STUB_MODE=pre-worker run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 0 "$rc" "pre-worker target rollback"
assert_log_contains "app_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
assert_log_contains "cleanup_stop_called"
assert_log_not_contains "cleanup_up_called"
assert_contains_file "CLEANUP=stopped_pre_worker_release" "${SANDBOX}/.releases.log" "pre-worker rollback 日志"
if grep -qF "CLEANUP_IMAGE" "${SANDBOX}/.releases.log" 2>/dev/null; then
  fail_test "pre-worker rollback 日志不应记录 CLEANUP_IMAGE（目标无该 artifact）"
else
  pass_test
fi

echo "== 9h. cleanup 切换失败 → ROLLBACK FAIL，不写 release log =="
RESTORE_STUB_MODE=success make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
UP_FAILURE_STUB_MODE=storage-cleanup run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 1 "$rc" "cleanup switch failure must fail rollback"
assert_log_contains "app_up_called"
# 切换尝试已发生（被 stub 以 exit 1 拒绝），rollback 必须整体失败
assert_log_contains "cleanup_up_called"
if [[ -e "${SANDBOX}/.releases.log" ]]; then
  fail_test "cleanup 切换失败后不得写 .releases.log"
else
  pass_test
fi

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
rm -rf "${SANDBOX}" /tmp/rb-out.$$ /tmp/rb-hard-fail.$$ /tmp/rb-invalid.$$ /tmp/rp-sha.$$ /tmp/rp-noflag.$$ /tmp/rp-mismatch.$$ 2>/dev/null

echo "=============================="
echo "PASS=${PASS} FAIL=${FAIL}"
if [[ "${FAIL}" != "0" ]]; then exit 1; fi
exit 0
