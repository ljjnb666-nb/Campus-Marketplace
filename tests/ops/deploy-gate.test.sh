#!/usr/bin/env bash
# =============================================================================
# deploy source-identity + release-gate shell-level regression（RB-06 FINAL）
#
# 在沙箱（最小 git 仓库 + docker/npx PATH stub + 本地 fake HTTP app）中执行
# 真实 deploy.sh，不构建、不部署生产：
#   SOURCE-01  clean tree + 无参数 → GIT_SHA=HEAD，走完全流程（真实 verifier）
#   SOURCE-02  clean tree + 显式 HEAD（大写）→ 正常化后放行
#   SOURCE-03  有效 40-hex ≠ HEAD（远端自报该 SHA）→ RELEASE_SOURCE_SHA_MISMATCH
#              且在任何网络/部署动作之前失败（§27 关键证明）
#   SOURCE-04  短 SHA → INVALID_EXPECTED_SHA，零生产副作用
#   SOURCE-05  41 字符 hex → INVALID_EXPECTED_SHA，零生产副作用
#   SOURCE-06  tracked 文件修改 → RELEASE_SOURCE_TREE_DIRTY，零副作用
#   SOURCE-07  staged 变更 → RELEASE_SOURCE_TREE_DIRTY，零副作用
#   SOURCE-08  untracked source 文件 → RELEASE_SOURCE_TREE_DIRTY，零副作用
#   GATE-OK    真实 verifier × fake app 全绿 → exit 0 + release log
#   GATE-DEGRADED  ready HTTP 200 + degraded → exit 1 + 不写 release log
#   GATE-NOTREADY  ready 503 not_ready → exit 1 + 不写 release log
# verifier 一律为真实 scripts/ops/release-readiness-check.ts（RB-06 FINAL-02：
# 生产脚本与测试均无 OPS_RELEASE_VERIFIER 类 env override）。
# 由 tests/ops/ops-scripts.test.ts（vitest）调用并断言整体退出码。
# =============================================================================
set -uo pipefail

PASS=0
FAIL=0
SANDBOX=""
NODE_PIDS=()

pass_test() { PASS=$((PASS + 1)); }
fail_test() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

assert_contains() {
  if grep -qF "$1" "$2" 2>/dev/null; then pass_test; else fail_test "$3: 文件 $2 缺少: $1"; fi
}
assert_not_contains() {
  if grep -qF "$1" "$2" 2>/dev/null; then fail_test "$3: 文件 $2 不应包含: $1"; else pass_test; fi
}
assert_exit() {
  if [[ "$1" == "$2" ]]; then pass_test; else fail_test "$3: 期望 exit=$1 实际=$2"; fi
}
assert_file_absent() {
  if [[ -e "$1" ]]; then fail_test "$2: 文件不应存在: $1"; else pass_test; fi
}
# 零生产副作用：calls.log 不存在（或无任何 side_effect 标记）+ 无 release log
assert_zero_side_effects() {
  if [[ -f "${SANDBOX}/calls.log" ]] && grep -q "side_effect:" "${SANDBOX}/calls.log" 2>/dev/null; then
    fail_test "$1: 出现生产副作用: $(grep 'side_effect:' "${SANDBOX}/calls.log" | tr '\n' ';')"
  else
    pass_test
  fi
  assert_file_absent "${SANDBOX}/.releases.log" "$1: 不写 release log"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# 40-hex；与沙箱 HEAD 不同，用于 mismatch/自报场景
OTHER_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

make_sandbox() {
  [[ -n "${SANDBOX}" ]] && rm -rf "${SANDBOX}"
  SANDBOX="$(mktemp -d)"
  mkdir -p "${SANDBOX}/bin" "${SANDBOX}/backups"
  cat > "${SANDBOX}/.env.production" <<'ENV'
SITE_ADDRESS=campus.example.edu.cn
POSTGRES_USER=campus_app
POSTGRES_PASSWORD=SandboxOnly-Not-For-Real-Deploy
POSTGRES_DB=campus_marketplace
DATABASE_URL=postgresql://campus_app:SandboxOnly-Not-For-Real-Deploy@postgres:5432/campus_marketplace?schema=public&connection_limit=10&pool_timeout=10
REDIS_PASSWORD=SandboxOnly-Not-For-Real-Deploy
REDIS_URL=redis://:SandboxOnly-Not-For-Real-Deploy@redis:6379
NEXTAUTH_URL=https://campus.example.edu.cn
NEXTAUTH_SECRET=sandbox-only-not-a-real-secret-00aabbccdd
S3_ENDPOINT=https://s3.campus.example.edu.cn
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=CAMPUSSANDBOXKEY01
S3_SECRET_ACCESS_KEY=SandboxOnly-Not-For-Real-Deploy
S3_BUCKET_PUBLIC=campus-public
S3_BUCKET_PRIVATE=campus-private
PUBLIC_ASSET_BASE_URL=https://campus.example.edu.cn/assets
APP_NAME=校园集市
DEFAULT_CAMPUS_SLUG=main-campus
BACKUP_OFFSITE_TARGET=
BACKUP_RETENTION_DAYS=14
ENV
  printf 'BACKUP_DIR=%s\n' "${SANDBOX}/backups" >> "${SANDBOX}/.env.production"

  # ---- 沙箱 = 最小 git 仓库：HEAD 是 source identity gate 的被测对象 ----
  # runtime/ignored 文件不进 porcelain（与真实仓库的 .gitignore 语义一致，
  # 不做手工 allowlist）。
  git init -q "${SANDBOX}"
  git -C "${SANDBOX}" config user.email deploy-gate@test.local
  git -C "${SANDBOX}" config user.name deploy-gate
  cat > "${SANDBOX}/.gitignore" <<'GITIGNORE'
bin/
backups/
calls.log
fake-app.out
.env.production
.releases.log
GITIGNORE
  echo "committed source marker" > "${SANDBOX}/app-source-marker.txt"
  git -C "${SANDBOX}" add .gitignore app-source-marker.txt
  git -C "${SANDBOX}" commit -q -m "sandbox init"

  # ---- docker stub：记录 side_effect 并模拟 compose 行为 ----
  cat > "${SANDBOX}/bin/docker" <<STUB
#!/usr/bin/env bash
ARGS="\$*"
echo "docker_called:\${ARGS}" >> "${SANDBOX}/calls.log"
case "\$ARGS" in
  *"compose"*"build"*)
    echo "side_effect:build GIT_SHA=\${GIT_SHA:-<unset>}" >> "${SANDBOX}/calls.log"
    exit 0 ;;
  *"compose"*"run --rm migrate"*)
    echo "side_effect:migrate" >> "${SANDBOX}/calls.log"
    echo "No pending migrations"
    exit 0 ;;
  *"compose"*"up -d"*)
    echo "side_effect:app_up GIT_SHA=\${GIT_SHA:-<unset>} ARGS=\$ARGS" >> "${SANDBOX}/calls.log"
    echo "app_up_called GIT_SHA=\${GIT_SHA:-<unset>}"
    exit 0 ;;
  *"compose"*"config --images"*)
    if [[ -n "\${GIT_SHA:-}" ]]; then
      echo "campus-marketplace-app:\${GIT_SHA}"
    else
      echo "campus-marketplace-app:local"
    fi
    exit 0 ;;
  *"exec -T postgres pg_dump"*)
    echo "side_effect:pg_dump" >> "${SANDBOX}/calls.log"
    echo "DUMMYDUMP"
    exit 0 ;;
  *"exec -T postgres psql"*)
    exit 0 ;;
  *)
    exit 0 ;;
esac
STUB
  chmod +x "${SANDBOX}/bin/docker"

  # ---- npx stub：透传真实 tsx（env-check / release-readiness-check.ts）----
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

cleanup() {
  for pid in "${NODE_PIDS[@]:-}"; do
    kill "${pid}" 2>/dev/null || true
  done
  NODE_PIDS=()
  [[ -n "${SANDBOX}" ]] && rm -rf "${SANDBOX}"
}
trap cleanup EXIT

# 启动 fake app（node one-liner；端口经 stdout 写入 bash 管理的文件，避免 MSYS 路径转换问题）
# $1=ready 模式 $2=release $3=输出文件（内容 PORT=<port>）
start_fake_app() {
  node -e '
    const http = require("node:http");
    const [mode, sha] = process.argv.slice(1);
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
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "not_ready", release: sha, dependencies: { database: "failed", redis: "ok", storage: "ok" } }));
      }
    });
    server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));
  ' "$1" "$2" > "$3" 2>&1 &
  local pid=$!
  NODE_PIDS+=("${pid}")
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

# production-env-check 以 process.env 优先于 --file（契约语义）。
# 测试进程可能继承本地 .env 的开发值（如 vitest dotenv），必须显式 unset，
# 保证沙箱 deploy 只看到 .env.production（沙箱文件）中的契约值。
UNSET_ENV_ARGS=(
  -u DATABASE_URL -u REDIS_URL
  -u NEXTAUTH_URL -u NEXTAUTH_SECRET
  -u S3_ENDPOINT -u S3_REGION -u S3_ACCESS_KEY_ID -u S3_SECRET_ACCESS_KEY
  -u S3_BUCKET_PUBLIC -u S3_BUCKET_PRIVATE -u S3_FORCE_PATH_STYLE
  -u PUBLIC_ASSET_BASE_URL -u SITE_ADDRESS -u APP_NAME -u DEFAULT_CAMPUS_SLUG
  -u ALLOW_LOCAL_S3_IN_PRODUCTION -u BACKUP_DIR -u BACKUP_OFFSITE_TARGET
  -u BACKUP_RETENTION_DAYS -u METRICS_BEARER_TOKEN -u RELEASE_SHA
)

run_deploy() {  # $1=输出文件；$2=可选显式 SHA；APP_URL 等经 EXTRA_ENV 注入
  rm -f "${SANDBOX}/.releases.log" "${SANDBOX}/calls.log"
  if [[ $# -ge 2 && -n "${2:-}" ]]; then
    env "${UNSET_ENV_ARGS[@]}" "${EXTRA_ENV[@]}" PATH="${SANDBOX}/bin:${PATH}" \
      OPS_PROJECT_DIR="${SANDBOX}" \
      OPS_HEALTH_TIMEOUT="${OPS_HEALTH_TIMEOUT-120}" \
      bash "${REPO_ROOT}/scripts/ops/deploy.sh" "$2" > "$1" 2>&1
  else
    env "${UNSET_ENV_ARGS[@]}" "${EXTRA_ENV[@]}" PATH="${SANDBOX}/bin:${PATH}" \
      OPS_PROJECT_DIR="${SANDBOX}" \
      OPS_HEALTH_TIMEOUT="${OPS_HEALTH_TIMEOUT-120}" \
      bash "${REPO_ROOT}/scripts/ops/deploy.sh" > "$1" 2>&1
  fi
  return $?
}

SANDBOX_HEAD=""
refresh_head() {
  SANDBOX_HEAD="$(git -C "${SANDBOX}" rev-parse HEAD)"
}

EXTRA_ENV=()

echo "== SOURCE-01：clean tree + 无参数 → GIT_SHA=HEAD，真实 verifier 全绿放行 =="
make_sandbox
refresh_head
PORTFILE="${SANDBOX}/fake-app.out"
start_fake_app ready "${SANDBOX_HEAD}" "${PORTFILE}" || { fail_test "fake app 启动"; }
EXTRA_ENV=(APP_URL="http://127.0.0.1:$(fake_port "${PORTFILE}")")
OUT="$(mktemp)"
OPS_HEALTH_TIMEOUT=15 run_deploy "${OUT}"; rc=$?
assert_exit 0 "$rc" "SOURCE-01 deploy"
assert_contains "side_effect:app_up GIT_SHA=${SANDBOX_HEAD}" "${SANDBOX}/calls.log" "SOURCE-01 以 HEAD 为 release 更新 app"
assert_contains "RELEASE_SHA=${SANDBOX_HEAD}" "${SANDBOX}/.releases.log" "SOURCE-01 release log 记录 HEAD"
assert_contains "READINESS=ready" "${SANDBOX}/.releases.log" "SOURCE-01 release log readiness"
rm -f "${OUT}"

echo "== SOURCE-02：clean tree + 显式 HEAD（大写）→ 正常化后放行 =="
make_sandbox
refresh_head
PORTFILE="${SANDBOX}/fake-app.out"
start_fake_app ready "${SANDBOX_HEAD}" "${PORTFILE}" || { fail_test "fake app 启动"; }
EXTRA_ENV=(APP_URL="http://127.0.0.1:$(fake_port "${PORTFILE}")")
OUT="$(mktemp)"
UPPER_HEAD="$(printf '%s' "${SANDBOX_HEAD}" | tr 'a-f' 'A-F')"
OPS_HEALTH_TIMEOUT=15 run_deploy "${OUT}" "${UPPER_HEAD}"; rc=$?
assert_exit 0 "$rc" "SOURCE-02 deploy with uppercase HEAD"
assert_contains "side_effect:app_up GIT_SHA=${SANDBOX_HEAD}" "${SANDBOX}/calls.log" "SOURCE-02 release identity = HEAD"
rm -f "${OUT}"

echo "== SOURCE-03（§27）：有效 40-hex ≠ HEAD，且远端自报该 SHA → 任何网络/部署动作之前 RELEASE_SOURCE_SHA_MISMATCH =="
make_sandbox
refresh_head
PORTFILE="${SANDBOX}/fake-app.out"
# fake app 全链路自报 OTHER_SHA：若 deploy 误把调用者标签当 release 传给 verifier，
# verifier 会照它 PASS——因此本测试要求 deploy 在 STEP 0 就失败、根本不触网。
start_fake_app ready "${OTHER_SHA}" "${PORTFILE}" || { fail_test "fake app 启动"; }
EXTRA_ENV=(APP_URL="http://127.0.0.1:$(fake_port "${PORTFILE}")")
OUT="$(mktemp)"
run_deploy "${OUT}" "${OTHER_SHA}"; rc=$?
assert_exit 1 "$rc" "SOURCE-03 mismatch deploy"
assert_contains "RELEASE_SOURCE_SHA_MISMATCH" "${OUT}" "SOURCE-03 失败原因"
assert_not_contains "release readiness gate" "${OUT}" "SOURCE-03 未进入 release gate（verifier 未被调用、未触网）"
assert_not_contains "生产 env 校验" "${OUT}" "SOURCE-03 在 STEP 1 preflight 之前失败"
assert_zero_side_effects "SOURCE-03"
rm -f "${OUT}"

echo "== SOURCE-04：短 SHA → INVALID_EXPECTED_SHA，零副作用 =="
make_sandbox
refresh_head
OUT="$(mktemp)"
run_deploy "${OUT}" "abc123"; rc=$?
assert_exit 1 "$rc" "SOURCE-04 deploy"
assert_contains "INVALID_EXPECTED_SHA" "${OUT}" "SOURCE-04 失败原因"
assert_zero_side_effects "SOURCE-04"
rm -f "${OUT}"

echo "== SOURCE-05：41 字符 hex → INVALID_EXPECTED_SHA，零副作用 =="
make_sandbox
refresh_head
OUT="$(mktemp)"
run_deploy "${OUT}" "${OTHER_SHA}0"; rc=$?
assert_exit 1 "$rc" "SOURCE-05 deploy"
assert_contains "INVALID_EXPECTED_SHA" "${OUT}" "SOURCE-05 失败原因"
assert_zero_side_effects "SOURCE-05"
rm -f "${OUT}"

echo "== SOURCE-06：tracked 文件修改 → RELEASE_SOURCE_TREE_DIRTY，build 之前失败 =="
make_sandbox
refresh_head
echo "dirty change" >> "${SANDBOX}/app-source-marker.txt"
OUT="$(mktemp)"
run_deploy "${OUT}"; rc=$?
assert_exit 1 "$rc" "SOURCE-06 deploy"
assert_contains "RELEASE_SOURCE_TREE_DIRTY" "${OUT}" "SOURCE-06 失败原因"
assert_zero_side_effects "SOURCE-06"
rm -f "${OUT}"

echo "== SOURCE-07：staged 变更 → RELEASE_SOURCE_TREE_DIRTY，零副作用 =="
make_sandbox
refresh_head
echo "staged change" >> "${SANDBOX}/app-source-marker.txt"
git -C "${SANDBOX}" add app-source-marker.txt
OUT="$(mktemp)"
run_deploy "${OUT}"; rc=$?
assert_exit 1 "$rc" "SOURCE-07 deploy"
assert_contains "RELEASE_SOURCE_TREE_DIRTY" "${OUT}" "SOURCE-07 失败原因"
assert_zero_side_effects "SOURCE-07"
rm -f "${OUT}"

echo "== SOURCE-08：untracked source 文件 → RELEASE_SOURCE_TREE_DIRTY，零副作用 =="
make_sandbox
refresh_head
echo "untracked build-context source" > "${SANDBOX}/new-source-file.ts"
OUT="$(mktemp)"
run_deploy "${OUT}"; rc=$?
assert_exit 1 "$rc" "SOURCE-08 deploy"
assert_contains "RELEASE_SOURCE_TREE_DIRTY" "${OUT}" "SOURCE-08 失败原因"
assert_zero_side_effects "SOURCE-08"
rm -f "${OUT}"

echo "== GATE-DEGRADED：ready HTTP 200 + degraded → verifier FAIL，不写 release log（RB-06 核心）=="
make_sandbox
refresh_head
PORTFILE="${SANDBOX}/fake-app.out"
start_fake_app degraded "${SANDBOX_HEAD}" "${PORTFILE}" || { fail_test "fake app 启动"; }
EXTRA_ENV=(APP_URL="http://127.0.0.1:$(fake_port "${PORTFILE}")")
OUT="$(mktemp)"
OPS_HEALTH_TIMEOUT=2 run_deploy "${OUT}"; rc=$?
assert_exit 1 "$rc" "GATE-DEGRADED deploy"
assert_contains "deployment verification failed" "${OUT}" "GATE-DEGRADED 失败输出"
assert_contains "READY_DEGRADED" "${OUT}" "GATE-DEGRADED verifier reason"
assert_file_absent "${SANDBOX}/.releases.log" "GATE-DEGRADED 不写 release log"
rm -f "${OUT}"

echo "== GATE-NOTREADY：ready 503 not_ready → verifier FAIL，不写 release log =="
make_sandbox
refresh_head
PORTFILE="${SANDBOX}/fake-app.out"
start_fake_app notready "${SANDBOX_HEAD}" "${PORTFILE}" || { fail_test "fake app 启动"; }
EXTRA_ENV=(APP_URL="http://127.0.0.1:$(fake_port "${PORTFILE}")")
OUT="$(mktemp)"
OPS_HEALTH_TIMEOUT=2 run_deploy "${OUT}"; rc=$?
assert_exit 1 "$rc" "GATE-NOTREADY deploy"
assert_contains "READY_NOT_READY" "${OUT}" "GATE-NOTREADY verifier reason"
assert_file_absent "${SANDBOX}/.releases.log" "GATE-NOTREADY 不写 release log"
rm -f "${OUT}"

echo "=============================="
echo "PASS=${PASS} FAIL=${FAIL}"
if [[ "${FAIL}" != "0" ]]; then exit 1; fi
exit 0
