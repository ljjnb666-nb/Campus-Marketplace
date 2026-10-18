import { readFileSync } from "node:fs";
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

  it("records Prisma supply-chain packages and explicitly limits its evidence claim", () => {
    for (const name of ["prisma", "@prisma/config", "deepmerge-ts", "@prisma/client"]) {
      expect(script).toContain('"' + name + '"');
    }
    expect(script).toContain("not bundled code, JS reachability");
    expect(script).toContain("installedPackages");
    expect(script).toContain("imageId");
  });
});
