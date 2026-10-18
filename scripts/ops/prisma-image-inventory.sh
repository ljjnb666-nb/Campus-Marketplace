#!/usr/bin/env bash
# Issue #157: read-only installed-package inventory for exact-release production Docker images.
# Never pulls/builds images, starts application entrypoints, or uses production credentials.
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  printf '[prisma-inventory][FAIL] usage: %s <40-character-lowercase-release-sha>\n' "$0" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo '[prisma-inventory][FAIL] docker is required' >&2
  exit 2
fi

release_sha="$1"
images=(
  "app:campus-marketplace-app:${release_sha}"
  "migrator:campus-marketplace-migrator:${release_sha}"
  "storage-cleanup:campus-marketplace-cleanup:${release_sha}"
  "async-worker:campus-marketplace-async-worker:${release_sha}"
)

# Fail closed *before* emitting partial results if any required image is absent.
for item in "${images[@]}"; do
  image="${item#*:}"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    printf '[prisma-inventory][FAIL] missing exact-tag image: %s\n' "$image" >&2
    exit 1
  fi
done

for item in "${images[@]}"; do
  role="${item%%:*}"
  image="${item#*:}"
  image_id="$(docker image inspect --format '{{.Id}}' "$image")"
  if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf '[prisma-inventory][FAIL] invalid local image digest for %s\n' "$image" >&2
    exit 1
  fi

  # Probe is hermetic and read-only. This observes only installed package.json
  # paths, not bundled code, JS reachability, or actual exploitation potential.
  package_json="$(docker run --rm --network none --read-only --user 65534:65534 \
    --entrypoint node "$image" -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const roots = ["/app/node_modules", "/app/.next/standalone/node_modules"];
      const names = ["prisma", "@prisma/config", "deepmerge-ts", "@prisma/client"];
      const packages = {};
      for (const name of names) {
        packages[name] = [];
        for (const root of roots) {
          const filename = path.join(root, name, "package.json");
          if (!fs.existsSync(filename)) continue;
          try {
            const pkg = JSON.parse(fs.readFileSync(filename, "utf8"));
            packages[name].push({ root, version: String(pkg.version || "unknown") });
          } catch (error) {
            console.error("[prisma-inventory][FAIL] cannot read package metadata for " + name);
            process.exit(1);
          }
        }
      }
      process.stdout.write(JSON.stringify(packages));
    ' )" || {
      printf '[prisma-inventory][FAIL] probe failed for %s\n' "$image" >&2
      exit 1
    }
  # Print a JSONL audit observation. role/image/digest are regex/fixed validated.
  printf '{"releaseSha":"%s","role":"%s","image":"%s","imageId":"%s","installedPackages":%s}\n' \
    "$release_sha" "$role" "$image" "$image_id" "$package_json"
done
