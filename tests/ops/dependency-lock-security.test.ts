import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Issue #155: lockfile-only security evidence, without npm network dependence. */
type LockEntry = { version?: string; integrity?: string; optional?: boolean };
type Lock = { lockfileVersion: number; packages: Record<string, LockEntry> };
type Manifest = { dependencies: Record<string, string>; devDependencies: Record<string, string> };

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as Lock;

function components(version: string): [number, number, number] {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`Invalid locked release: ${version}`);
  }
  return parts as [number, number, number];
}

function atLeast(actual: string, minimum: string): boolean {
  const a = components(actual);
  const m = components(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== m[i]) return a[i] > m[i];
  }
  return true;
}

function locked(name: string): LockEntry {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry?.version) throw new Error(`Missing locked package ${name}`);
  return entry;
}

function hasVerifiedIntegrity(entry: LockEntry): boolean {
  return /^sha512-[A-Za-z0-9+/=]+$/.test(entry.integrity ?? "");
}

describe("Issue #155 dependency lock security gates", () => {
  it("pins matching patched Next.js and eslint-config-next and patched sharp", () => {
    expect(lock.lockfileVersion).toBe(3);
    for (const name of ["next", "eslint-config-next"]) {
      const entry = locked(name);
      expect(atLeast(entry.version!, "16.4.1"), name).toBe(true);
      expect(manifest[name === "next" ? "dependencies" : "devDependencies"][name]).toBe(entry.version);
      expect(hasVerifiedIntegrity(entry), name).toBe(true);
    }
    expect(locked("next").version).toBe(locked("eslint-config-next").version);
    const sharp = locked("sharp");
    expect(atLeast(sharp.version!, "0.35.5")).toBe(true);
    expect(manifest.dependencies.sharp).toBe(sharp.version);
    expect(hasVerifiedIntegrity(sharp)).toBe(true);
  });

  it("retains every compatible brace-expansion major on a patched release", () => {
    const entries = Object.entries(lock.packages).filter(
      ([path]) => path === "node_modules/brace-expansion" || path.endsWith("/node_modules/brace-expansion"),
    );
    // Deduplication can change the number of paths; every installed copy must be patched.
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, entry] of entries) {
      const [major] = components(entry.version ?? "0.0.0");
      const floor = ({ 1: "1.1.21", 2: "2.1.7", 3: "3.0.9", 5: "5.0.12" } as Record<number, string>)[major];
      expect(floor, `Unknown brace-expansion major at ${path}`).toBeDefined();
      expect(atLeast(entry.version!, floor), path).toBe(true);
      expect(hasVerifiedIntegrity(entry), path).toBe(true);
    }
  });

  it("keeps patched production transitive dependencies", () => {
    for (const [name, floor] of [["fast-uri", "3.1.9"], ["zod", "4.6.6"], ["source-map-js", "1.2.2"]]) {
      const entry = locked(name);
      expect(atLeast(entry.version!, floor), name).toBe(true);
      expect(hasVerifiedIntegrity(entry), name).toBe(true);
    }
  });

  it("retains cross-platform SWC and WASM optional-package lock records", () => {
    for (const name of [
      "@next/swc-win32-x64-msvc",
      "@next/swc-darwin-arm64",
      "@next/swc-linux-x64-gnu",
      "@emnapi/core",
      "@emnapi/runtime",
    ]) {
      expect(hasVerifiedIntegrity(locked(name)), name).toBe(true);
    }
  });
});
