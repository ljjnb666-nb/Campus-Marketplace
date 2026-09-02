#!/usr/bin/env bash
# =============================================================================
# backup-postgres.sh 机器可读状态产物回归测试（Phase 4 TASK 7）
#
# 通过 PATH stub（docker/aws）与 OPS_PROJECT_DIR 沙箱执行真实脚本，覆盖：
#   1. 成功备份 → backup-status.json: status=success/checksum=true/
#      offsiteStatus=not_configured + 退出码 0
#   2. dump 为空 → 退出码非 0 + status=failed stage=empty_dump
#   3. offsite 配置且 aws 上传失败 → 退出码非 0 + offsiteStatus=failed
#   4. 状态文件只含非敏感 metadata（不含密码/连接串）
# 由 tests/ops/ops-scripts.test.ts（vitest）调用并断言 FAIL=0。
# =============================================================================
set -uo pipefail

PASS=0
FAIL=0
SANDBOX=""

fail_test() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass_test() { PASS=$((PASS + 1)); }
assert_eq() {
  if [[ "$1" == "$2" ]]; then pass_test; else fail_test "$3：期望 [$1] 实际 [$2]"; fi
}
assert_contains() {
  if printf '%s' "$2" | grep -qF "$1"; then pass_test; else fail_test "内容缺少: $1"; fi
}
assert_not_contains() {
  if printf '%s' "$2" | grep -qF "$1"; then fail_test "内容不应包含: $1"; else pass_test; fi
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

make_sandbox() {
  [[ -n "${SANDBOX}" ]] && rm -rf "${SANDBOX}"
  SANDBOX="$(mktemp -d)"
  mkdir -p "${SANDBOX}/bin" "${SANDBOX}/backups"

  cat > "${SANDBOX}/.env.production" <<ENV
SITE_ADDRESS=campus.example.edu.cn
POSTGRES_USER=campus_app
POSTGRES_PASSWORD=SandboxOnly-Not-For-Real-Deploy
POSTGRES_DB=campus_marketplace
APP_NAME=校园集市
BACKUP_DIR=${SANDBOX}/backups
BACKUP_OFFSITE_TARGET=${BACKUP_TARGET_VALUE:-}
BACKUP_RETENTION_DAYS=14
ENV

  cat > "${SANDBOX}/bin/docker" <<STUB
#!/usr/bin/env bash
ARGS="\$*"
case "\$ARGS" in
  *"pg_dump"*)
    if [[ -n "\${DUMP_STUB_MODE:-}" && "\${DUMP_STUB_MODE}" == "empty" ]]; then
      exit 0
    fi
    printf 'PGDMP-fake-backup-data-for-sandbox'
    exit 0 ;;
  *) echo "[docker-stub] unhandled: \$ARGS" >&2; exit 0 ;;
esac
STUB
  chmod +x "${SANDBOX}/bin/docker"

  cat > "${SANDBOX}/bin/aws" <<STUB
#!/usr/bin/env bash
echo "[aws-stub] simulated upload failure" >&2
exit 1
STUB
  chmod +x "${SANDBOX}/bin/aws"
}

run_backup() {
  (
    export OPS_PROJECT_DIR="${SANDBOX}"
    export PATH="${SANDBOX}/bin:${PATH}"
    cd "${REPO_ROOT}" && bash scripts/ops/backup-postgres.sh
  ) 2>&1
  return $?
}

status_json() { cat "${SANDBOX}/backups/backup-status.json" 2>/dev/null || printf ''; }

# ---- 场景 1：成功备份 → success 状态产物 + exit 0 ----
make_sandbox
unset DUMP_STUB_MODE
out="$(run_backup)"; rc=$?
assert_eq 0 "$rc" "场景1 成功备份应 exit 0（输出: ${out}"$'\n'")"
json="$(status_json)"
assert_contains '"status":"success"' "$json"
assert_contains '"checksumVerified":true' "$json"
assert_contains '"offsiteStatus":"not_configured"' "$json"
assert_contains '"filename":"campus_marketplace-' "$json"
assert_contains '"completedAt":"' "$json"
# 状态产物不含敏感值
assert_not_contains 'SandboxOnly-Not-For-Real-Deploy' "$json"
assert_not_contains 'postgres://' "$json"

# ---- 场景 2：dump 为空 → exit 非 0 + failed/empty_dump 状态 ----
make_sandbox
export DUMP_STUB_MODE=empty
out="$(run_backup)"; rc=$?
unset DUMP_STUB_MODE
assert_eq 1 "$rc" "场景2 空 dump 应 exit 1"
json="$(status_json)"
assert_contains '"status":"failed"' "$json"
assert_contains '"stage":"empty_dump"' "$json"

# ---- 场景 3：offsite 配置且上传失败 → exit 非 0 + offsiteStatus=failed ----
# BACKUP_TARGET_VALUE 必须在 make_sandbox 之前设置（heredoc 展开时序）
export BACKUP_TARGET_VALUE="s3://offsite-bucket/campus"
make_sandbox
unset BACKUP_TARGET_VALUE
out="$(run_backup)"; rc=$?
assert_eq 1 "$rc" "场景3 offsite 失败应 exit 1"
json="$(status_json)"
assert_contains '"offsiteStatus":"failed"' "$json"

# ---- 场景 4（BLOCKER 4B）：POSTGRES_USER 缺失 → 非零退出 + failed 状态产物 ----
make_sandbox
grep -v '^POSTGRES_USER=' "${SANDBOX}/.env.production" > "${SANDBOX}/.env.tmp" \
  && mv "${SANDBOX}/.env.tmp" "${SANDBOX}/.env.production"
out="$(run_backup)"; rc=$?
assert_eq 1 "$rc" "场景4 POSTGRES_USER 缺失应 exit 1"
json="$(status_json)"
assert_contains '"status":"failed"' "$json"
assert_contains '"stage":"resolve_postgres_user"' "$json"
assert_not_contains 'SandboxOnly-Not-For-Real-Deploy' "$json"

# ---- 场景 5（BLOCKER 4B）：POSTGRES_DB 缺失 → 非零退出 + failed/stage=resolve_db ----
make_sandbox
grep -v '^POSTGRES_DB=' "${SANDBOX}/.env.production" > "${SANDBOX}/.env.tmp" \
  && mv "${SANDBOX}/.env.tmp" "${SANDBOX}/.env.production"
out="$(run_backup)"; rc=$?
assert_eq 1 "$rc" "场景5 POSTGRES_DB 缺失应 exit 1"
json="$(status_json)"
assert_contains '"status":"failed"' "$json"
assert_contains '"stage":"resolve_db"' "$json"

# ---- 场景 6（BLOCKER 4）：sha256sum --check 验证失败 → exit 1 + failed/stage=checksum ----
# PATH stub 的 sha256sum：正常调用输出假 hash；--check 模式一律失败，
# 模拟"dump 与 checksum 不一致"
make_sandbox
cat > "${SANDBOX}/bin/sha256sum" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == "--check" || "$arg" == "-c" ]]; then
    echo "sha256sum: CHECKSUM MISMATCH (stub)" >&2
    exit 1
  fi
done
echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  fake"
exit 0
STUB
chmod +x "${SANDBOX}/bin/sha256sum"
out="$(run_backup)"; rc=$?
assert_eq 1 "$rc" "场景6 checksum 验证失败应 exit 1"
json="$(status_json)"
assert_contains '"status":"failed"' "$json"
assert_contains '"stage":"checksum"' "$json"
assert_contains '"checksumVerified":false' "$json"

[[ -n "${SANDBOX}" ]] && rm -rf "${SANDBOX}"

echo "PASS=${PASS} FAIL=${FAIL}"
[[ ${FAIL} -eq 0 ]] || exit 1
exit 0
