import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string) {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("Phase 10C-1 architecture guards", () => {
  it("backfill uses trusted creation/completion clocks only", () => {
    const text = source("src/lib/analytics/liquidity-backfill.ts");
    expect(text.includes('"createdAt"')).toBe(true);
    expect(text.includes('"completedAt"')).toBe(true);
    expect(text.includes('"updatedAt"')).toBe(false);
  });

  it("safe-core metric registry has no money source fields", () => {
    const text = source("src/lib/analytics/metric-registry.ts");
    expect(text.includes("finalAmount")).toBe(false);
    expect(text.includes("depositAmount")).toBe(false);
  });

  it("projection version is v2 and worker reuses one producer budget", () => {
    expect(source("src/lib/analytics/projection-contract.ts").includes(
      "ANALYTICS_METRIC_PROJECTION_VERSION = 3",
    )).toBe(true);
    const worker = source("scripts/ops/async-worker.ts");
    expect(worker.includes("let producerBudget = config.batchSize")).toBe(true);
    expect(worker.includes("backfillCanonicalLiquidityFacts({")).toBe(true);
    expect(worker.includes("scheduleUnprojectedDomainEventJobs({")).toBe(true);
  });
});
