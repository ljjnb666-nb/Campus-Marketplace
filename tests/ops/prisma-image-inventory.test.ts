import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(path.join(process.cwd(), "scripts/ops/prisma-image-inventory.sh"), "utf8");

describe("Issue #157 Prisma production-image inventory contract", () => {
  it("requires a full immutable release identifier and four exact-tag production artifacts", () => {
    expect(script).toContain("^[0-9a-f]{40}$");
    for (const tag of [
      "campus-marketplace-app:${release_sha}",
      "campus-marketplace-migrator:${release_sha}",
      "campus-marketplace-cleanup:${release_sha}",
      "campus-marketplace-async-worker:${release_sha}",
    ]) expect(script).toContain(tag);
  });

  it("fails closed when an image is missing and probes without network, writes or default entrypoint", () => {
    expect(script).toContain('docker image inspect "$image"');
    expect(script).toContain("--network none --read-only --user 65534:65534");
    expect(script).toContain('--entrypoint node "$image"');
    expect(script).not.toContain("docker pull");
    expect(script).not.toContain("docker build");
  });

  it("buffers all records and prints nothing if a later container probe fails", () => {
    expect(script).toContain("observations=()");
    expect(script).toContain("observations+=(");
    expect(script).toContain("printf '%s\\n' \"${observations[@]}\"");
  });

  it("records the Docker image default runtime user separately from the restricted probe user", () => {
    expect(script).toContain("{{.Config.User}}");
    expect(script).toContain('runtime_user="${runtime_user:-root}"');
    expect(script).toContain("defaultRuntimeUser");
    expect(script).toContain("invalid runtime user");
    expect(script).toContain("--user 65534:65534");
  });

  it.skipIf(process.platform === "win32")(
    "collects four atomic records with image default users; fails with zero output on final probe error",
    () => {
      const directory = mkdtempSync(path.join(tmpdir(), "prisma-image-inventory-"));
      try {
        const docker = path.join(directory, "docker");
        writeFileSync(docker, String.raw`#!/usr/bin/env bash
set -eu
if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$3" == --format ]]; then
    if [[ "$4" == '{{.Id}}' ]]; then
      printf 'sha256:%064d\n' 0
    elif [[ "$4" == '{{.Config.User}}' ]]; then
      if [[ "$5" == *'campus-marketplace-app:'* ]]; then
        printf 'node\n'
      else
        printf '\n'
      fi
    else
      exit 4
    fi
  fi
  exit 0
fi
if [[ "$1" == run ]]; then
  if [[ "$FAIL_LAST" == 1 && "$*" == *'campus-marketplace-async-worker:'* ]]; then
    exit 7
  fi
  printf '{"prisma":[{"root":"/app/node_modules","version":"6.19.3"}]}'
  exit 0
fi
exit 9
`);
        chmodSync(docker, 0o755);
        const sha = "a".repeat(40);
        const command = (failLast: boolean) => spawnSync(
          "bash", [path.join(process.cwd(), "scripts/ops/prisma-image-inventory.sh"), sha],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: directory + path.delimiter + process.env.PATH,
              FAIL_LAST: failLast ? "1" : "0",
            },
          },
        );
        const success = command(false);
        expect(success.status, success.stderr).toBe(0);
        const records = success.stdout.trim().split("\n").map((line) => JSON.parse(line));
        expect(records).toHaveLength(4);
        expect(records.map((row) => row.role)).toEqual([
          "app", "migrator", "storage-cleanup", "async-worker",
        ]);
        expect(records.map((row) => row.defaultRuntimeUser)).toEqual([
          "node", "root", "root", "root",
        ]);
        for (const record of records) {
          expect(record.releaseSha).toBe(sha);
          expect(record.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(record.installedPackages.prisma[0].version).toBe("6.19.3");
        }
        const failure = command(true);
        expect(failure.status).not.toBe(0);
        expect(failure.stdout).toBe("");
        expect(failure.stderr).toContain("probe failed");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("records Prisma supply-chain packages and explicitly limits its evidence claim", () => {
    for (const name of ["prisma", "@prisma/config", "deepmerge-ts", "@prisma/client"]) {
      expect(script).toContain('"' + name + '"');
    }
    expect(script).toContain("not bundled code, JS reachability");
    expect(script).toContain("installedPackages");
    expect(script).toContain("imageId");
  });
});
