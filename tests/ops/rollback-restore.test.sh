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

# Issue #97: 仅打印固定布尔量/退出码，避免失败时将脚本原始输出、
# env、URL 或 Docker 参数直接带入 CI 日志。此处只是诊断，不能放宽 fail-closed。
LAST_ROLLBACK_RC="unknown"
safe_rollback_failure_evidence() {
  local rc="$1" calls="$2" out_file="$3"
  local inspect=0 config=0 app_up=0 resolved_app=0 image_mismatch=0 config_failure=0
  [[ "$calls" == *"image inspect"* ]] && inspect=1
  [[ "$calls" == *"config --images"* ]] && config=1
  [[ "$calls" == *"app_up_called"* ]] && app_up=1
  if [[ -f "$out_file" ]]; then
    grep -qF '[rollback] resolved app image =' "$out_file" && resolved_app=1
    grep -qF '[rollback][FAIL] 解析后的 app 镜像不是' "$out_file" && image_mismatch=1
    grep -qF '[rollback][FAIL] compose config --images 解析失败' "$out_file" && config_failure=1
  fi
  printf 'RB_DIAG exit=%s image_inspect=%s config_images=%s app_up=%s resolved_app=%s image_mismatch=%s config_failure=%s\n' \
    "$rc" "$inspect" "$config" "$app_up" "$resolved_app" "$image_mismatch" "$config_failure" >&2
}

assert_log_contains() {
  if grep -qF -- "$1" <<< "$CALL_LOG"; then
    pass_test
  elif [[ "$1" == app_up_called* ]]; then
    fail_test "rollback app_up 调用缺失（详见 RB_DIAG 固定阶段标志）"
    safe_rollback_failure_evidence "$LAST_ROLLBACK_RC" "$CALL_LOG" "/tmp/rb-out.$$"
  else
    # 通用缺失断言只输出固定阶段标志，不回显 calls.log 中的凭据/URL/参数。
    fail_test "log 缺少指定阶段标志（详见 RB_DIAG 固定阶段标志）"
    safe_rollback_failure_evidence "$LAST_ROLLBACK_RC" "$CALL_LOG" "/tmp/rb-out.$$"
  fi
}
assert_log_not_contains() {
  if grep -qF -- "$1" <<< "$CALL_LOG"; then fail_test "log 不应包含: $1"; else pass_test; fi
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
      [[ "\${CLEANUP_STUB_MODE:-post-worker}" == "pre-worker" || "\${CLEANUP_STUB_MODE:-post-worker}" == "missing-image" ]] && exit 1 || exit 0
    elif [[ "\$ARGS" == *"campus-marketplace-async-worker:"* ]]; then
      [[ "\${ASYNC_STUB_MODE:-post-async}" == "pre-async" || "\${ASYNC_STUB_MODE:-post-async}" == "missing-image" ]] && exit 1 || exit 0
    else
      exit 1
    fi ;;
  *"config --images"*)
    if [[ -n "\${CONFIG_STUB_MODE:-}" && "\${CONFIG_STUB_MODE}" == "broken" ]]; then
      echo "caddy:2-alpine"; echo "campus-marketplace-app:local"; echo "postgres:16-alpine"
    elif [[ -n "\${GIT_SHA:-}" ]]; then
      echo "caddy:2-alpine"; echo "campus-marketplace-app:\${GIT_SHA}"; echo "campus-marketplace-cleanup:\${GIT_SHA}"; echo "campus-marketplace-async-worker:\${GIT_SHA}"; echo "campus-marketplace-migrator:\${GIT_SHA}"; echo "postgres:16-alpine"; echo "redis:7-alpine"
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
  *"compose"*"stop async-worker"*)
    echo "async_stop_called" >> "${SANDBOX}/calls.log"
    [[ "\${STOP_FAILURE_STUB_MODE:-}" == "async-worker" ]] || state_remove async-worker
    exit 0 ;;
  *"compose"*"ps -q app"*)
    [[ "\${PS_FAILURE_STUB_MODE:-}" == "query" ]] && exit 1
    state_has app && echo "container-id" ; exit 0 ;;
  *"compose"*"ps -q storage-cleanup"*)
    [[ "\${PS_FAILURE_STUB_MODE:-}" == "query" ]] && exit 1
    state_has storage-cleanup && echo "container-id" ; exit 0 ;;
  *"compose"*"ps -q async-worker"*)
    [[ "\${PS_FAILURE_STUB_MODE:-}" == "query" ]] && exit 1
    state_has async-worker && echo "container-id" ; exit 0 ;;
  *"compose"*"ps --format json storage-cleanup"*)
    if [[ -n "\${WORKER_RUNNING_WRONG_IMAGE:-}" ]]; then
      echo "{\"Service\":\"storage-cleanup\",\"Image\":\"campus-marketplace-cleanup:local\",\"State\":\"running\"}"
    elif [[ -n "\${GIT_SHA:-}" ]]; then
      echo "{\"Service\":\"storage-cleanup\",\"Image\":\"campus-marketplace-cleanup:\${GIT_SHA}\",\"State\":\"running\"}"
    else
      echo "{\"Service\":\"storage-cleanup\",\"Image\":\"campus-marketplace-cleanup:local\",\"State\":\"running\"}"
    fi
    exit 0 ;;
  *"compose"*"ps --format json async-worker"*)
    if [[ -n "\${ASYNC_RUNNING_WRONG_IMAGE:-}" ]]; then
      echo "{\\"Service\\":\\"async-worker\\",\\"Image\\":\\"campus-marketplace-async-worker:local\\",\\"State\\":\\"running\\"}"
    elif [[ -n "\${GIT_SHA:-}" ]]; then
      echo "{\\"Service\\":\\"async-worker\\",\\"Image\\":\\"campus-marketplace-async-worker:\${GIT_SHA}\\",\\"State\\":\\"running\\"}"
    else
      echo "{\\"Service\\":\\"async-worker\\",\\"Image\\":\\"campus-marketplace-async-worker:local\\",\\"State\\":\\"running\\"}"
    fi
    exit 0 ;;
  *"compose"*"ps --status running --services"*)
    [[ "\${PS_FAILURE_STUB_MODE:-}" == "verify" ]] && exit 1
    # 故障定点注入：async-worker 预停检查已通过、cleanup 停止后，
    # 仅在 cleanup 的二次运行态验证时使 ps 命令失败。不能让前置
    # async pre-stop gate 截断原本要测试的 cleanup 分支。
    if [[ "\${PS_FAILURE_STUB_MODE:-}" == "verify-cleanup" ]] && ! state_has storage-cleanup; then
      exit 1
    fi
    cat "\$STATE" 2>/dev/null; exit 0 ;;
  *"compose"*"up -d"*"async-worker"*)
    echo "async_up_called GIT_SHA=\${GIT_SHA:-<unset>} ARGS=\$ARGS" >> "${SANDBOX}/calls.log"
    if [[ "\${UP_FAILURE_STUB_MODE:-}" == "async-worker" ]]; then exit 1; fi
    state_add async-worker; exit 0 ;;
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
    # Capture the new post-restore SQL transaction, not merely a filename check.
    # The only -X invocation is the mandatory security invalidation gate.
    if [[ "\$ARGS" == *"psql -X"* ]]; then
      security_sql="\$(cat)"
      if [[ "\$security_sql" == *"RECOVERY_ACCOUNT_SESSION_SCHEMA_MISSING"* &&
            "\$security_sql" == *"RECOVERY_CREDENTIAL_HOLD_SCHEMA_MISSING"* &&
            "\$security_sql" == *'UPDATE "User"'* &&
            "\$security_sql" == *"RECOVERY_CHALLENGE_INVALIDATION_INCOMPLETE"* &&
            "\$security_sql" == *'UPDATE "AccountSession"'* &&
            "\$security_sql" == *'UPDATE "AccountChallenge"'* ]]; then
        echo "security_invalidate_called" >> "${SANDBOX}/calls.log"
      else
        echo "security_invalidation_sql_invalid" >> "${SANDBOX}/calls.log"
        exit 1
      fi
      if [[ "\${RECOVERY_SECURITY_STUB_MODE:-}" == "fail" ]]; then exit 1; fi
    fi
    exit 0 ;;
  *"compose"*"exec -T postgres pg_dump"*)
    echo "pg_dump_called" >> "${SANDBOX}/calls.log"; echo "DUMMYDUMP"; exit 0 ;;
  *"compose"*"exec -T postgres pg_restore"*)
    echo "pg_restore_called" >> "${SANDBOX}/calls.log"; exit 0 ;;
  *) echo "[docker-stub] unhandled: \$ARGS" >> "${SANDBOX}/calls.log"; exit 0 ;;
esac
STUB
  # 目标 release 的 Git topology 只读 stub。默认 post-async；
  # pre-async 时该历史 commit 不含 worker entrypoint。不能把本地
  # image 被 prune 的情况误认成历史 release 不存在此服务。
  cat > "${SANDBOX}/bin/git" <<'GIT_STUB'
#!/usr/bin/env bash
if [[ "$*" == *"cat-file -p"* ]]; then
  # Target-commit restore credential contract. Legacy release must refuse
  # hard restore BEFORE any production database or writer mutation.
  if [[ "${RECOVERY_HOLD_STUB_MODE:-compatible}" == "legacy" ]]; then exit 1; fi
  echo 'credentialRecoveryRequired'
  exit 0
fi
if [[ "$*" != *"cat-file -e"* ]]; then exit 1; fi
if [[ "$*" == *"scripts/ops/async-worker.ts"* && "${ASYNC_STUB_MODE:-post-async}" == "pre-async" ]]; then exit 1; fi
if [[ "$*" == *"scripts/ops/storage-cleanup-worker.ts"* && "${CLEANUP_STUB_MODE:-post-worker}" == "pre-worker" ]]; then exit 1; fi
exit 0
GIT_STUB
  chmod +x "${SANDBOX}/bin/git"
  chmod +x "${SANDBOX}/bin/docker"
  # 初始运行状态：默认 app + storage-cleanup 均在运行（post-worker release）；
  # DOCKER_STUB_INITIAL="app" 模拟 pre-worker release（cleanup 容器不存在）
  # shellcheck disable=SC2126
  printf '%s\n' ${DOCKER_STUB_INITIAL:-app storage-cleanup async-worker} > "${SANDBOX}/running.state"

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
  LAST_ROLLBACK_RC="$rc"
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
  # 20s 启动预算：全量套件并行时 node 启动可能被调度延迟（5s 预算实测抖动）
  for _ in $(seq 1 100); do
    grep -q "^PORT=" "$3" 2>/dev/null && return 0
    sleep 0.2
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

# Issue #97: validate both assertions in every synthetic large-log scenario.
echo "== 0. pipefail 长日志位置矩阵 =="
PIPEFAIL_ASSERT_RESULT="$(
  BULK_LOG="$(printf '%262144s' '' | tr ' ' 'X')"
  MARKER="app_up_called GIT_SHA=${PREV_SHA}"
  MATRIX_CASES=0 MATRIX_ERRORS=0
  for position in first middle last absent; do
    for iteration in 1 2 3 4 5 6 7 8; do
      case "$position" in
        first) CALL_LOG="${MARKER}${BULK_LOG}" ;;
        middle) CALL_LOG="${BULK_LOG:0:131072}${MARKER}${BULK_LOG:131072}" ;;
        last) CALL_LOG="${BULK_LOG}${MARKER}" ;;
        absent) CALL_LOG="${BULK_LOG}" ;;
      esac
      PASS=0 FAIL=0
      assert_log_contains "$MARKER" >/dev/null 2>&1
      if [[ "$position" == absent ]]; then
        [[ "$PASS" == 0 && "$FAIL" == 1 ]] || MATRIX_ERRORS=$((MATRIX_ERRORS + 1))
      else
        [[ "$PASS" == 1 && "$FAIL" == 0 ]] || MATRIX_ERRORS=$((MATRIX_ERRORS + 1))
      fi
      PASS=0 FAIL=0
      assert_log_not_contains "$MARKER" >/dev/null 2>&1
      if [[ "$position" == absent ]]; then
        [[ "$PASS" == 1 && "$FAIL" == 0 ]] || MATRIX_ERRORS=$((MATRIX_ERRORS + 1))
      else
        [[ "$PASS" == 0 && "$FAIL" == 1 ]] || MATRIX_ERRORS=$((MATRIX_ERRORS + 1))
      fi
      MATRIX_CASES=$((MATRIX_CASES + 1))
    done
  done
  printf 'matrix_cases=%s matrix_errors=%s\n' "$MATRIX_CASES" "$MATRIX_ERRORS"
)"
if [[ "$PIPEFAIL_ASSERT_RESULT" == *'matrix_cases=32 matrix_errors=0'* ]]; then
  pass_test
else
  fail_test "CALL_LOG 长日志矩阵每种场景的正反断言须正确（原文不输出）"
fi

echo "== 1. safe rollback 不碰 DB（真实 release gate × fake app 全绿）=="
RESTORE_STUB_MODE=success make_sandbox
# 故障注入：在隔离的命令替换子 shell 中实际触发缺失 app_up 的
# assert_log_contains 分支；只允许固定阶段标志进入输出。该子 shell 的
# FAIL 计数不会污染主测试计数；$$ 始终对应 rb-out 写入文件的 shell PID。
DIAG_RESULT="$(
  CALL_LOG='docker image inspect;docker compose config --images'
  LAST_ROLLBACK_RC=17
  printf '%s\n' '[rollback] resolved app image = ignored' \
    'CANARY_SECRET_SHOULD_NOT_LEAK=private' > "/tmp/rb-out.$$"
  assert_log_contains "app_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c" 2>&1
  rm -f "/tmp/rb-out.$$"
)"
if [[ "$DIAG_RESULT" == *'rollback app_up 调用缺失'* &&
      "$DIAG_RESULT" == *'RB_DIAG exit=17'* &&
      "$DIAG_RESULT" == *'image_inspect=1'* && "$DIAG_RESULT" == *'config_images=1'* &&
      "$DIAG_RESULT" == *'resolved_app=1'* && "$DIAG_RESULT" == *'app_up=0'* &&
      "$DIAG_RESULT" != *'CANARY_SECRET_SHOULD_NOT_LEAK'* ]]; then
  pass_test
else
  fail_test "RB_DIAG 缺失 app_up 实际断言链须输出固定标志，禁止回显敏感原文"
fi
# 故障注入：通用缺失断言不得泄露原始 Docker 参数。
GENERIC_DIAG_RESULT="$(
  CALL_LOG='docker image inspect CANARY_SECRET_SHOULD_NOT_LEAK=private'
  LAST_ROLLBACK_RC=23
  printf '%s\n' '[rollback] resolved app image = ignored' > "/tmp/rb-out.$$"
  assert_log_contains "restore_called" 2>&1
  rm -f "/tmp/rb-out.$$"
)"
if [[ "$GENERIC_DIAG_RESULT" == *'log 缺少指定阶段标志'* &&
      "$GENERIC_DIAG_RESULT" == *'RB_DIAG exit=23'* &&
      "$GENERIC_DIAG_RESULT" == *'image_inspect=1'* &&
      "$GENERIC_DIAG_RESULT" != *'CANARY_SECRET_SHOULD_NOT_LEAK'* &&
      "$GENERIC_DIAG_RESULT" != *'docker image inspect'* ]]; then
  pass_test
else
  fail_test "RB_DIAG 通用缺失断言须使用固定阶段标志且不得回显原始调用日志"
fi
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
assert_log_not_contains "async_up_called"

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
assert_log_contains "async_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"

echo "== 4. 缺少备份文件 → 失败（不调用 restore）=="
make_sandbox   # 新沙箱，BACKUP_DIR 为空
run_rollback "${PREV_SHA}" --hard; rc=$?
assert_exit 1 "$rc" "missing backup"
assert_log_not_contains "restore_called"

echo "== 4b. hard rollback to old app without recovery hold rejects before restore and writers =="
RESTORE_STUB_MODE=success make_sandbox
EXTRA_ENV=(RECOVERY_HOLD_STUB_MODE=legacy)
run_rollback "${PREV_SHA}" --hard; rc=$?
EXTRA_ENV=()
assert_exit 1 "$rc" "hard rollback incompatible target credential hold"
assert_log_not_contains "restore_called"
assert_log_not_contains "app_stop_called"
assert_log_not_contains "app_up_called"

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
assert_log_contains "async_stop_called"
assert_log_contains "pg_restore_called"
assert_log_contains "security_invalidate_called"
# 顺序硬门禁：两个 writer 的停止标记都必须先于第一次 psql（terminate connections）
stop_app_line="$(printf '%s' "$CALL_LOG" | grep -n "app_stop_called" | head -1 | cut -d: -f1)"
stop_cleanup_line="$(printf '%s' "$CALL_LOG" | grep -n "cleanup_stop_called" | head -1 | cut -d: -f1)"
stop_async_line="$(printf '%s' "$CALL_LOG" | grep -n "async_stop_called" | head -1 | cut -d: -f1)"
first_psql_line="$(printf '%s' "$CALL_LOG" | grep -n "psql_called" | head -1 | cut -d: -f1)"
if [[ -n "$stop_app_line" && -n "$stop_cleanup_line" && -n "$stop_async_line" && -n "$first_psql_line" \
      && "$stop_app_line" -lt "$first_psql_line" && "$stop_cleanup_line" -lt "$first_psql_line" && "$stop_async_line" -lt "$first_psql_line" ]]; then
  pass_test
else
  fail_test "必须在 terminate DB connections 之前停止 app / storage-cleanup / async-worker"
fi

echo "== 5b-security. 恢复后凭据失效失败 → FAIL CLOSED：不可宣告恢复成功 =="
make_sandbox
printf 'REALDUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
echo "$(sha256sum "${SANDBOX}/backups/db-20260101.dump" | awk '{print $1}')  db-20260101.dump" > "${SANDBOX}/backups/db-20260101.dump.sha256"
OPS_PROJECT_DIR="${SANDBOX}" OPS_SLEEP_SECONDS=0 PATH="${SANDBOX}/bin:${PATH}" \
  RECOVERY_SECURITY_STUB_MODE=fail \
  bash "${REPO_ROOT}/scripts/ops/restore-production-postgres.sh" \
    --production-restore --backup-file "${SANDBOX}/backups/db-20260101.dump" \
    --target-db campus_marketplace >"${SANDBOX}/security-failure.log" 2>&1; rc=$?
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_exit 1 "$rc" "post-restore auth invalidation failed"
assert_log_contains "pg_restore_called"
assert_log_contains "security_invalidate_called"
if grep -qF "恢复后的登录会话或账号恢复链接未能全部失效" "${SANDBOX}/security-failure.log"; then pass_test; else fail_test "缺少认证失效门禁错误标志"; fi

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

echo "== 5c-async. async-worker 停止后仍运行 → 拒绝破坏性 DB 操作 =="
make_sandbox
printf 'REALDUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
echo "$(sha256sum "${SANDBOX}/backups/db-20260101.dump" | awk '{print $1}')  db-20260101.dump" > "${SANDBOX}/backups/db-20260101.dump.sha256"
OPS_PROJECT_DIR="${SANDBOX}" PATH="${SANDBOX}/bin:${PATH}" STOP_FAILURE_STUB_MODE=async-worker \
  bash "${REPO_ROOT}/scripts/ops/restore-production-postgres.sh" \
    --production-restore --backup-file "${SANDBOX}/backups/db-20260101.dump" \
    --target-db campus_marketplace >/tmp/rp-async-stopfail.$$ 2>&1; rc=$?
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_exit 1 "$rc" "async-worker stop not verified"
assert_log_contains "app_stop_called"
assert_log_contains "cleanup_stop_called"
assert_log_contains "async_stop_called"
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

echo "== 5e. PS_QUERY_FAILURE（无法确认 writer 状态）→ FAIL CLOSED：不停止、不 terminate、不 DROP =="
make_sandbox
printf 'REALDUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
echo "$(sha256sum "${SANDBOX}/backups/db-20260101.dump" | awk '{print $1}')  db-20260101.dump" > "${SANDBOX}/backups/db-20260101.dump.sha256"
OPS_PROJECT_DIR="${SANDBOX}" OPS_SLEEP_SECONDS=0 PATH="${SANDBOX}/bin:${PATH}" \
  PS_FAILURE_STUB_MODE=query \
  bash "${REPO_ROOT}/scripts/ops/restore-production-postgres.sh" \
    --production-restore --backup-file "${SANDBOX}/backups/db-20260101.dump" \
    --target-db campus_marketplace >/tmp/rp-psq.$$ 2>&1; rc=$?
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_exit 1 "$rc" "ps query failure must fail closed"
assert_log_not_contains "app_stop_called"
assert_log_not_contains "cleanup_stop_called"
assert_log_not_contains "psql_called"
assert_log_not_contains "pg_restore_called"
if grep -qF "无法确认 app writer 状态" /tmp/rp-psq.$$; then pass_test; else fail_test "缺少 writer 状态确认失败原因"; fi

echo "== 5f. PS_VERIFY_FAILURE（停止后无法验证状态）→ FAIL CLOSED：unknown state ≠ stopped =="
make_sandbox
printf 'REALDUMPDATA' > "${SANDBOX}/backups/db-20260101.dump"
echo "$(sha256sum "${SANDBOX}/backups/db-20260101.dump" | awk '{print $1}')  db-20260101.dump" > "${SANDBOX}/backups/db-20260101.dump.sha256"
OPS_PROJECT_DIR="${SANDBOX}" OPS_SLEEP_SECONDS=0 PATH="${SANDBOX}/bin:${PATH}" \
  PS_FAILURE_STUB_MODE=verify \
  bash "${REPO_ROOT}/scripts/ops/restore-production-postgres.sh" \
    --production-restore --backup-file "${SANDBOX}/backups/db-20260101.dump" \
    --target-db campus_marketplace >/tmp/rp-psv.$$ 2>&1; rc=$?
CALL_LOG="$(cat "${SANDBOX}/calls.log" 2>/dev/null || true)"
assert_exit 1 "$rc" "ps verify failure must fail closed"
assert_log_contains "app_stop_called"
assert_log_not_contains "cleanup_stop_called"
assert_log_not_contains "psql_called"
assert_log_not_contains "pg_restore_called"
if grep -qF "无法确认 app 停止状态" /tmp/rp-psv.$$; then pass_test; else fail_test "缺少停止状态确认失败原因"; fi

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
assert_log_contains "async_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
assert_contains_file "ASYNC_WORKER_IMAGE=campus-marketplace-async-worker:${PREV_SHA}" "${SANDBOX}/.releases.log" "rollback 日志 async image"
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

echo "== 9i. post-worker 运行容器镜像非目标 SHA → ROLLBACK FAIL，不写 release log =="
RESTORE_STUB_MODE=success make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
WORKER_RUNNING_WRONG_IMAGE=1 run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 1 "$rc" "wrong runtime image must fail rollback"
assert_log_contains "app_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
assert_log_contains "cleanup_up_called GIT_SHA=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
# run_rollback 的输出文件路径中 $$ 为本测试脚本 PID（整个运行期恒定）
if grep -qF "运行中的 storage-cleanup 容器镜像不是" "/tmp/rb-out.$$"; then
  pass_test
else
  fail_test "缺少运行容器镜像失败原因"
fi
if [[ -e "${SANDBOX}/.releases.log" ]]; then
  fail_test "wrong runtime image 后不得写 .releases.log"
else
  pass_test
fi

echo "== 9j. pre-worker + PS verify failure（无法确认 cleanup 停止状态）→ FAIL CLOSED =="
RESTORE_STUB_MODE=success make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
CLEANUP_STUB_MODE=pre-worker PS_FAILURE_STUB_MODE=verify-cleanup run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 1 "$rc" "pre-worker ps verify failure must fail rollback"
assert_log_contains "async_stop_called"
assert_log_contains "cleanup_stop_called"
assert_log_not_contains "cleanup_up_called"
if [[ -e "${SANDBOX}/.releases.log" ]]; then
  fail_test "pre-worker ps failure 后不得写 .releases.log"
else
  pass_test
fi

echo "== 9k. async-worker 回滚切换失败 → FAIL CLOSED，无成功日志 =="
make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
UP_FAILURE_STUB_MODE=async-worker run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 1 "$rc" "async-worker up failure"
assert_log_contains "async_stop_called"
assert_log_contains "async_up_called"
if [[ -e "${SANDBOX}/.releases.log" ]]; then fail_test "async up 失败不得写成功日志"; else pass_test; fi

echo "== 9l. async-worker 运行镜像不匹配 → FAIL CLOSED =="
make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
ASYNC_RUNNING_WRONG_IMAGE=1 run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 1 "$rc" "async wrong image fail closed"
assert_log_contains "async_up_called"
if [[ -e "${SANDBOX}/.releases.log" ]]; then fail_test "async 镜像错误不得写成功日志"; else pass_test; fi

echo "== 9m. 目标版本没有 async-worker image → 旧 worker 必须停止 =="
make_sandbox
FAKE_OUT="${SANDBOX}/fake-app.out"
start_fake_app "${PREV_SHA}" ready "${FAKE_OUT}" || fail_test "fake app 启动"
TEST_APP_URL="http://127.0.0.1:$(fake_port "${FAKE_OUT}")"
ASYNC_STUB_MODE=pre-async run_rollback "${PREV_SHA}"; rc=$?
TEST_APP_URL=""
[[ -n "${FAKE_APP_PID:-}" ]] && kill "${FAKE_APP_PID}" 2>/dev/null
assert_exit 0 "$rc" "pre-async rollback"
assert_log_contains "async_stop_called"
assert_log_not_contains "async_up_called"
assert_contains_file "ASYNC_WORKER=stopped_pre_async_release" "${SANDBOX}/.releases.log" "pre-async rollback log"

echo "== 9o. 有 worker 的历史提交缺失镜像 → 拒绝误判为 pre-async =="
make_sandbox
ASYNC_STUB_MODE=missing-image run_rollback "${PREV_SHA}"; rc=$?
assert_exit 1 "$rc" "post-async missing image must fail closed"
assert_log_not_contains "app_up_called"
assert_log_not_contains "async_up_called"
if [[ -e "${SANDBOX}/.releases.log" ]]; then
  fail_test "已存在 async-worker 的旧版本缺失镜像不得写成功日志"
else
  pass_test
fi

echo "== 9n. 无法确认 async-worker 已停止 → 必须阻断 app 切换 =="
make_sandbox
STOP_FAILURE_STUB_MODE=async-worker run_rollback "${PREV_SHA}"; rc=$?
assert_exit 1 "$rc" "async stop failure"
assert_log_contains "async_stop_called"
assert_log_not_contains "app_up_called"
if [[ -e "${SANDBOX}/.releases.log" ]]; then fail_test "async 停止未验证不得写日志"; else pass_test; fi

echo "== 9o. post-worker release 镜像已 prune → 不得伪装 pre-worker =="
make_sandbox
CLEANUP_STUB_MODE=missing-image run_rollback "${PREV_SHA}"; rc=$?
assert_exit 1 "$rc" "cleanup missing image"
assert_log_not_contains "cleanup_stop_called"
assert_log_not_contains "app_up_called"
if [[ -e "${SANDBOX}/.releases.log" ]]; then fail_test "cleanup 镜像缺失不得写日志"; else pass_test; fi

echo "== 9p. cleanup stop failure blocks rollback before app switch =="
make_sandbox
STOP_FAILURE_STUB_MODE=storage-cleanup run_rollback "${PREV_SHA}"; rc=$?
assert_exit 1 "$rc" "cleanup stop failure"
assert_log_contains "async_stop_called"
assert_log_contains "cleanup_stop_called"
assert_log_not_contains "app_up_called"
assert_log_not_contains "cleanup_up_called"
if [[ -e "${SANDBOX}/.releases.log" ]]; then fail_test "cleanup stop failure must not write release log"; else pass_test; fi

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
