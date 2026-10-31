#!/usr/bin/env bash
# No Docker or real production resources: exercise the exact three entrypoints
# while the same isolated host lifecycle lock is held by another process.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
sandbox="$(mktemp -d)"
trap 'rm -rf -- "${sandbox}"' EXIT
mkdir -p "${sandbox}/bin" "${sandbox}/backups"
printf 'name: campus-ops-test-lifecycle\n' > "${sandbox}/compose.production.yml"
cat > "${sandbox}/.env.production" <<ENV
POSTGRES_USER=postgres
POSTGRES_DB=isolated_lifecycle_proof
BACKUP_DIR=${sandbox}/backups
ENV
cat > "${sandbox}/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf 'UNEXPECTED_DOCKER_CALL\n' >> "${OPS_PROJECT_DIR}/side-effects.log"
exit 1
STUB
chmod 700 "${sandbox}/bin/docker"
printf 'fake-dump\n' > "${sandbox}/backups/proof.dump"
export OPS_PROJECT_DIR="${sandbox}"
export PATH="${sandbox}/bin:${PATH}"
# Keep the lock in the parent shell; each entrypoint must independently fail
# instead of treating its inherited environment as approval.
source "${repo_root}/scripts/ops/lib.sh"
acquire_ops_lifecycle_lock
PASS=0
deny() {
  local label="$1"
  shift
  if "$@" > "${sandbox}/denied.log" 2>&1; then
    echo "[lifecycle-lock][FAIL] ${label} unexpectedly succeeded" >&2
    exit 1
  fi
  if ! grep -Fq "OPS_LIFECYCLE_LOCK_BUSY" "${sandbox}/denied.log"; then
    echo "[lifecycle-lock][FAIL] ${label} did not reject on host lifecycle lock" >&2
    exit 1
  fi
  if [[ -e "${sandbox}/side-effects.log" ]]; then
    echo "[lifecycle-lock][FAIL] ${label} reached Docker while locked" >&2
    exit 1
  fi
  PASS=$((PASS + 1))
}
deny deploy bash "${repo_root}/scripts/ops/deploy.sh"
deny rollback bash "${repo_root}/scripts/ops/rollback.sh" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
deny restore bash "${repo_root}/scripts/ops/restore-production-postgres.sh" \
  --production-restore --backup-file "${sandbox}/backups/proof.dump" \
  --target-db isolated_lifecycle_proof
flock -u "${OPS_LIFECYCLE_LOCK_FD}"
exec {OPS_LIFECYCLE_LOCK_FD}>&-
# A released lock must be independently acquirable by a fresh process.
if ! bash -c 'source "$1"; acquire_ops_lifecycle_lock' _ "${repo_root}/scripts/ops/lib.sh" > "${sandbox}/unlocked.log" 2>&1; then
  echo "[lifecycle-lock][FAIL] released lock remains unavailable" >&2
  exit 1
fi
PASS=$((PASS + 1))
echo "PASS=${PASS} FAIL=0"
