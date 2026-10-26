#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "${SANDBOX}"' EXIT
mkdir -p "${SANDBOX}/bin" "${SANDBOX}/backups"
printf 'POSTGRES_USER=test\nPOSTGRES_DB=isolated\nBACKUP_DIR=%s/backups\n' "${SANDBOX}" > "${SANDBOX}/.env.production"
printf 'synthetic dump' > "${SANDBOX}/remote.dump"
sha256sum "${SANDBOX}/remote.dump" > "${SANDBOX}/remote.dump.sha256"
cat > "${SANDBOX}/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$CALLS"
case "$*" in
  *'config --format json'*) printf '{"name":"%s"}\n' "${PROJECT_NAME:-campus-restore-drill-test}";;
  *'pg_restore'*) cat >/dev/null;;
  *'_prisma_migrations'*) echo 1;;
  *'COUNT(*)'*) echo 0;;
esac
exit 0
STUB
cat > "${SANDBOX}/bin/aws" <<'STUB'
#!/usr/bin/env bash
set -eu
echo "aws $*" >> "$CALLS"
if [[ "$1" == s3api ]]; then
  node -e 'console.log(JSON.stringify(["backups/test.dump",process.env.STALE ? "2020-01-01T00:00:00Z" : new Date().toISOString()]))'
elif [[ "$3" == *.sha256 ]]; then cp "${REMOTE}.sha256" "$4"
else cp "${REMOTE}" "$4"
fi
STUB
chmod +x "${SANDBOX}/bin/docker" "${SANDBOX}/bin/aws"
run_case() {
  : > "${SANDBOX}/calls"
  set +e
  env PATH="${SANDBOX}/bin:${PATH}" OPS_PROJECT_DIR="${SANDBOX}" CALLS="${SANDBOX}/calls" REMOTE="${SANDBOX}/remote.dump" \
    DRILL_OFFSITE_PREFIX=s3://example-bucket/backups "$@" \
    bash "${REPO_ROOT}/scripts/ops/restore-offsite-drill.sh" > "${SANDBOX}/out" 2>&1
  RC=$?
  set -e
}
run_case PROJECT_NAME=campus-marketplace-production
[[ "$RC" == 1 ]]
! grep -q '^aws\|CREATE DATABASE' "${SANDBOX}/calls"
run_case STALE=1
[[ "$RC" == 1 ]]
! grep -q 'aws s3 cp\|CREATE DATABASE' "${SANDBOX}/calls"
run_case
if [[ "$RC" != 0 ]]; then cat "${SANDBOX}/out"; exit 1; fi
grep -q 'DRILL PASS' "${SANDBOX}/out"
grep -q 'DROP DATABASE IF EXISTS "restore_drill_' "${SANDBOX}/calls"
printf 'corrupted dump' > "${SANDBOX}/remote.dump"
run_case
[[ "$RC" == 1 ]]
! grep -q 'CREATE DATABASE' "${SANDBOX}/calls"
echo 'PASS=4 FAIL=0'
