#!/usr/bin/env bash
# =============================================================================
# deploy release-readiness gate shell-level regression tests（RB-06 §57）
#
# 在沙箱中执行真实 deploy.sh（docker/npx 走 stub，不构建不部署生产），覆盖：
#   1. stub verifier PASS → deploy exit 0，.releases.log 写入且含 READINESS=ready
#   2. stub verifier FAIL → deploy exit 1，绝不写 SUCCESS release log
#   3. REAL verifier（scripts/ops/release-readiness-check.ts）× 本地 fake app：
#      health ok + ready 全绿 → exit 0
#   4. REAL verifier：ready HTTP 200 + degraded → exit 1，不写 release log
#      （RB-06 核心：HTTP 200 ≠ DEPLOY SUCCESS）
#   5. REAL verifier：invalid expected SHA → exit 1（网络验证之前 fail closed）
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

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_SHA="0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"

make_sandbox() {
  [[ -n "${SANDBOX}" ]] && rm -rf "${SANDBOX}"
  SANDBOX="$(mktemp -d)"
  mkdir -p "${SANDBOX}/bin" "${SANDBOX}/backups"
  cat > "${SANDBOX}/.env.production" <<'ENV'
SITE_ADDRESS=campus.example.edu.cn
POSTGRES_USER=campus_app
POSTGRES_PASSWORD=SandboxOnly-Not-For-Real-Deploy
POSTGRES_DB=campus_marketplace
DATABASE_URL=postgresql://campus_app:SandboxOnly-Not-For-Real-Deploy@postgres:5432/campus_marketplace?schema=public
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
  sed -i "s|BACKUP_DIR_PLACEHOLDER|${SANDBOX}/backups|" "${SANDBOX}/.env.production"
  printf 'BACKUP_DIR=%s\n' "${SANDBOX}/backups" >> "${SANDBOX}/.env.production"

  # ---- docker stub：build/up/migrate（返回 No pending migrations）----
  cat > "${SANDBOX}/bin/docker" <<STUB
#!/usr/bin/env bash
ARGS="\$*"
case "\$ARGS" in
  *"run --rm migrate"*)
    echo "No pending migrations"
    exit 0 ;;
  *"up -d"*)
    echo "app_up_called GIT_SHA=\${GIT_SHA:-<unset>} ARGS=\$ARGS"
    exit 0 ;;
  *"config --images"*)
    if [[ -n "\${GIT_SHA:-}" ]]; then
      echo "campus-marketplace-app:\${GIT_SHA}"
    else
      echo "campus-marketplace-app:local"
    fi
    exit 0 ;;
  *"exec -T postgres pg_dump"*)
    echo "DUMMYDUMP"
    exit 0 ;;
  *"exec -T postgres psql"*)
    exit 0 ;;
  *)
    exit 0 ;;
esac
STUB
  chmod +x "${SANDBOX}/bin/docker"

  # ---- npx stub：透传到真实 tsx（production-env-check / release verifier）----
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

  # ---- stub verifier（仅测试 seam；生产路径走真实 release-readiness-check.ts）----
  cat > "${SANDBOX}/bin/release-verifier-stub" <<STUB
#!/usr/bin/env bash
echo "verifier_called:\$1" >> "${SANDBOX}/calls.log"
case "\${VERIFIER_STUB_MODE:-success}" in
  success) exit 0 ;;
  failure) exit 1 ;;
esac
STUB
  chmod +x "${SANDBOX}/bin/release-verifier-stub"
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

run_deploy() {  # $1=输出文件；APP_URL 等经 EXTRA_ENV 注入
  rm -f "${SANDBOX}/.releases.log"
  # OPS_RELEASE_VERIFIER：未设置 → 默认 stub verifier；显式空串 → 真实 verifier
  #（${VAR-default} 语义：空串是显式选择，不得被 :- 折叠成默认）
  env "${UNSET_ENV_ARGS[@]}" "${EXTRA_ENV[@]}" PATH="${SANDBOX}/bin:${PATH}" \
    VERIFIER_STUB_MODE="${VERIFIER_STUB_MODE:-success}" \
    OPS_PROJECT_DIR="${SANDBOX}" \
    OPS_RELEASE_VERIFIER="${OPS_RELEASE_VERIFIER-${SANDBOX}/bin/release-verifier-stub}" \
    OPS_HEALTH_TIMEOUT="${OPS_HEALTH_TIMEOUT-120}" \
    bash "${REPO_ROOT}/scripts/ops/deploy.sh" "${DEPLOY_SHA}" > "$1" 2>&1
  return $?
}

EXTRA_ENV=()

echo "== 1. stub verifier PASS → exit 0 + release log（含 READINESS=ready）=="
make_sandbox
OUT="$(mktemp)"
run_deploy "${OUT}"; rc=$?
assert_exit 0 "$rc" "deploy with verifier pass"
assert_contains "verifier_called:${DEPLOY_SHA}" "${SANDBOX}/calls.log" "verifier 收到 expected SHA"
assert_contains "RELEASE_SHA=${DEPLOY_SHA}" "${SANDBOX}/.releases.log" "release log 记录 SHA"
assert_contains "READINESS=ready" "${SANDBOX}/.releases.log" "release log 记录 readiness"
assert_contains "app_up_called" "${OUT}" "app 滚动更新已执行"
rm -f "${OUT}"

echo "== 2. stub verifier FAIL → exit 1 + 绝不写 SUCCESS release log =="
make_sandbox
OUT="$(mktemp)"
VERIFIER_STUB_MODE=failure run_deploy "${OUT}"; rc=$?
assert_exit 1 "$rc" "deploy with verifier failure"
assert_contains "deployment verification failed" "${OUT}" "失败输出明确指向回滚参考"
assert_file_absent "${SANDBOX}/.releases.log" "失败后不写 release log"
rm -f "${OUT}"

echo "== 3. REAL verifier × fake app 全绿 → exit 0 + release log =="
make_sandbox
PORTFILE="${SANDBOX}/fake-app.out"
start_fake_app ready "${DEPLOY_SHA}" "${PORTFILE}" || { fail_test "fake app 启动"; }
EXTRA_ENV=(APP_URL="http://127.0.0.1:$(fake_port "${PORTFILE}")")
OUT="$(mktemp)"
OPS_RELEASE_VERIFIER="" OPS_HEALTH_TIMEOUT=15 run_deploy "${OUT}"; rc=$?
if [[ "${DEPLOY_GATE_DEBUG:-}" == "1" ]]; then echo "---- test3 deploy output ----"; cat "${OUT}"; fi
assert_exit 0 "$rc" "real verifier all-green deploy"
assert_contains "RELEASE_SHA=${DEPLOY_SHA}" "${SANDBOX}/.releases.log" "real verifier 通过后写 release log"
assert_contains "READINESS=ready" "${SANDBOX}/.releases.log" "real verifier 通过后记录 readiness"

echo "== 4. REAL verifier：ready HTTP 200 + degraded → exit 1 + 不写 release log（RB-06 核心）=="
make_sandbox
PORTFILE="${SANDBOX}/fake-app.out"
start_fake_app degraded "${DEPLOY_SHA}" "${PORTFILE}" || { fail_test "fake app 启动"; }
OUT="$(mktemp)"
EXTRA_ENV=(APP_URL="http://127.0.0.1:$(fake_port "${PORTFILE}")")
OPS_RELEASE_VERIFIER="" OPS_HEALTH_TIMEOUT=2 run_deploy "${OUT}"; rc=$?
assert_exit 1 "$rc" "real verifier degraded must fail deploy"
assert_contains "deployment verification failed" "${OUT}" "degraded 失败输出"
assert_file_absent "${SANDBOX}/.releases.log" "degraded 不写 release log"
rm -f "${OUT}"

echo "== 5. REAL verifier：invalid expected SHA → 网络验证之前 fail（不写 release log）=="
make_sandbox
OUT="$(mktemp)"
PORTFILE="${SANDBOX}/fake-app.out"
start_fake_app ready "${DEPLOY_SHA}" "${PORTFILE}" || { fail_test "fake app 启动"; }
# deploy 传入短 SHA：verifier 必须 INVALID_EXPECTED_SHA 快速失败
env "${UNSET_ENV_ARGS[@]}" \
  APP_URL="http://127.0.0.1:$(fake_port "${PORTFILE}")" \
  OPS_PROJECT_DIR="${SANDBOX}" \
  OPS_HEALTH_TIMEOUT=5 \
  PATH="${SANDBOX}/bin:${PATH}" \
  bash "${REPO_ROOT}/scripts/ops/deploy.sh" "shortsha" > "${OUT}" 2>&1
rc=$?
assert_exit 1 "$rc" "deploy with invalid sha"
assert_contains "INVALID_EXPECTED_SHA" "${OUT}" "invalid sha 快速失败原因"
assert_file_absent "${SANDBOX}/.releases.log" "invalid sha 不写 release log"
rm -f "${OUT}"

echo "=============================="
echo "PASS=${PASS} FAIL=${FAIL}"
if [[ "${FAIL}" != "0" ]]; then exit 1; fi
exit 0
