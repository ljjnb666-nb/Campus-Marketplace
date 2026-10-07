import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Review Repair RB03（§23）：静态契约——生产 async-worker 必须把
// config.batchSize 作为 scheduler producer budget 显式传入（catch-up 预算
// ≤ 本周期可消费规模），且 standalone 默认 limit 与 worker 默认 batchSize
// 同阶（10），杜绝 100 enqueue : 10 consume 的结构性 backlog 放大；
// scheduler 新 intent 的 runAt 使用 schedulerNow（历史 deadline 不进入
// queue 字段，§18 Constraint B）。

describe("Review Repair RB03：errand deadline scheduler budget wiring（静态契约）", () => {
  it("async-worker 每周期以 config.batchSize 作为 producer budget 调用 scheduler", () => {
    const workerSource = readFileSync(
      path.join(process.cwd(), "scripts", "ops", "async-worker.ts"),
      "utf8",
    );
    expect(workerSource).toContain("scheduleDueErrandDeadlineJobs({");
    expect(workerSource).toContain("batchLimit: config.batchSize");
  });

  it("scheduler standalone 默认 batchLimit = 10（与 worker 默认 batchSize 同阶）", () => {
    const schedulerSource = readFileSync(
      path.join(process.cwd(), "src", "lib", "async", "errand-deadline-scheduler.ts"),
      "utf8",
    );
    expect(schedulerSource).toMatch(/const DEFAULT_BATCH_LIMIT = 10;/);
  });

  it("scheduler 新 intent 的 runAt 使用 schedulerNow（历史 deadline 不进入 queue 字段）", () => {
    const schedulerSource = readFileSync(
      path.join(process.cwd(), "src", "lib", "async", "errand-deadline-scheduler.ts"),
      "utf8",
    );
    expect(schedulerSource).toMatch(/runAt: now,/);
    expect(schedulerSource).not.toMatch(/runAt: candidate\.deadline/);
  });

  it("Phase 10B：backfill + projection replay 只消费 errand scheduler 剩余 producer budget", () => {
    const workerSource = readFileSync(
      path.join(process.cwd(), "scripts", "ops", "async-worker.ts"),
      "utf8",
    );
    expect(workerSource).toContain("let producerBudget = config.batchSize");
    expect(workerSource).toContain("producerBudget - scheduled.enqueued");
    expect(workerSource).toContain("backfillCanonicalErrandCompletionEvents({");
    expect(workerSource).toContain("batchLimit: producerBudget");
    expect(workerSource).toContain("producerBudget - backfill.backfilled");
    expect(workerSource).toContain("scheduleUnprojectedDomainEventJobs({");
  });
});
