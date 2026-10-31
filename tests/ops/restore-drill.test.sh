#!/usr/bin/env bash
# Exercise the real script using only a temporary directory and PATH Docker stub.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "${SANDBOX}"' EXIT
mkdir -p "${SANDBOX}/bin" "${SANDBOX}/backups"
printf 'POSTGRES_USER=test\nPOSTGRES_DB=production_never_touch\nBACKUP_DIR=%s/backups\n' "${SANDBOX}" > "${SANDBOX}/.env.production"
cat > "${SANDBOX}/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
case "$*" in
  *'CREATE DATABASE'*) [[ "${FAIL_STAGE:-}" != create ]];;
  *'pg_restore'*) cat >/dev/null; [[ "${FAIL_STAGE:-}" != restore ]];;
  *'_prisma_migrations'*) echo 1;;
  *'LEFT JOIN'*) [[ "${FAIL_STAGE:-}" != query ]] || exit 1; echo 0;;
  *'COUNT(*)'*) echo 0;;
  *) exit 0;;
esac
STUB
chmod +x "${SANDBOX}/bin/docker"
DUMP="${SANDBOX}/backups/test.dump"
printf 'synthetic dump' > "${DUMP}"
run_case() {
  : > "${SANDBOX}/calls"
  set +e
  env PATH="${SANDBOX}/bin:${PATH}" OPS_PROJECT_DIR="${SANDBOX}" CALLS="${SANDBOX}/calls" FAIL_STAGE="${1:-}" \
    bash "${REPO_ROOT}/scripts/ops/restore-drill.sh" "${DUMP}" > "${SANDBOX}/output" 2>&1
  RC=$?
  set -e
}
run_case
[[ "$RC" == 1 && ! -s "${SANDBOX}/calls" ]]
printf '%064d  test.dump\n' 0 > "${DUMP}.sha256"
run_case
[[ "$RC" == 1 && ! -s "${SANDBOX}/calls" ]]
sha256sum "${DUMP}" > "${DUMP}.sha256"
run_case
[[ "$RC" == 0 ]]
grep -q 'DRILL PASS' "${SANDBOX}/output"
grep -q 'DROP DATABASE IF EXISTS "restore_drill_' "${SANDBOX}/calls"
! grep -q 'DATABASE.*production_never_touch' "${SANDBOX}/calls"
for failure in restore query; do
  run_case "$failure"
  [[ "$RC" == 1 ]]
  grep -q 'DROP DATABASE IF EXISTS "restore_drill_' "${SANDBOX}/calls"
  ! grep -q 'DRILL PASS' "${SANDBOX}/output"
done
run_case create
[[ "$RC" == 1 ]]
! grep -q 'DROP DATABASE' "${SANDBOX}/calls"
echo 'PASS=6 FAIL=0'
