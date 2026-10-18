#!/usr/bin/env bash
# Issue #157: read-only runtime proof for four candidate Docker images.
# Run ONLY against isolated candidate images; never connect to a production DB.
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo '[worker-proof][FAIL] expected a full lowercase 40-character source SHA' >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo '[worker-proof][FAIL] docker unavailable' >&2
  exit 2
fi

source_sha="$1"
roles=(
  "app:campus-marketplace-app:node:app"
  "migrator:campus-marketplace-migrator:root:migrator"
  "storage-cleanup:campus-marketplace-cleanup:node:worker"
  "async-worker:campus-marketplace-async-worker:node:worker"
)
# Fail closed before partial identity reports if any of the four images is missing.
for item in "${roles[@]}"; do
  IFS=: read -r role repo expected_user kind <<< "$item"
  image="${repo}:${source_sha}"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    printf '[worker-proof][FAIL] missing exact source image: %s\n' "$role" >&2
    exit 1
  fi
done

for item in "${roles[@]}"; do
  IFS=: read -r role repo expected_user kind <<< "$item"
  image="${repo}:${source_sha}"
  image_id="$(docker image inspect --format '{{.Id}}' "$image")"
  image_user="$(docker image inspect --format '{{.Config.User}}' "$image")"
  image_user="${image_user:-root}"
  if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ || "$image_user" != "$expected_user" ]]; then
    printf '[worker-proof][FAIL] identity mismatch for %s\n' "$role" >&2
    exit 1
  fi
  expected_uid=0
  if [[ "$expected_user" == node ]]; then
    expected_uid=1000
  fi

  # No explicit --user: observes the actual runtime UID selected by the image.
  # No network, writable rootfs, extra capabilities, or production credentials.
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges \
    --env "EXPECTED_UID=${expected_uid}" \
    --env "EXPECTED_ROLE=${role}" \
    --env "EXPECTED_KIND=${kind}" \
    --env "EXPECTED_SHA=${source_sha}" \
    --entrypoint node "$image" -e '
      const fs = require("node:fs");
      const role = process.env.EXPECTED_ROLE;
      const uid = Number(process.env.EXPECTED_UID);
      const kind = process.env.EXPECTED_KIND;
      const sha = process.env.EXPECTED_SHA;
      function fail(message) {
        console.error("[worker-proof][FAIL] " + role + ": " + message);
        process.exit(1);
      }
      if (!process.getuid || process.getuid() !== uid) fail("runtime UID mismatch");
      if (kind === "worker") {
        let actual;
        try {
          actual = fs.readFileSync("/app/.release-sha", "utf8").trim();
          fs.accessSync("/app/node_modules/tsx/dist/cli.mjs", fs.constants.R_OK);
          fs.accessSync("/app/node_modules/@prisma/client/package.json", fs.constants.R_OK);
          require.resolve("@prisma/client");
          // R2: inspect actual immutable worker image, not package-lock alone.
          // Migration CLI/config/deepmerge must be absent, generated client
          // must remain present, and no execution path invokes prisma CLI.
          for (const unused of [
            "/app/node_modules/prisma",
            "/app/node_modules/@prisma/config",
            "/app/node_modules/deepmerge-ts",
          ]) {
            if (fs.existsSync(unused)) fail("unused Prisma CLI dependency in worker runtime");
          }
          fs.accessSync("/app/node_modules/.prisma/client", fs.constants.R_OK);
          // R1F test seams must not be present in ANY shipped worker image.
          for (const proofPath of [
            "/app/scripts/ops/worker-lease-fencing-proof.ts",
            "/app/scripts/ops/worker-lease-fencing-extension.sh",
            "/app/scripts/ops/worker-lock-contention-proof.ts",
            "/app/scripts/ops/worker-lock-contention-extension.sh",
            "/app/scripts/ops/ops-runner-isolated-extension.sh",
            "/app/scripts/ops/prisma7-cli-shadow-extension.sh",
            "/app/scripts/ops/prisma7-client-shadow-extension.sh",
            "/app/scripts/ops/prisma7-extensions-shadow-extension.sh",
          ]) {
            if (fs.existsSync(proofPath)) fail("test-only crash probe leaked into runtime image");
          }
        } catch {
          fail("release metadata, TSX or Prisma client unreadable");
        }
        if (actual !== sha) fail("immutable release SHA mismatch");
      } else if (kind === "app" && process.env.RELEASE_SHA !== sha) {
        fail("web image release SHA mismatch");
      }
      console.log(JSON.stringify({
        result: "PASS", role, uid: process.getuid(),
        releaseVerified: kind === "worker" || kind === "app",
      }));
    '

  if [[ "$kind" == worker ]]; then
    # Prove that the actual tsx executable starts as this image's non-root user,
    # not merely that a package.json entry exists.
    # tsx creates a per-UID IPC directory in /tmp even for --version.
    # Root FS remains read-only; only an isolated, bounded tmpfs is writable.
    # This matches production's writable /tmp without granting /app writes.
    docker run --rm --network none --read-only --cap-drop ALL \
      --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=32m \
      --security-opt no-new-privileges \
      --entrypoint node "$image" node_modules/tsx/dist/cli.mjs --version
  fi
  # Repo-independent, immutable local image evidence. No registry push/pull.
  printf '[worker-proof] PASS role=%s user=%s imageId=%s\n' "$role" "$image_user" "$image_id"
done
