import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";

// Phase 9C-02（ERRAND DEADLINE SCHEDULED EXPIRY）集成测试（真实 PostgreSQL）。
//
// 覆盖（任务书 §14-§18/§24/§25）：
//   - canonical expiry authority：handler 绝不自持状态机，只 wake up →
//     expireErrandDeadlineTx（锁序 = publisher governance lock → ErrandTask
//     FOR UPDATE → fresh 谓词 → active order 校验 → 条件写）
//   - OPEN → CANCELLED materialization（不新增 EXPIRED enum）
//   - NOT_OPEN / MISSING → COMPLETED_IDEMPOTENT（既有 obligation 不动）
//   - NOT_DUE → RESCHEDULE 到锁内 fresh 权威 deadline（one-shot stale-
//     schedule 防御，不是 recurrence）
//   - STRUCTURAL_INVALID（OPEN + active order / OPEN + accepter）→
//     PERMANENT → DEAD_LETTER，domain 零 mutation
//   - claim ∥ expiry 真实并发线性化（advisory-lock waiter barrier，零 sleep）：
//     Direction A expiry wins → claim fresh 非 OPEN → 零新义务；
//     Direction B claim wins → expiry NOT_OPEN → canonical pair 合法
//
// 生产执行路径：EXP 系列经真实 runAsyncJobBatchOnce（claim SKIP LOCKED →
// execution fencing → handler → completion marker），job 经生产写边界
// enqueueAsyncJobTx 落盘（contract 校验 + canonical payload）。

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

const RUN_TAG = `p9c02e-${randomUUID().slice(0, 8)}`;
const ERRAND_DEDUPE_PREFIX = "ERRAND_DEADLINE_EXPIRE";

let campusId = "";
let errandCategoryId = "";

const userIds: string[] = [];
const errandIds: string[] = [];
const orderIds: string[] = [];
const jobIds: string[] = [];

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

async function createErrandFixture(input: {
  publisherId: string;
  title: string;
  status?: "OPEN" | "CLAIMED";
  accepterId?: string | null;
  deadlineOffsetMs?: number;
}) {
  const errand = await rawClient!.errandTask.create({
    data: {
      title: input.title,
      description: `Phase 9C-02 expiry fixture ${RUN_TAG}`,
      reward: 10,
      pickupLocation: "东门",
      deliveryLocation: "西门",
      deadline: new Date(Date.now() + (input.deadlineOffsetMs ?? 60 * 60 * 1000)),
      categoryId: errandCategoryId,
      campusId,
      publisherId: input.publisherId,
      status: input.status ?? "OPEN",
      accepterId: input.accepterId ?? null,
    },
  });
  errandIds.push(errand.id);
  return errand;
}

async function createErrandOrderFixture(input: {
  publisherId: string;
  accepterId: string;
  errandTaskId: string;
  status?: "PENDING" | "ACCEPTED" | "IN_PROGRESS" | "IN_DISPUTE";
}) {
  const order = await rawClient!.order.create({
    data: {
      orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
      type: "ERRAND",
      status: input.status ?? "ACCEPTED",
      paymentStatus: "OFFLINE_PENDING",
      amount: "10.00",
      buyerId: input.publisherId,
      sellerId: input.accepterId,
      errandTaskId: input.errandTaskId,
    },
  });
  orderIds.push(order.id);
  return order;
}

/** 生产写边界 enqueue（contract 校验 + canonical payload + dedupe 幂等）。 */
async function enqueueExpiryJob(errandId: string, deadline: Date) {
  const { enqueueAsyncJobTx } = await import("@/lib/async/job-repository");
  const { withTransaction } = await import("@/lib/prisma");
  const job = await withTransaction((tx: Prisma.TransactionClient) =>
    enqueueAsyncJobTx(tx, {
      kind: "ERRAND_DEADLINE_EXPIRE",
      schemaVersion: 1,
      dedupeKey: `${ERRAND_DEDUPE_PREFIX}:${errandId}`,
      payload: { errandId },
      runAt: deadline,
    }),
  );
  expect(job.recorded).toBe(true);
  const row = await rawClient!.asyncJob.findUniqueOrThrow({
    where: { dedupeKey: `${ERRAND_DEDUPE_PREFIX}:${errandId}` },
  });
  jobIds.push(row.id);
  return row;
}

async function runWorkerBatch() {
  const { runAsyncJobBatchOnce } = await import("@/lib/async/job-runner");
  return runAsyncJobBatchOnce();
}

/**
 * Review Repair R1：共享 AsyncJob 队列上存在并行测试文件（9A/9B/本文件）
 * 的 due jobs 与 worker 子进程竞争——单次 batch 的 summary 计数不是本
 * fixture 的可靠证据。改为以【本 fixture job 的终态】为断言锚点：有界轮次
 * 内反复跑真实 claim/execute（每轮都是真实工作，零 sleep），直到目标 job
 * 达到期望状态或轮次耗尽（耗尽后返回当前行，由调用方断言失败）。
 */
async function runWorkerBatchesUntil(
  jobId: string,
  expected: (job: { status: string; runAt: Date }) => boolean,
  maxRounds = 15,
) {
  let job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: jobId } });
  for (let round = 0; round < maxRounds; round += 1) {
    if (expected(job)) {
      return job;
    }
    await runWorkerBatch();
    job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: jobId } });
  }
  return job;
}

beforeAll(async () => {
  if (!rawClient) return;

  const campus = await rawClient.campus.upsert({
    where: { slug: `p9c02e-${randomUUID().slice(0, 8)}` },
    create: { name: `9C02E 校区 ${randomUUID().slice(0, 6)}`, slug: `p9c02e-${randomUUID().slice(0, 8)}`, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;

  const errandCategory = await rawClient.errandCategory.create({
    data: { name: `9C02E跑腿类目-${RUN_TAG}`, slug: `p9c02e-err-${RUN_TAG}` },
  });
  errandCategoryId = errandCategory.id;
});

afterAll(async () => {
  if (!rawClient) return;

  // 反向 FK 清理（精确 fixture ID 域；失败即抛——禁止吞错）
  await rawClient.notification.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.riskState.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.asyncJob.deleteMany({ where: { id: { in: jobIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: orderIds } } });
  await rawClient.errandTask.deleteMany({ where: { id: { in: errandIds } } });
  await rawClient.errandCategory.deleteMany({ where: { id: errandCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: userIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 9C-02 errand deadline expiry authority（真实 PostgreSQL）",
  () => {
    it("EXP-01（§14/§16/§17）：due OPEN → 生产 runner → Task CANCELLED + job COMPLETED（canonical pair 无 active order 前提成立）", async () => {
      const publisher = await createFixtureUser("EXP01发布者");
      const errand = await createErrandFixture({
        publisherId: publisher.id,
        title: `EXP01到期任务-${RUN_TAG}`,
        deadlineOffsetMs: -60_000,
      });

      const job = await enqueueExpiryJob(errand.id, errand.deadline);
      expect(job.kind).toBe("ERRAND_DEADLINE_EXPIRE");
      expect(job.schemaVersion).toBe(1);
      expect(job.payload).toEqual({ errandId: errand.id });
      expect(job.dedupeKey).toBe(`${ERRAND_DEDUPE_PREFIX}:${errand.id}`);
      expect(job.runAt.getTime()).toBeLessThanOrEqual(Date.now());

      // 共享队列下以本 fixture job 终态为锚点（有界真实 batch 循环）
      const completed = await runWorkerBatchesUntil(job.id, (j) => j.status === "COMPLETED");

      expect(completed.status).toBe("COMPLETED");
      expect(completed.completedAt).not.toBeNull();
      expect(completed.lastErrorCode).toBeNull();

      const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
      expect(task.status).toBe("CANCELLED");
      expect(task.accepterId).toBeNull();

      // 零新义务：expiry 不产生任何 Order / Notification
      expect(
        await rawClient!.order.count({ where: { type: "ERRAND", errandTaskId: errand.id } }),
      ).toBe(0);
      expect(
        await rawClient!.notification.count({ where: { userId: publisher.id } }),
      ).toBe(0);
    });

    it("EXP-IDEMPOTENT-01（§17）：job 执行前任务已被合法 claim → NOT_OPEN 幂等 COMPLETED，active Order 不动", async () => {
      const publisher = await createFixtureUser("EXPIDEM发布者");
      const accepter = await createFixtureUser("EXPIDEM接单者");
      const errand = await createErrandFixture({
        publisherId: publisher.id,
        title: `EXPIDEM已接单-${RUN_TAG}`,
        status: "CLAIMED",
        accepterId: accepter.id,
        deadlineOffsetMs: -60_000,
      });
      const order = await createErrandOrderFixture({
        publisherId: publisher.id,
        accepterId: accepter.id,
        errandTaskId: errand.id,
      });

      const job = await enqueueExpiryJob(errand.id, errand.deadline);
      // 共享队列下以本 fixture job 终态为锚点（COMPLETED 即幂等 no-op 路径）
      const completed = await runWorkerBatchesUntil(job.id, (j) => j.status === "COMPLETED");

      // canonical pair 原样：CLAIMED ↔ ACCEPTED（deadline 不终止既有履约义务）
      const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
      expect(task.status).toBe("CLAIMED");
      expect(task.accepterId).toBe(accepter.id);
      const persistedOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(persistedOrder.status).toBe("ACCEPTED");

      expect(completed.status).toBe("COMPLETED");
      expect(completed.lastErrorCode).toBeNull();
    });

    it("EXP-NOT-DUE-01（§16/§17）：discovery 后 publisher 合法 edit 延长 deadline → NOT_DUE → RESCHEDULE 到权威新 deadline，绝不 CANCELLED", async () => {
      const publisher = await createFixtureUser("EXPNOTDUE发布者");
      const errand = await createErrandFixture({
        publisherId: publisher.id,
        title: `EXPNOTDUE任务-${RUN_TAG}`,
        deadlineOffsetMs: -60_000,
      });

      const job = await enqueueExpiryJob(errand.id, errand.deadline);

      // discovery 与 handler 锁之间：deadline 被合法 edit 推到未来
      //（TEST-ONLY：模拟已提交的 edit 结果；业务状态零改动）
      const newDeadline = new Date(Date.now() + 60 * 60 * 1000);
      await rawClient!.errandTask.update({
        where: { id: errand.id },
        data: { deadline: newDeadline },
      });

      // 共享队列下以本 fixture job 状态为锚点：NOT_DUE → PENDING + runAt = 权威新 deadline
      const rescheduled = await runWorkerBatchesUntil(
        job.id,
        (j) => j.status === "PENDING" && j.runAt.getTime() === newDeadline.getTime(),
      );

      // 业务事实零写入：Task 仍 OPEN
      const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
      expect(task.status).toBe("OPEN");

      expect(rescheduled.status).toBe("PENDING");
      expect(rescheduled.runAt.getTime()).toBe(newDeadline.getTime());
      expect(rescheduled.lastErrorCode).toBeNull();

      // deadline 真实到达后，同一条 one-shot intent 完成 materialize
      //（TEST-ONLY DEADLINE ADVANCE：domain deadline 与 job.runAt 同步推进，
      // 与 9A advanceDeadlineOnly 同一模式；绝不直接改 Task.status / job.status）
      const advanced = new Date(Date.now() - 1000);
      await rawClient!.errandTask.update({
        where: { id: errand.id },
        data: { deadline: advanced },
      });
      await rawClient!.asyncJob.update({
        where: { id: job.id },
        data: { runAt: advanced },
      });
      const finalJob = await runWorkerBatchesUntil(job.id, (j) => j.status === "COMPLETED");
      const finalTask = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
      expect(finalTask.status).toBe("CANCELLED");
      expect(finalJob.status).toBe("COMPLETED");
    });

    it("EXP-STRUCTURAL-01（§16/§17）：OPEN + active ERRAND Order 异常行 → PERMANENT DEAD_LETTER，domain 零 mutation（fail closed）", async () => {
      const publisher = await createFixtureUser("EXPSTRUCT发布者");
      const accepter = await createFixtureUser("EXPSTRUCT接单者");

      // 异常形态 A：status OPEN 但存在 active ERRAND order（canonical 约束下不可能）
      const anomalousOrder = await createErrandFixture({
        publisherId: publisher.id,
        title: `EXPSTRUCT异常A-${RUN_TAG}`,
        deadlineOffsetMs: -60_000,
      });
      const order = await createErrandOrderFixture({
        publisherId: publisher.id,
        accepterId: accepter.id,
        errandTaskId: anomalousOrder.id,
      });
      const jobA = await enqueueExpiryJob(anomalousOrder.id, anomalousOrder.deadline);

      // 异常形态 B：status OPEN 但 accepterId 非 null
      const anomalousAccepter = await createErrandFixture({
        publisherId: publisher.id,
        title: `EXPSTRUCT异常B-${RUN_TAG}`,
        deadlineOffsetMs: -60_000,
      });
      await rawClient!.errandTask.update({
        where: { id: anomalousAccepter.id },
        data: { accepterId: accepter.id },
      });
      const jobB = await enqueueExpiryJob(anomalousAccepter.id, anomalousAccepter.deadline);

      // 共享队列下以本 fixture jobs 终态为锚点
      const deadA = await runWorkerBatchesUntil(jobA.id, (j) => j.status === "DEAD_LETTER");
      const deadB = await runWorkerBatchesUntil(jobB.id, (j) => j.status === "DEAD_LETTER");

      // fail closed：domain 零 mutation（Task/Order 原样，绝不猜测修复）
      for (const [errandId, dead] of [
        [anomalousOrder.id, deadA],
        [anomalousAccepter.id, deadB],
      ] as const) {
        const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errandId } });
        expect(task.status).toBe("OPEN");
        expect(dead.status).toBe("DEAD_LETTER");
        expect(dead.deadLetteredAt).not.toBeNull();
        expect(dead.lastErrorCode).toBe("ERRAND_DEADLINE_STRUCTURAL_INVALID");
      }
      const persistedOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(persistedOrder.status).toBe("ACCEPTED");
    });

    it("EXP-STRUCTURAL-IN-DISPUTE-01（RB04/§25/§28）：OPEN + IN_DISPUTE ERRAND Order 异常 pair → PERMANENT DEAD_LETTER，domain 零 mutation", async () => {
      const publisher = await createFixtureUser("RB04DISP发布者");
      const accepter = await createFixtureUser("RB04DISP接单者");

      const errand = await createErrandFixture({
        publisherId: publisher.id,
        title: `RB04争议异常-${RUN_TAG}`,
        deadlineOffsetMs: -60_000,
      });
      const order = await createErrandOrderFixture({
        publisherId: publisher.id,
        accepterId: accepter.id,
        errandTaskId: errand.id,
        status: "IN_DISPUTE",
      });
      const job = await enqueueExpiryJob(errand.id, errand.deadline);

      // 共享队列下以本 fixture job 终态为锚点
      const dead = await runWorkerBatchesUntil(job.id, (j) => j.status === "DEAD_LETTER");

      // fail closed：绝不猜测性 CANCELLED（旧 active set 不含 IN_DISPUTE 时
      // 会留下 Task CANCELLED + Order IN_DISPUTE 的错误 structural repair）
      const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
      expect(task.status).toBe("OPEN");
      expect(task.accepterId).toBeNull();
      const persistedOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(persistedOrder.status).toBe("IN_DISPUTE");

      expect(dead.status).toBe("DEAD_LETTER");
      expect(dead.lastErrorCode).toBe("ERRAND_DEADLINE_STRUCTURAL_INVALID");
    });

    it("EXP-STRUCTURAL-PENDING-01（RB04/§26/§28）：OPEN + PENDING ERRAND Order 异常 pair → PERMANENT DEAD_LETTER，domain 零 mutation", async () => {
      const publisher = await createFixtureUser("RB04PEND发布者");
      const accepter = await createFixtureUser("RB04PEND接单者");

      const errand = await createErrandFixture({
        publisherId: publisher.id,
        title: `RB04待处理异常-${RUN_TAG}`,
        deadlineOffsetMs: -60_000,
      });
      const order = await createErrandOrderFixture({
        publisherId: publisher.id,
        accepterId: accepter.id,
        errandTaskId: errand.id,
        status: "PENDING",
      });
      const job = await enqueueExpiryJob(errand.id, errand.deadline);

      // 共享队列下以本 fixture job 终态为锚点
      const dead = await runWorkerBatchesUntil(job.id, (j) => j.status === "DEAD_LETTER");

      // fail closed：「正常流程不应出现」不等于「expiry 可以忽略」
      const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
      expect(task.status).toBe("OPEN");
      const persistedOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(persistedOrder.status).toBe("PENDING");

      expect(dead.status).toBe("DEAD_LETTER");
      expect(dead.lastErrorCode).toBe("ERRAND_DEADLINE_STRUCTURAL_INVALID");
    });

    it("ERRAND-DEADLINE-RACE-01（§18 Direction A）：expiry wins——expiry 持 publisher 锁 + 行锁，claim 在 participant 锁等待；expiry 提交 CANCELLED 后 claim fresh 非 OPEN → 零新义务", async () => {
      const { expireErrandDeadlineTx } = await import("@/lib/errand-lifecycle");
      const { claimErrandTx } = await import("@/lib/order-creation");
      const { withTransaction } = await import("@/lib/prisma");

      const publisher = await createFixtureUser("RACE01发布者");
      const claimer = await createFixtureUser("RACE01接单者");
      const errand = await createErrandFixture({
        publisherId: publisher.id,
        title: `RACE01过期任务-${RUN_TAG}`,
        deadlineOffsetMs: -60_000,
      });

      // T_expiry：publisher 锁 → 行锁 → 确认 overdue OPEN →（barrier）→ 提交
      let signalExpiryLocked!: () => void;
      const expiryLocked = new Promise<void>((resolve) => {
        signalExpiryLocked = resolve;
      });
      let releaseExpiry!: () => void;
      const expiryGate = new Promise<void>((resolve) => {
        releaseExpiry = resolve;
      });
      const expiryPromise = withTransaction((tx: Prisma.TransactionClient) =>
        expireErrandDeadlineTx(tx, errand.id, {
          afterErrandRowLock: async () => {
            signalExpiryLocked();
            await expiryGate;
          },
        }),
      );
      await expiryLocked;

      // T_claim：participant 锁（publisher+claimer sorted）→ 真实阻塞在
      // expiry 持有的 publisher governance 锁上
      const claimPromise = withTransaction((tx: Prisma.TransactionClient) =>
        claimErrandTx(tx, {
          errandId: errand.id,
          publisherId: publisher.id,
          claimerId: claimer.id,
          campusId,
          reward: errand.reward,
        }),
      );
      // 真实锁等待证据（pg_locks ungranted waiter barrier，零 sleep 猜测）
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${publisher.id}`, `USER:${claimer.id}`]);

      releaseExpiry();
      const [expirySettled, claimSettled] = await Promise.allSettled([
        expiryPromise,
        claimPromise,
      ]);
      expect(expirySettled.status).toBe("fulfilled");
      expect(claimSettled.status).toBe("fulfilled");
      if (expirySettled.status === "fulfilled") {
        expect(expirySettled.value).toEqual({ kind: "EXPIRED" });
      }
      if (claimSettled.status === "fulfilled") {
        // expiry 已提交 CANCELLED → claim 锁内 fresh 非 OPEN → DENY
        expect(claimSettled.value).toBeNull();
      }

      const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
      expect(task.status).toBe("CANCELLED");
      expect(task.accepterId).toBeNull();
      expect(
        await rawClient!.order.count({ where: { type: "ERRAND", errandTaskId: errand.id } }),
      ).toBe(0);
      expect(
        await rawClient!.notification.count({ where: { userId: { in: [publisher.id, claimer.id] } } }),
      ).toBe(0);
    });

    it("ERRAND-DEADLINE-RACE-02（§18 Direction B）：claim wins——期限内合法 claim 持锁，expiry 等待；claim 提交 CLAIMED+ACCEPTED 后 expiry NOT_OPEN 幂等", async () => {
      const { expireErrandDeadlineTx } = await import("@/lib/errand-lifecycle");
      const { claimErrandTx } = await import("@/lib/order-creation");
      const { withTransaction } = await import("@/lib/prisma");

      const publisher = await createFixtureUser("RACE02发布者");
      const claimer = await createFixtureUser("RACE02接单者");
      // deadline 在未来（claim 合法；expiry 在 claim 后到达只会 NOT_OPEN）
      const errand = await createErrandFixture({
        publisherId: publisher.id,
        title: `RACE02任务-${RUN_TAG}`,
        deadlineOffsetMs: 60 * 60 * 1000,
      });

      // T_claim：锁内 fresh 校验齐备后挂起（写入前）
      let signalClaimLocked!: () => void;
      const claimLocked = new Promise<void>((resolve) => {
        signalClaimLocked = resolve;
      });
      let releaseClaim!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      const claimPromise = withTransaction((tx: Prisma.TransactionClient) =>
        claimErrandTx(
          tx,
          {
            errandId: errand.id,
            publisherId: publisher.id,
            claimerId: claimer.id,
            campusId,
            reward: errand.reward,
          },
          undefined,
          async () => {
            signalClaimLocked();
            await claimGate;
          },
        ),
      );
      await claimLocked;

      // T_expiry：candidate 发现后阻塞在 claim 持有的 publisher governance 锁
      const expiryPromise = withTransaction((tx: Prisma.TransactionClient) =>
        expireErrandDeadlineTx(tx, errand.id),
      );
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${publisher.id}`, `USER:${claimer.id}`]);

      releaseClaim();
      const [claimSettled, expirySettled] = await Promise.allSettled([
        claimPromise,
        expiryPromise,
      ]);
      expect(claimSettled.status).toBe("fulfilled");
      expect(expirySettled.status).toBe("fulfilled");
      if (claimSettled.status === "fulfilled") {
        expect(claimSettled.value).not.toBeNull();
      }
      if (expirySettled.status === "fulfilled") {
        // claim 已提交 → fresh 非 OPEN → 幂等 no-op
        expect(expirySettled.value).toEqual({ kind: "NOT_OPEN" });
      }

      // canonical pair 合法：CLAIMED ↔ ACCEPTED，零 CANCELLED 双写
      const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
      expect(task.status).toBe("CLAIMED");
      expect(task.accepterId).toBe(claimer.id);
      const orders = await rawClient!.order.findMany({
        where: { type: "ERRAND", errandTaskId: errand.id },
      });
      expect(orders).toHaveLength(1);
      expect(orders[0]!.status).toBe("ACCEPTED");
      if (orders[0]) {
        orderIds.push(orders[0].id);
      }
    });
  },
);
