import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 9C-02（SCHEDULER PRODUCER + WORKER INTEGRATION）集成测试（真实 PG）。
//
// 覆盖（任务书 §10/§11/§13/§26）：
//   - SCHED-01：due OPEN errand 无 expiry job → 一个 scheduler cycle 恰好
//     一条 ERRAND_DEADLINE_EXPIRE@1（payload {errandId}、canonical dedupeKey、
//     runAt = deadline <= now）；再跑一轮 zero duplicate（anti-join）
//   - SCHED-DEDUPE-01：两个 scheduler 并发发现同一 errand → 恰好 1 行
//     AsyncJob，P2002 不外泄（dedupe unique + skipDuplicates）
//   - SCHED-FAIRNESS-01：最老一批 due OPEN 已有 expiry job（未 materialize）
//     时，anti-join discovery 不得造成 head-of-line starvation——后面的
//     未 schedule 候选在同一轮获得 intent
//   - PRODUCTION-WORKER-ERRAND-DEADLINE-01：真实 production entrypoint
//     --run-once 单次 invocation 完成 schedule → enqueue → claim → handler
//     → CANCELLED；复跑零 duplicate job、零二次 mutation、exit 0
//
// 冻结原则（§12）：recurrence 属 scheduler producer / worker cycle；
// AsyncJob 属一次性 durable intent——不存在（测试也不允许构造）无限
// RESCHEDULE 同一行的 forever-recurring job。

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p9c02s-${randomUUID().slice(0, 8)}`;
const ERRAND_DEDUPE_PREFIX = "ERRAND_DEADLINE_EXPIRE";

let campusId = "";
let errandCategoryId = "";

const userIds: string[] = [];
const errandIds: string[] = [];
const jobDedupeKeys: string[] = [];

let fixtureSeq = 0;

async function createFixtureUser(name: string) {
  const seq = fixtureSeq++;
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${seq}-${name}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campusId,
      role: "STUDENT",
      status: "ACTIVE",
    },
  });
  userIds.push(user.id);
  await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId, status: "ACTIVE" },
  });
  return user;
}

async function createDueErrandFixture(input: {
  publisherId: string;
  title: string;
  /** 相对当前的过期深度毫秒（正数 = 越旧）。 */
  overdueMs: number;
}) {
  const errand = await rawClient!.errandTask.create({
    data: {
      title: input.title,
      description: `Phase 9C-02 scheduler fixture ${RUN_TAG}`,
      reward: 10,
      pickupLocation: "东门",
      deliveryLocation: "西门",
      deadline: new Date(Date.now() - input.overdueMs),
      categoryId: errandCategoryId,
      campusId,
      publisherId: input.publisherId,
      status: "OPEN",
      accepterId: null,
    },
  });
  errandIds.push(errand.id);
  return errand;
}

/** 生产写边界 enqueue（canonical 形状 + dedupe 幂等）。 */
async function enqueueExpiryJob(errandId: string, deadline: Date) {
  const { enqueueAsyncJobTx } = await import("@/lib/async/job-repository");
  const { withTransaction } = await import("@/lib/prisma");
  const dedupeKey = `${ERRAND_DEDUPE_PREFIX}:${errandId}`;
  await withTransaction((tx: Prisma.TransactionClient) =>
    enqueueAsyncJobTx(tx, {
      kind: ERRAND_DEDUPE_PREFIX,
      schemaVersion: 1,
      dedupeKey,
      payload: { errandId },
      runAt: deadline,
    }),
  );
  jobDedupeKeys.push(dedupeKey);
  return rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey } });
}

/** rawClient 未扩展实例按仓库签名口径收窄（与生产 prisma 同 API）。 */
function rawClientAsQueueClient() {
  return rawClient as unknown as Prisma.TransactionClient;
}

async function runSchedulerOnce(batchLimit?: number, now?: Date) {
  const { scheduleDueErrandDeadlineJobs } = await import("@/lib/async/errand-deadline-scheduler");
  const input: { batchLimit?: number; now?: Date } = {};
  if (batchLimit !== undefined) {
    input.batchLimit = batchLimit;
  }
  if (now !== undefined) {
    input.now = now;
  }
  return scheduleDueErrandDeadlineJobs(input);
}

/** 真实生产 worker entrypoint 子进程（compose async-worker 服务同一入口）。 */
function runProductionWorkerOnce(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(process.cwd(), "scripts", "ops", "async-worker.ts"),
        "--run-once",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_URL:
            process.env.DATABASE_URL ?? integrationDatabaseUrl ?? "",
          // Review Repair R1：共享 DB 上并行文件持续产生 due jobs——单批
          // 10 的 claim 窗口可能被占满；加宽子进程批量以保住"空队列 +
          // 单次 invocation materialize"冻结合同的可验证性
          ASYNC_WORKER_BATCH_SIZE: "50",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  if (!rawClient) return;

  const campus = await rawClient.campus.upsert({
    where: { slug: `p9c02s-${randomUUID().slice(0, 8)}` },
    create: { name: `9C02S 校区 ${randomUUID().slice(0, 6)}`, slug: `p9c02s-${randomUUID().slice(0, 8)}`, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;

  const errandCategory = await rawClient.errandCategory.create({
    data: { name: `9C02S跑腿类目-${RUN_TAG}`, slug: `p9c02s-err-${RUN_TAG}` },
  });
  errandCategoryId = errandCategory.id;
});

afterAll(async () => {
  if (!rawClient) return;

  // 反向 FK 清理（精确 fixture ID 域；失败即抛——禁止吞错）
  await rawClient.notification.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.riskState.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.asyncJob.deleteMany({ where: { dedupeKey: { in: jobDedupeKeys } } });
  await rawClient.order.deleteMany({ where: { errandTaskId: { in: errandIds } } });
  await rawClient.errandTask.deleteMany({ where: { id: { in: errandIds } } });
  await rawClient.errandCategory.deleteMany({ where: { id: errandCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: userIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 9C-02 errand deadline scheduler producer（真实 PostgreSQL）",
  () => {
    it("SCHED-01（§10）：due OPEN 无 expiry job → 恰好一条 canonical intent（payload/dedupeKey/runAt）；复跑 zero duplicate", async () => {
      const publisher = await createFixtureUser("SCHED01发布者");
      const errand = await createDueErrandFixture({
        publisherId: publisher.id,
        title: `SCHED01到期任务-${RUN_TAG}`,
        overdueMs: 60_000,
      });

      // Review Repair RB03：显式传入 schedulerNow——runAt 必须等于它
      //（queue execution availability），而不是历史 deadline
      const schedulerNow = new Date();
      const first = await runSchedulerOnce(undefined, schedulerNow);
      expect(first.discovered).toBeGreaterThanOrEqual(1);
      expect(first.enqueued).toBeGreaterThanOrEqual(1);

      const jobs = await rawClient!.asyncJob.findMany({
        where: { dedupeKey: `${ERRAND_DEDUPE_PREFIX}:${errand.id}` },
      });
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      jobDedupeKeys.push(job.dedupeKey);
      expect(job.kind).toBe("ERRAND_DEADLINE_EXPIRE");
      expect(job.schemaVersion).toBe(1);
      expect(job.payload).toEqual({ errandId: errand.id });
      expect(job.status).toBe("PENDING");
      expect(job.runAt.getTime()).toBe(schedulerNow.getTime());
      expect(job.runAt.getTime()).toBeLessThanOrEqual(Date.now());

      // 复跑：anti-join 命中既有 intent → zero duplicate
      const before = await rawClient!.asyncJob.count({
        where: { dedupeKey: `${ERRAND_DEDUPE_PREFIX}:${errand.id}` },
      });
      await runSchedulerOnce();
      const after = await rawClient!.asyncJob.count({
        where: { dedupeKey: `${ERRAND_DEDUPE_PREFIX}:${errand.id}` },
      });
      expect(after).toBe(before);
      expect(after).toBe(1);
    });

    it("SCHED-DEDUPE-01（§10/INV-11）：两个 scheduler 并发发现同一 errand → 恰好 1 行 AsyncJob，P2002 不外泄", async () => {
      const publisher = await createFixtureUser("SCHEDDEDUPE发布者");
      const errand = await createDueErrandFixture({
        publisherId: publisher.id,
        title: `SCHEDDEDUPE任务-${RUN_TAG}`,
        overdueMs: 120_000,
      });

      // 两 scheduler 并发扫描同一候选窗口（dedupe unique 兜底）
      const [a, b] = await Promise.all([runSchedulerOnce(), runSchedulerOnce()]);

      expect(a.discovered + b.discovered).toBeGreaterThanOrEqual(1);
      const jobs = await rawClient!.asyncJob.findMany({
        where: { dedupeKey: `${ERRAND_DEDUPE_PREFIX}:${errand.id}` },
      });
      expect(jobs).toHaveLength(1);
      jobDedupeKeys.push(`${ERRAND_DEDUPE_PREFIX}:${errand.id}`);
    });

    it("SCHED-FAIRNESS-01（§11/INV-12）：最老 5 条 due OPEN 已有 intent 时，batchLimit=4 的单轮 discovery 必须让未 schedule 的后续候选获得 job（anti-join 防 HOL starvation）", async () => {
      const publisher = await createFixtureUser("SCHEDFAIR发布者");

      // 9 条 due OPEN，deadline 严格递增（deterministic deadline ASC 序）
      const errands = [];
      for (let i = 1; i <= 9; i += 1) {
        errands.push(
          await createDueErrandFixture({
            publisherId: publisher.id,
            title: `SCHEDFAIR-${i}-${RUN_TAG}`,
            overdueMs: (10 - i) * 60_000, // i 越小越旧
          }),
        );
      }

      // 最老 5 条（i=1..5）已存在 durable expiry intent（PENDING，未 materialize）
      for (const errand of errands.slice(0, 5)) {
        await enqueueExpiryJob(errand.id, errand.deadline);
      }

      // naive "先取前 N 条再 skipDuplicates" 会在 i=1..4 占满 batch=4，
      // i=6..9 永远 starvation；anti-join discovery 必须跳过 i=1..5，
      // 本轮让 i=6..9 恰好获得 intent
      const summary = await runSchedulerOnce(4);
      expect(summary.discovered).toBe(4);
      expect(summary.enqueued).toBe(4);

      for (let i = 1; i <= 9; i += 1) {
        const count = await rawClient!.asyncJob.count({
          where: { dedupeKey: `${ERRAND_DEDUPE_PREFIX}:${errands[i - 1]!.id}` },
        });
        // 每个 errand 生命周期至多一个 canonical expiry intent（INV-10）
        expect(count).toBe(1);
        jobDedupeKeys.push(`${ERRAND_DEDUPE_PREFIX}:${errands[i - 1]!.id}`);
      }

      // 新 intent 恰好落在未 schedule 的 i=6..9（公平性证明）
      const newlyEnqueued = await rawClient!.asyncJob.findMany({
        where: {
          dedupeKey: { in: errands.slice(5).map((errand) => `${ERRAND_DEDUPE_PREFIX}:${errand.id}`) },
          createdAt: { gte: new Date(Date.now() - 60_000) },
        },
        select: { dedupeKey: true, createdAt: true },
      });
      expect(newlyEnqueued).toHaveLength(4);
    });

    it("SCHED-CROSS-KIND-FAIRNESS-01（RB03/§22）：历史 overdue catch-up 的 runAt = schedulerNow，共享队列中已 due 的 PRODUCT / NOTIFICATION jobs 不被 retroactive leapfrog 挤出", async () => {
      const { enqueueAsyncJobTx } = await import("@/lib/async/job-repository");
      const { claimDueAsyncJobs } = await import("@/lib/async/job-repository");
      const { withTransaction } = await import("@/lib/prisma");

      const publisher = await createFixtureUser("CROSSKIND发布者");

      // 12 条历史 overdue OPEN Errand（deadline 远早于既有 due jobs）
      const errands = [];
      for (let i = 1; i <= 12; i += 1) {
        errands.push(
          await createDueErrandFixture({
            publisherId: publisher.id,
            title: `CROSSKIND-${i}-${RUN_TAG}`,
            overdueMs: 10 * 24 * 60 * 60 * 1000, // 10 天前
          }),
        );
      }

      // 共享队列中已 due 的非 Errand jobs：runAt 取 epoch 附近——共享 DB 上
      // 任何其它 fixture 都不会更早，因此它们在任何 worker/claim 的候选序中
      // 恒为最前两位（结构性"最先被消费"，不依赖谁执行 claim）
      const epochFirst = new Date("1970-01-01T00:00:01.000Z");
      const epochSecond = new Date("1970-01-01T00:00:02.000Z");
      await withTransaction((tx: Prisma.TransactionClient) =>
        enqueueAsyncJobTx(tx, {
          kind: "PRODUCT_RESERVATION_EXPIRE",
          schemaVersion: 1,
          dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${RUN_TAG}-crosskind`,
          payload: { orderId: `${RUN_TAG}-crosskind-order` },
          runAt: epochFirst,
        }),
      );
      jobDedupeKeys.push(`PRODUCT_RESERVATION_EXPIRE:${RUN_TAG}-crosskind`);
      await withTransaction((tx: Prisma.TransactionClient) =>
        enqueueAsyncJobTx(tx, {
          kind: "NOTIFICATION_DELIVERY",
          schemaVersion: 1,
          dedupeKey: `NOTIFICATION_DELIVERY:${RUN_TAG}-crosskind`,
          payload: { deliveryId: `${RUN_TAG}-crosskind-delivery` },
          runAt: epochSecond,
        }),
      );
      jobDedupeKeys.push(`NOTIFICATION_DELIVERY:${RUN_TAG}-crosskind`);

      // scheduler catch-up：batchLimit = worker batchSize = 10
      const schedulerNow = new Date();
      const summary = await runSchedulerOnce(10, schedulerNow);
      expect(summary.enqueued).toBe(10);

      // 新 Errand jobs 的 runAt 必须 == schedulerNow（不是 10 天前的历史 deadline）
      const errandJobs = await rawClient!.asyncJob.findMany({
        where: { dedupeKey: { in: errands.slice(0, 10).map((e) => `${ERRAND_DEDUPE_PREFIX}:${e.id}`) } },
      });
      expect(errandJobs).toHaveLength(10);
      for (const job of errandJobs) {
        jobDedupeKeys.push(job.dedupeKey);
        expect(job.runAt.getTime()).toBe(schedulerNow.getTime());
      }

      // 真实共享队列 claim（repository 层，不执行 handler/provider）：
      // catch-up Errand jobs 的 runAt = schedulerNow，结构性晚于两个 epoch
      // 级 pre-existing due jobs——后者的 runAt 小于任何真实 fixture，因此
      // 无论本测试还是并行 worker 子进程先 claim，它们都必然第一批被取出。
      // 断言其终态 != PENDING（已被真实队列消费），即证明 catch-up intent
      // 没有获得 retroactive leapfrog（旧 runAt 语义下 errand jobs 反而
      // 排在它们之前，本断言链在旧实现上失败）。
      // 共享 DB 上并行 claim 的 SKIP LOCKED 可能瞬时跳过被其它事务持锁的
      // 行（该事务回滚时行回到 PENDING）——有界重试（每轮真实 claim，零
      // sleep）直到两个 epoch jobs 均离开 PENDING。
      // batchSize=2（epoch jobs 恒为全局最前两位，claim 不触及其它文件的
      // 候选）；leaseSeconds=5 且每个 claimed 行立即经生产 completeAsyncJob
      // 释放——本测试绝不让 claim 泄漏到共享队列上（否则会以 RUNNING 卡住
      // 并行文件正在竞态的 due jobs）。偶然被并行 worker 抢先 claim 的情
      // 形下 epoch jobs 已非 PENDING，重试环直接通过。
      const { completeAsyncJob } = await import("@/lib/async/job-repository");
      for (let round = 0; round < 10; round += 1) {
        const claimed = await withTransaction((tx: Prisma.TransactionClient) =>
          claimDueAsyncJobs(tx, {
            workerId: `crosskind-${RUN_TAG}`,
            leaseSeconds: 5,
            batchSize: 2,
            now: new Date(schedulerNow.getTime() + 1000),
          }),
        );
        for (const row of claimed) {
          await completeAsyncJob(rawClientAsQueueClient(), {
            id: row.id,
            leaseToken: row.leaseToken,
          });
        }
        const drained = await rawClient!.asyncJob.findMany({
          where: {
            dedupeKey: {
              in: [
                `PRODUCT_RESERVATION_EXPIRE:${RUN_TAG}-crosskind`,
                `NOTIFICATION_DELIVERY:${RUN_TAG}-crosskind`,
              ],
            },
          },
          select: { status: true },
        });
        if (drained.length === 2 && drained.every((job) => job.status !== "PENDING")) {
          break;
        }
      }
      for (const key of [
        `PRODUCT_RESERVATION_EXPIRE:${RUN_TAG}-crosskind`,
        `NOTIFICATION_DELIVERY:${RUN_TAG}-crosskind`,
      ]) {
        const drained = await rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey: key } });
        expect(drained.status).not.toBe("PENDING");
      }
      // claim 留下的 RUNNING fixture rows 由 afterAll 按 dedupeKey 清理
    });

    it("SCHED-CATCHUP-01（RB03/§23）：100 条 overdue OPEN、worker batchSize=10 → 生产等价 scheduler cycle 每轮 enqueue ≤ 10（bounded catch-up）", async () => {
      const publisher = await createFixtureUser("CATCHUP发布者");

      const catchupErrands = [];
      for (let i = 1; i <= 100; i += 1) {
        const errand = await createDueErrandFixture({
          publisherId: publisher.id,
          title: `CATCHUP-${i}-${RUN_TAG}`,
          overdueMs: 60 * 60 * 1000,
        });
        catchupErrands.push(errand);
        jobDedupeKeys.push(`${ERRAND_DEDUPE_PREFIX}:${errand.id}`);
      }
      const catchupKeys = catchupErrands.map((e) => `${ERRAND_DEDUPE_PREFIX}:${e.id}`);
      const countMine = () =>
        rawClient!.asyncJob.count({
          where: { kind: "ERRAND_DEADLINE_EXPIRE", dedupeKey: { in: catchupKeys } },
        });

      // 生产等价 cycle：budget = config.batchSize = 10（每轮 discovery 中
      // 本用例的候选可能只分到部分名额——同文件先前用例遗留的 due 候选
      // 共享同一 budget，断言用 ≤ 表达结构上界）
      const first = await runSchedulerOnce(10);
      expect(first.enqueued).toBeLessThanOrEqual(10);
      expect(await countMine()).toBeLessThanOrEqual(10);

      // 下轮继续有界推进（不一次性灌入 100）
      await runSchedulerOnce(10);
      expect(await countMine()).toBeLessThanOrEqual(20);
    });

    it("PRODUCTION-WORKER-ERRAND-DEADLINE-01（§13/§26/INV-18）：真实 production async-worker --run-once 单次 invocation materialize 过期 OPEN 任务；复跑零 duplicate 零二次 mutation", async () => {
      // 冻结合同 = "空队列 + 恰一个过期 OPEN errand"时单次 --run-once 必须
      // 完成 materialize。本文件前面 SCHED 用例遗留的 fixture job/errand
      //（OPEN+due）会占满 worker batchSize=10 的 claim 窗口并污染 discovery
      // 计数——它们已完成自身断言使命，测试域内先清理（afterAll 兜底再删）。
      await rawClient!.asyncJob.deleteMany({
        where: { dedupeKey: { in: jobDedupeKeys } },
      });
      jobDedupeKeys.length = 0;
      const priorErrandIds = [...errandIds];
      if (priorErrandIds.length > 0) {
        await rawClient!.errandTask.deleteMany({ where: { id: { in: priorErrandIds } } });
      }

      const publisher = await createFixtureUser("PRODWORKER发布者");
      const errand = await createDueErrandFixture({
        publisherId: publisher.id,
        title: `PRODWORKER过期任务-${RUN_TAG}`,
        overdueMs: 60_000,
      });

      // 前置：不直接改 status / 不手工建 job / 不调 handler——
      // 只创建"过期 OPEN 且无 AsyncJob"的 domain 事实
      expect(
        await rawClient!.asyncJob.count({
          where: { dedupeKey: `${ERRAND_DEDUPE_PREFIX}:${errand.id}` },
        }),
      ).toBe(0);

      const first = await runProductionWorkerOnce();
      expect(first.code, `stdout=${first.stdout}\nstderr=${first.stderr}`).toBe(0);
      // scheduler producer 的 machine event（IDs/counts，无用户文本）
      expect(first.stdout).toContain("errand_deadline_scheduler_cycle");

      // 同一 invocation：schedule → enqueue → claim → handler → CANCELLED
      const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
      expect(task.status, `stdout=${first.stdout}\nstderr=${first.stderr}`).toBe("CANCELLED");
      expect(task.accepterId).toBeNull();

      const jobs = await rawClient!.asyncJob.findMany({
        where: { dedupeKey: `${ERRAND_DEDUPE_PREFIX}:${errand.id}` },
      });
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      jobDedupeKeys.push(job.dedupeKey);
      expect(job.status).toBe("COMPLETED");
      expect(job.completedAt).not.toBeNull();
      const firstCompletedAt = job.completedAt!;

      // 复跑：exit 0、zero duplicate job、zero second mutation
      const second = await runProductionWorkerOnce();
      expect(second.code, `stdout=${second.stdout}\nstderr=${second.stderr}`).toBe(0);

      const jobsAfterReplay = await rawClient!.asyncJob.findMany({
        where: { dedupeKey: `${ERRAND_DEDUPE_PREFIX}:${errand.id}` },
      });
      expect(jobsAfterReplay).toHaveLength(1);
      expect(jobsAfterReplay[0]!.id).toBe(job.id);
      expect(jobsAfterReplay[0]!.completedAt!.getTime()).toBe(firstCompletedAt.getTime());
      expect(jobsAfterReplay[0]!.attempts).toBe(1);

      const taskAfterReplay = await rawClient!.errandTask.findUniqueOrThrow({
        where: { id: errand.id },
      });
      expect(taskAfterReplay.status).toBe("CANCELLED");
      expect(
        await rawClient!.order.count({ where: { type: "ERRAND", errandTaskId: errand.id } }),
      ).toBe(0);
    });
  },
);
