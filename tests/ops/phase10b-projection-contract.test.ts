import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function modelBlock(schema: string, model: string): string {
  const start = schema.indexOf(`model ${model} {`);
  if (start < 0) {
    throw new Error(`missing Prisma model: ${model}`);
  }
  const next = schema.indexOf("\nmodel ", start + 7);
  return schema.slice(start, next < 0 ? schema.length : next);
}

describe("Phase 10B architecture invariants", () => {
  it("P10B-ARCH-01: ProjectionReceipt is correctness authority; no watermark or second analytics queue", () => {
    const schema = read("prisma/schema.prisma");
    const migration = read(
      "prisma/migrations/20261007133000_phase10b_projection_metric_foundation/migration.sql",
    );

    expect(schema).toContain("model ProjectionReceipt {");
    expect(schema).toContain("model MetricContribution {");
    expect(schema).not.toMatch(/model\s+ProjectionWatermark\s*{/);
    expect(schema).not.toMatch(/model\s+Analytics(?:Job|Queue)\s*{/);
    expect(migration).not.toMatch(/CREATE TABLE\s+"[^"]*Watermark"/i);
    expect(migration).not.toMatch(/CREATE TABLE\s+"Analytics(?:Job|Queue)"/i);
  });

  it("P10B-ARCH-02: derived projection tables do not copy DomainEvent payload or user provenance", () => {
    const schema = read("prisma/schema.prisma");
    for (const model of ["ProjectionReceipt", "MetricContribution"]) {
      const block = modelBlock(schema, model);
      expect(block).not.toMatch(/\bpayload\b/);
      expect(block).not.toMatch(/\bactorUserId\b/);
      expect(block).not.toMatch(/\bsubjectUserId\b/);
    }
  });

  it("P10B-ARCH-03: projection implementation cannot mutate domain/risk/enforcement authority", () => {
    const source = read("src/lib/analytics/domain-event-projection.ts");
    expect(source).toContain("projectionReceipt.createMany");
    expect(source).toContain("metricContribution.createMany");
    expect(source).not.toMatch(
      /tx\.(?:order|errandTask|product|serviceListing|rentalOrder|riskState|riskFlag|enforcementAction|appeal)\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert)/,
    );
  });

  it("P10B-ARCH-04: production convergence reuses AsyncJob worker and keeps catch-up bounded", () => {
    const worker = read("scripts/ops/async-worker.ts");
    expect(worker).toContain("scheduleUnprojectedDomainEventJobs({");
    expect(worker).toContain("backfillCanonicalErrandCompletionEvents({");
    expect(worker).toContain("runAsyncJobBatchOnce({");
    expect(worker).toContain("let producerBudget = config.batchSize");
  });

  it("P10B-ARCH-05: Prisma client composition cannot depend on the queue-backed DomainEvent writer", () => {
    const prismaSource = read("src/lib/prisma.ts");
    const extensionSource = read(
      "src/lib/domain-events/domain-event-ledger-extension.ts",
    );

    expect(prismaSource).toContain(
      '@/lib/domain-events/domain-event-ledger-extension',
    );
    expect(prismaSource).not.toContain(
      'from "@/lib/domain-events/domain-event"',
    );
    expect(extensionSource).not.toContain("@/lib/async/job-repository");
    expect(extensionSource).not.toContain('from "@/lib/prisma"');
  });
});
