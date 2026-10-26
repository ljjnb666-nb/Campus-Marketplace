#!/usr/bin/env bash
# Download the newest dump from a read-only offsite role, then restore only into
# a separately configured Compose project. No production writer is stopped.
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
if [[ -z "${OPS_PROJECT_DIR:-}" || ! -d "${OPS_PROJECT_DIR}" ]]; then
  echo "[offsite-drill][FAIL] an isolated OPS_PROJECT_DIR is required" >&2; exit 1
fi
if [[ "$(cd "${OPS_PROJECT_DIR}" && pwd -P)" == "$(cd "${SOURCE_ROOT}" && pwd -P)" ]]; then
  echo "[offsite-drill][FAIL] production checkout cannot be the restore target" >&2; exit 1
fi
source "${SCRIPT_DIR}/lib.sh"
load_production_env
PROJECT_NAME="$(compose_run config --format json | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.parse(s).name??""))')"
if [[ ! "${PROJECT_NAME}" =~ ^campus-restore-drill-[a-z0-9-]+$ ]]; then
  echo "[offsite-drill][FAIL] target Compose name must start campus-restore-drill-" >&2; exit 1
fi
URI="${DRILL_OFFSITE_PREFIX:-}"
if [[ ! "${URI}" =~ ^s3://([a-z0-9.-]+)/(.+)$ ]]; then
  echo "[offsite-drill][FAIL] DRILL_OFFSITE_PREFIX must be s3://bucket/prefix" >&2; exit 1
fi
BUCKET="${BASH_REMATCH[1]}"
PREFIX="${BASH_REMATCH[2]%/}/"
MAX_AGE_HOURS="${DRILL_MAX_BACKUP_AGE_HOURS:-26}"
[[ "${MAX_AGE_HOURS}" =~ ^[1-9][0-9]*$ ]] || exit 1
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT
aws s3api list-objects-v2 --bucket "${BUCKET}" --prefix "${PREFIX}" \
  --query 'sort_by(Contents[?ends_with(Key, `.dump`)], &LastModified)[-1].[Key,LastModified]' \
  --output json > "${TEMP_DIR}/latest.json"
KEY="$(node -e 'const fs=require("node:fs"); const [key,at]=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const age=Date.now()-Date.parse(at); if(typeof key!=="string"||!key.startsWith(process.argv[2])||!key.endsWith(".dump")||!Number.isFinite(age)||age<0||age>Number(process.argv[3])*3600000) process.exit(1); process.stdout.write(key);' "${TEMP_DIR}/latest.json" "${PREFIX}" "${MAX_AGE_HOURS}")"
aws s3 cp "s3://${BUCKET}/${KEY}" "${TEMP_DIR}/offsite.dump"
aws s3 cp "s3://${BUCKET}/${KEY}.sha256" "${TEMP_DIR}/offsite.dump.sha256"
bash "${SCRIPT_DIR}/restore-drill.sh" "${TEMP_DIR}/offsite.dump"
