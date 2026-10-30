#!/usr/bin/env bash
# Opt-in image acceptance. Requires images built from the current working tree.
# Every service is disposable, uses an internal-only network, and publishes no
# ports. Existing Compose services, databases, volumes, and env files are unused.
set -euo pipefail
export MSYS_NO_PATHCONV=1
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFIX="${OPS_PROOF_IMAGE_PREFIX:-campus-audit-remediation}"
TAG="${OPS_PROOF_IMAGE_TAG:-proof}"
SHA="${OPS_PROOF_EXPECTED_SHA:?Set the exact build-arg SHA used for these test images}"
[[ "${SHA}" =~ ^[a-f0-9]{40}$ ]] || exit 1
MINIO_IMAGE="${OPS_PROOF_MINIO_IMAGE:?Set an already available MinIO image/digest}"
MC_IMAGE="${OPS_PROOF_MC_IMAGE:-minio/mc:RELEASE.2025-05-21T01-59-54Z}"
NAME="campus-image-proof-${RANDOM}-$$"
TEMP_DIR="$(mktemp -d)"
PASS=0
PROOF_STAGE="preflight"
cleanup() {
  local rc=$?
  trap - EXIT
  if [[ "${rc}" != 0 ]]; then
    echo "FAIL: isolated image runtime stage=${PROOF_STAGE} rc=${rc}" >&2
    for log in "${TEMP_DIR}"/*; do [[ ! -f "${log}" ]] || { echo "--- $(basename "${log}")"; tail -25 "${log}"; }; done
  fi
  docker rm -fv "${NAME}-async-a" "${NAME}-async-b" "${NAME}-app" "${NAME}-db" "${NAME}-redis" "${NAME}-minio" >/dev/null 2>&1 || true
  docker network rm "${NAME}" >/dev/null 2>&1 || true
  rm -rf "${TEMP_DIR}"
  exit "${rc}"
}
trap cleanup EXIT
for kind in app async cleanup ops migrator; do docker image inspect "${PREFIX}-${kind}:${TAG}" >/dev/null; done
PROOF_STAGE="network-create"
docker network create --internal "${NAME}" >/dev/null
PROOF_STAGE="postgres-start"
docker run -d --pull never --name "${NAME}-db" --network "${NAME}" --network-alias postgres \
  --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=proof -e POSTGRES_PASSWORD=ProofLocalOnly-Password1 \
  -e POSTGRES_DB=proofdb postgres:16-alpine >/dev/null
PROOF_STAGE="redis-start"
docker run -d --pull never --name "${NAME}-redis" --network "${NAME}" --network-alias redis \
  redis:7-alpine redis-server --requirepass ProofLocalOnly-Redis1 >/dev/null
PROOF_STAGE="minio-start"
docker run -d --pull never --name "${NAME}-minio" --network "${NAME}" --network-alias minio \
  --tmpfs /data -e MINIO_ROOT_USER=proof-storage-admin -e MINIO_ROOT_PASSWORD=ProofLocalOnly-Storage1 \
  "${MINIO_IMAGE}" server /data >/dev/null
for _ in $(seq 1 40); do
  if docker exec "${NAME}-db" pg_isready -U proof -d proofdb >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "${NAME}-db" pg_isready -U proof -d proofdb >/dev/null
for _ in $(seq 1 40); do
  if docker run --rm --pull never --network "${NAME}" --entrypoint /bin/sh "${MC_IMAGE}" -c \
    'mc alias set proof http://minio:9000 proof-storage-admin ProofLocalOnly-Storage1 >/dev/null && mc mb --ignore-existing proof/campus-public proof/campus-private >/dev/null' > "${TEMP_DIR}/storage" 2>&1; then break; fi
  sleep 1
done
if grep -q '<ERROR>' "${TEMP_DIR}/storage"; then cat "${TEMP_DIR}/storage"; exit 1; fi

PROOF_STAGE="storage-bootstrap"
ENVFILE="${REPO_ROOT}/.env.production.synthetic"
if command -v cygpath >/dev/null 2>&1; then ENVFILE="$(cygpath -m "${ENVFILE}")"; fi
ENV_ARGS=(--env-file "${ENVFILE}"
  -e 'DATABASE_URL=postgresql://proof:ProofLocalOnly-Password1@postgres:5432/proofdb?schema=public'
  -e 'REDIS_URL=redis://:ProofLocalOnly-Redis1@redis:6379'
  -e S3_ENDPOINT=http://minio:9000 -e S3_ACCESS_KEY_ID=proof-storage-admin
  -e S3_SECRET_ACCESS_KEY=ProofLocalOnly-Storage1 -e ALLOW_LOCAL_S3_IN_PRODUCTION=false
  -e RELEASE_SHA=runtime-spoof -e BACKUP_DIR=/backups)
PROOF_STAGE="migration"
docker run --rm --pull never --network "${NAME}" "${ENV_ARGS[@]}" "${PREFIX}-migrator:${TAG}" > "${TEMP_DIR}/migration" 2>&1
PASS=$((PASS+1))
for kind in async cleanup; do
  docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "${PREFIX}-${kind}:${TAG}" -e '
      const fs=require("node:fs"); if(process.getuid()===0)throw Error("root");
      for(const p of ["prisma","tsx","vitest","next","@prisma/config","deepmerge-ts"])
        if(fs.existsSync("/app/node_modules/"+p))throw Error("unexpected "+p);
      try {fs.writeFileSync("/app/.release-sha","tamper"); throw Error("writable metadata");}
      catch(e){if(!["EROFS","EACCES"].includes(e.code))throw e;}
      require("@prisma/client"); require("sharp"); console.log("runtime uid="+process.getuid()+" dependencies=PASS");'
  PASS=$((PASS+1))
  args=(--run-once)
  [[ "${kind}" != cleanup ]] || args+=(--dry-run)
  docker run --rm --pull never --network "${NAME}" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --cap-drop ALL --security-opt no-new-privileges "${ENV_ARGS[@]}" "${PREFIX}-${kind}:${TAG}" "${args[@]}" > "${TEMP_DIR}/${kind}" 2>&1
  grep -q '"release":"'"${SHA}"'"' "${TEMP_DIR}/${kind}"
  ! grep -q 'runtime-spoof\|MODULE_NOT_FOUND\|cycle_failed' "${TEMP_DIR}/${kind}"
  PASS=$((PASS+1))
done
# Real concurrent CJS workers exercise shared DB leases and terminal replay.
source "${REPO_ROOT}/tests/ops/worker-concurrent-image-proof.sh"
# Actual PRODUCT expiry -> transactional outbox -> two deduped notifications.
source "${REPO_ROOT}/tests/ops/worker-business-image-proof.sh"
# Ops checker must observe dependencies without manufacturing backup readiness.
docker run --rm --pull never --network "${NAME}" "${ENV_ARGS[@]}" "${PREFIX}-ops:${TAG}" --mode ci > "${TEMP_DIR}/ops-ci" 2>&1
grep -q '"result":"PASS"' "${TEMP_DIR}/ops-ci"
PASS=$((PASS+1))
if docker run --rm --pull never --network "${NAME}" "${ENV_ARGS[@]}" "${PREFIX}-ops:${TAG}" --mode production > "${TEMP_DIR}/ops-prod" 2>&1; then
  echo 'FAIL: production ops checker accepted absent offsite backup'; exit 1
fi
grep -q 'backup_health' "${TEMP_DIR}/ops-prod"
PASS=$((PASS+1))

docker run -d --pull never --name "${NAME}-app" --network "${NAME}" "${ENV_ARGS[@]}" "${PREFIX}-app:${TAG}" >/dev/null
for _ in $(seq 1 40); do
  if docker exec "${NAME}-app" node -e 'fetch("http://127.0.0.1:3000/api/health").then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))' > "${TEMP_DIR}/health" 2>/dev/null; then break; fi
  sleep 1
done
if ! grep -q '"release":"'"${SHA}"'"' "${TEMP_DIR}/health"; then docker logs "${NAME}-app"; cat "${TEMP_DIR}/health"; exit 1; fi
PASS=$((PASS+1))
for kind in app async cleanup ops; do
  if docker run --rm --pull never --network none --mount type=tmpfs,destination=/app \
    -e RELEASE_SHA=runtime-spoof "${PREFIX}-${kind}:${TAG}" > "${TEMP_DIR}/missing" 2>&1; then
    echo "FAIL: ${kind} accepted missing release metadata"; exit 1
  fi
  grep -q '/app/.release-sha' "${TEMP_DIR}/missing"
  PASS=$((PASS+1))
done
echo "PASS=${PASS} FAIL=0 (isolated Docker image acceptance; not production evidence)"
