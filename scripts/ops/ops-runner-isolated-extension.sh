#!/usr/bin/env bash
# Issue #157 R2B: ONLY sourced inside the disposable worker-image CI network.
# Tests the actual one-shot ops-runner image from this exact checkout.
# Uses real pg_dump (isolated database), checksum and read-only backup mount.
ops_image="campus-marketplace-ops-check:$sha"
docker image inspect "$ops_image" >/dev/null 2>&1 || {
  echo '[worker-cycle][FAIL] R2B one-shot ops image missing' >&2; exit 1;
}
ops_user="$(docker image inspect --format '{{.Config.User}}' "$ops_image")"
[[ -z "$ops_user" || "$ops_user" == root ]] || {
  echo '[worker-cycle][FAIL] R2B ops default user drift' >&2; exit 1;
}
# Unlike persistent workers, one-shot ops retains CLI/config/merge dependencies
# and root UID for root-restricted backup mounts. Probe immutable image offline.
timeout 30s docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --entrypoint node "$ops_image" -e '
    const fs = require("node:fs");
    if (process.getuid() !== 0) process.exit(2);
    for (const n of ["prisma", "@prisma/config", "deepmerge-ts", "@prisma/client", "tsx"]) {
      if (!fs.existsSync("/app/node_modules/" + n + "/package.json")) process.exit(3);
    }
    console.log("PROOF_R2B_OPS_PACKAGES_PRESENT");
  ' >"$tmp/ops-image.log" 2>&1 || {
    echo '[worker-cycle][FAIL] R2B ops one-shot image execution/CLI restoration' >&2; exit 1;
  }
grep -qFx PROOF_R2B_OPS_PACKAGES_PRESENT "$tmp/ops-image.log" || {
  echo '[worker-cycle][FAIL] R2B ops metadata marker absent' >&2; exit 1;
}

ops_backups="$tmp/ops-backups"
mkdir -m 700 "$ops_backups"
# An ACTUAL PostgreSQL custom-format backup of the disposable database, never
# invented production backup evidence. No dump bytes enter CI logs.
docker exec "$pg" pg_dump -U postgres -d "$database" -Fc >"$ops_backups/synthetic-ci.dump"
test -s "$ops_backups/synthetic-ci.dump" || {
  echo '[worker-cycle][FAIL] R2B actual isolated pg_dump absent' >&2; exit 1;
}
ops_checksum="$(sha256sum "$ops_backups/synthetic-ci.dump" | cut -d ' ' -f 1)"
printf '%s  synthetic-ci.dump\n' "$ops_checksum" >"$ops_backups/synthetic-ci.dump.sha256"
printf '{"status":"success","completedAt":"%s","filename":"synthetic-ci.dump","checksumVerified":true,"offsiteStatus":"not_configured","stage":"complete"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$ops_backups/backup-status.json"
chmod 600 "$ops_backups/"*
ops_before="$(sha256sum "$ops_backups/"* | sha256sum | cut -d ' ' -f 1)"
ops_before_meta="$(sha256sum "$ops_backups/backup-status.json" "$ops_backups/synthetic-ci.dump.sha256" | sha256sum | cut -d ' ' -f 1)"

ops_run() {
  local label="$1"; shift
  local status=0
  timeout --signal=TERM --kill-after=10s 55s docker run --rm \
    --network "$network" --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=32m \
    --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,src=$ops_backups,dst=/backups,readonly" \
    "${worker_env[@]}" \
    -e BACKUP_DIR=/backups -e REDIS_URL= -e RELEASE_SHA="$sha" \
    "$ops_image" "$@" >"$tmp/ops-$label.log" 2>&1 || status=$?
  # Bound all outcomes. An unexpected timeout, kill, or container error is
  # NEVER accepted as an expected negative application-level failure.
  if [[ "$status" == 124 || "$status" == 137 ]]; then
    echo "[worker-cycle][FAIL] R2B ops timeout/kill mode=$label" >&2; exit 1
  fi
  printf '%s' "$status"
}

ops_expect() {
  local label="$1" expected_rc="$2" expected_result="$3" expected_backup="$4" expected_reason="$5"
  local rc
  shift 5
  rc="$(ops_run "$label" "$@")"
  [[ "$rc" == "$expected_rc" ]] || {
    printf '[worker-cycle][FAIL] R2B ops %s exit expected=%s actual=%s\n' "$label" "$expected_rc" "$rc" >&2; exit 1;
  }
  node - "$tmp/ops-$label.log" "$expected_result" "$expected_backup" "$expected_reason" <<'VERIFY_OPS'
const fs = require("node:fs");
const [file, expected, backup, reason] = process.argv.slice(2);
const safeFail = () => { process.stderr.write("[worker-cycle][FAIL] R2B bounded JSON invariant\n"); process.exit(1); };
let items;
try {
  items = fs.readFileSync(file,"utf8").trim().split(/\r?\n/)
    .filter(x => x.trim().startsWith("{")).map(x => JSON.parse(x));
} catch { safeFail(); }
const summary = items.filter(x => x.result === "PASS" || x.result === "FAIL").at(-1);
if (!summary || summary.result !== expected) safeFail();
if (backup !== "NONE") {
  const observation = items.find(x => x.name === "backup_health");
  if (!observation || observation.status !== backup) safeFail();
}
if (reason !== "NONE" && summary.reason !== reason && !summary.failed?.includes(reason)) safeFail();
if (expected === "PASS") {
  for (const n of ["database_connectivity","storage_connectivity","backup_health","release_identity"]) {
    if (items.find(x => x.name === n)?.status !== "pass") safeFail();
  }
  if (items.find(x => x.name === "redis_connectivity")?.status !== "skipped") safeFail();
}
VERIFY_OPS
  printf '[worker-cycle] PASS R2B ops %s expected=%s backup=%s\n' "$label" "$expected_result" "$expected_backup"
}
# Actual database + MinIO + real dump checksum. CI mode deliberately DOES NOT
# claim the production/remote-backup gate is ready (offsite=not_configured).
ops_expect healthy-ci 0 PASS pass NONE --mode ci
# A root user in an isolated read-only container still may not change its
# mounted backup fixture; enforce without printing stack/content.
set +e
timeout 30s docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=bind,src=$ops_backups,dst=/backups,readonly" \
  --entrypoint node "$ops_image" -e \
  'require("node:fs").writeFileSync("/backups/forbidden-write", "1")' \
  >"$tmp/ops-readonly.log" 2>&1
ops_write_rc=$?
set -e
[[ "$ops_write_rc" != 0 && "$ops_write_rc" != 124 && "$ops_write_rc" != 137 ]] || {
  echo '[worker-cycle][FAIL] R2B readonly mount write unexpectedly succeeded' >&2; exit 1;
}
[[ ! -e "$ops_backups/forbidden-write" ]] || {
  echo '[worker-cycle][FAIL] R2B readonly mount modified host data' >&2; exit 1;
}
# Invalid mode and production connectivity-skip attempts are always denied.
ops_expect invalid-mode 1 FAIL NONE INVALID_OPS_MODE --mode prodcution
ops_expect prod-skip 1 FAIL NONE PRODUCTION_CONNECTIVITY_CANNOT_BE_SKIPPED --mode production --skip-connectivity
# Corrupt the ACTUAL dump without updating its checksum. Production backup
# probe must classify backup_health FAIL, never pass or claim readiness; other
# intentionally unconfigured prod env checks may also fail in this synthetic env.
printf 'CI-CORRUPTED' >>"$ops_backups/synthetic-ci.dump"
ops_expect corrupt-prod 1 FAIL fail backup_health --mode production
# Prove the root-owned fixture's status/checksum metadata was unchanged by all
# read-only container runs; only the host's explicit corrupt test changes dump.
ops_after_status="$(sha256sum "$ops_backups/backup-status.json" "$ops_backups/synthetic-ci.dump.sha256" | sha256sum | cut -d ' ' -f 1)"
[[ "$ops_after_status" == "$ops_before_meta" && "$ops_before" =~ ^[0-9a-f]{64}$ ]] || {
  echo '[worker-cycle][FAIL] R2B backup status hash invalid' >&2; exit 1;
}
echo '[worker-cycle] PASS R2B ops real pg_dump+checksum, real DB/S3, readonly root backup, invalid-mode/prod-skip/corrupt failclosed'
