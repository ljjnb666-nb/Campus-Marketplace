#!/usr/bin/env node
/**
 * #157 R0B: verify exact-SHA FOUR-image read-only inventory evidence.
 * Metadata/package presence != vulnerability exploitability or runtime call reachability.
 * No credentials, network, external process, or source evaluation.
 */
import { readFileSync } from "node:fs";

function fail(code) {
  process.stderr.write("[prisma-inventory][FAIL] " + code + "\n");
  process.exit(1);
}
const [, , sha, filename] = process.argv;
if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !filename || process.argv.length !== 4) {
  fail("requires exact release SHA and local JSONL path");
}
let source;
try {
  source = readFileSync(filename, "utf8");
} catch {
  fail("cannot read inventory evidence");
}
if (source.length < 40 || source.length > 32768) fail("evidence length invalid");
const lines = source.trimEnd().split("\n");
if (lines.length !== 4) fail("four roles required, no partial evidence");
const roles = [
  ["app", "campus-marketplace-app"],
  ["migrator", "campus-marketplace-migrator"],
  ["storage-cleanup", "campus-marketplace-cleanup"],
  ["async-worker", "campus-marketplace-async-worker"],
];
const packageNames = ["prisma", "@prisma/config", "deepmerge-ts", "@prisma/client"];
const summaries = [];
const imageIds = new Set();
for (let i = 0; i < lines.length; i++) {
  let record;
  try {
    record = JSON.parse(lines[i]);
  } catch {
    fail("invalid JSONL record");
  }
  const [role, tag] = roles[i];
  if (record.releaseSha !== sha || record.role !== role ||
      record.image !== tag + ":" + sha ||
      !/^sha256:[0-9a-f]{64}$/.test(record.imageId ?? "") ||
      !/^[a-zA-Z0-9_:.-]+$/.test(record.defaultRuntimeUser ?? "") ||
      typeof record.installedPackages !== "object" || !record.installedPackages) {
    fail("image identity or metadata mismatch");
  }
  if (imageIds.has(record.imageId)) fail("distinct image roles share an image ID");
  imageIds.add(record.imageId);
  const present = {};
  for (const name of packageNames) {
    const packages = record.installedPackages[name];
    if (!Array.isArray(packages) || packages.length > 2) fail("package list shape invalid");
    const roots = new Set();
    for (const pkg of packages) {
      if (!["/app/node_modules", "/app/.next/standalone/node_modules"].includes(pkg?.root) ||
          typeof pkg.version !== "string" || pkg.version.length > 80 ||
          !/^[a-zA-Z0-9+._-]+$/.test(pkg.version) || roots.has(pkg.root)) {
        fail("package metadata invalid");
      }
      roots.add(pkg.root);
    }
    present[name] = packages.length > 0;
  }
  // A migrator without prisma CLI and config cannot satisfy the existing
  // migration contract. Workers must physically ship Prisma client.
  if (role === "migrator" && (!present.prisma || !present["@prisma/config"])) {
    fail("migration image is missing CLI/config packages");
  }
  if ((role === "storage-cleanup" || role === "async-worker") &&
      !present["@prisma/client"]) {
    fail("worker image is missing runtime Prisma client");
  }
  // This is an inventory anomaly, not a CVE assessment: web standalone
  // must not ship the unused migration CLI or its configuration package.
  if (role === "app" && (present.prisma || present["@prisma/config"])) {
    fail("web standalone unexpectedly contains Prisma CLI/config");
  }
  summaries.push({
    role,
    imageId: record.imageId,
    defaultRuntimeUser: record.defaultRuntimeUser,
    installed: present,
    boundary: role === "app" ? "WEB_STANDALONE"
      : role === "migrator" ? "ONE_SHOT_MIGRATION_CLI"
        : "LONG_RUNNING_WORKER_WITH_FULL_NODE_MODULES",
  });
}
process.stdout.write("[prisma-inventory] PASS four exact-SHA images verified\n");
for (const summary of summaries) {
  process.stdout.write("[prisma-inventory] OBSERVATION " + JSON.stringify(summary) + "\n");
}
process.stdout.write("[prisma-inventory] LIMIT installed package metadata only; NOT a vulnerability reachability, bundle, runtime invocation, or production exploitation verdict\n");
