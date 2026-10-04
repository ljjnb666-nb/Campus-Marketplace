import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { withE2EAsyncWorkerProtocolLock } from "../e2e/helpers/async-worker-lock";

// Review Repair Round 3 — RB06-LOCK-01：E2E async-worker protocol 互斥锁的
// 跨进程语义自测（真实 PostgreSQL session-level advisory lock）。
//
// 证明（§28）：
//   T1 acquire（持锁）
//   T2 cannot acquire concurrently（短超时 → E2E_ASYNC_WORKER_LOCK_TIMEOUT）
//   T1 release
//   T2 acquires（并在临界区内观察到互斥已解除）
//
// 同一 PG session-level lock 即同一互斥域——Playwright worker 进程之间、
// vitest 与 Playwright 之间竞争同一 key 时语义一致（锁由 DB session 持有，
// 与进程边界无关）。

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!integrationDatabaseUrl)(
  "RB06-LOCK-01：E2E async-worker protocol lock（真实 PostgreSQL session advisory lock）",
  () => {
    it("T1 持锁期间 T2 有界获取必须超时；T1 释放后 T2 可获取", async () => {
      const runId = randomUUID().slice(0, 8);
      const order: string[] = [];

      // T1：获取锁并在临界区内挂起（等待放行信号）
      let signalT1Acquired!: () => void;
      const t1Acquired = new Promise<void>((resolve) => {
        signalT1Acquired = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });

      const t1Promise = withE2EAsyncWorkerProtocolLock(`rb06-t1-${runId}`, async () => {
        order.push("t1-critical-enter");
        signalT1Acquired();
        await t1Gate;
        order.push("t1-critical-exit");
        return "t1-done";
      });

      await t1Acquired;

      // T2：T1 持锁期间的有界获取必须超时（短 timeout，零长等待）
      await expect(
        withE2EAsyncWorkerProtocolLock(
          `rb06-t2-timeout-${runId}`,
          async () => "t2-should-not-run",
          { acquireTimeoutMs: 1_500 },
        ),
      ).rejects.toThrow(/E2E_ASYNC_WORKER_LOCK_TIMEOUT/);
      order.push("t2-timeout-rejected");

      // T1 释放
      releaseT1();
      expect(await t1Promise).toBe("t1-done");

      // T2'（新调用，默认上界）：锁已释放 → 正常获取并进入临界区
      const t2Result = await withE2EAsyncWorkerProtocolLock(`rb06-t2-acquire-${runId}`, async () => {
        order.push("t2-critical-enter");
        return "t2-done";
      });
      expect(t2Result).toBe("t2-done");
      expect(order[0]).toBe("t1-critical-enter");
      expect(order).not.toContain("t2-should-not-run");
      expect(order[order.length - 1]).toBe("t2-critical-enter");
    });

    it("finally 语义：callback 抛错时锁仍被释放（后续获取可立即成功）", async () => {
      const runId = randomUUID().slice(0, 8);

      await expect(
        withE2EAsyncWorkerProtocolLock(`rb06-boom-${runId}`, async () => {
          throw new Error("boom inside critical section");
        }),
      ).rejects.toThrow("boom inside critical section");

      // 若 finally 未释放，下面的获取会等待整个默认上界后超时
      const started = Date.now();
      await withE2EAsyncWorkerProtocolLock(`rb06-after-boom-${runId}`, async () => undefined);
      expect(Date.now() - started).toBeLessThan(30_000);
    });
  },
);
