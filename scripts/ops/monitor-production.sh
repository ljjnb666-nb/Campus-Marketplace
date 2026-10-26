#!/usr/bin/env bash
# Read-only checks against explicitly selected, already-built release artifacts.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
load_production_env
if [[ ! "${OPS_RELEASE_SHA:-}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "[monitor][FAIL] OPS_RELEASE_SHA must identify the deployed release" >&2
  exit 1
fi
docker image inspect "campus-marketplace-ops-check:${OPS_RELEASE_SHA}" >/dev/null
GIT_SHA="${OPS_RELEASE_SHA}" compose_run --profile ops run --rm --no-deps --no-build --pull never ops-check
npx --no-install tsx "${SCRIPT_DIR}/release-readiness-check.ts" \
  --base-url "$(app_url_from_env)" --expected-sha "${OPS_RELEASE_SHA}" --timeout-seconds 30
