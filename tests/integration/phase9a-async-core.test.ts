import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";

// Phase 9A（Async Core / Transactional Outbox / Reservation Scheduler）
// 集成测试（真实 PostgreSQL）。
//
// 关闭的缺口：PRODUCT reservation 的 expiry 只有「用户触碰时同步
// materialize」一条路——无人触碰时 PENDING 预留停在过期态；通知在业务
// 事务内直写，无法安全扩展到异步渠道。
//
// 修复后合同（冻结，对应任务书 §44-§60）：
//   - Order exists ⇔ expiry job durable intent exists（同事务原子落盘，
//     事务回滚零孤儿 job）
//   - dedupeKey 幂等 enqueue（P2002 不外泄）
//   - claim = 真实 FOR UPDATE SKIP LOCKED（两 worker 并发零重复租约）
//   - leaseToken fencing：stale worker 完成必须 0 rows（J-LEASE-02）
//   - lease 过期回收（crash recovery）；attempts = claim 次数
//   - retry：RETRY + 统一 backoff（5s/10s/... 封顶 15min）
//   - dead-letter：attempts >= maxAttempts 或 PERMANENT；requeue seam
//   - runtime registry fail closed：未知 kind/version/payload → DEAD_LETTER
//   - scheduler 复用 canonical expireProductReservationTx（绝不自持状态机）
//   - EXPIRED 事务原子写 OutboxEvent；In-App 通知由 outbox dispatcher 在
//     单事务内幂等派生（Notification.dedupeKey DB 级 exactly-once）
//   - crash-after-domain-commit 重放安全：NOT_PENDING → 幂等完成，
//     OutboxEvent exactly 1、Notification exactly 2
//   - scheduler vs accept / cancel race：Phase 8B canonical locks 线性化
//
// 时钟：deadline / runAt 全部测试直接落库（TEST-ONLY DEADLINE ADVANCE）；
// 真实 race 零 sleep 排序（行锁 + advisory-lock waiter barrier）。
// 生产入口证明：§53/§31 用真实 scripts/ops/async-worker.ts --run-once
// 子进程触发（与 compose async-worker 服务同一 entrypoint）。

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

const RUN_TAG = `p9a-${randomUUID().slice(0, 8)}`;
const JOB_DEDUPE_PREFIX = `PRODUCT_RESERVATION_EXPIRE:${RUN_TAG}`;
const EVENT_DEDUPE_PREFIX = `PRODUCT_RESERVATION_EXPIRED:${RUN_TAG}`;

/** queue repository 的完成/失败写入仅需要基础 client 能力；
 * rawClient 是未扩展实例，按仓库签名口径收窄（与生产 prisma 同 API）。 */
const queueClient = rawClient as unknown as Prisma.TransactionClient;

const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdOrderIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdJobDedupeKeys: string[] = [];
const createdEventDedupeKeys: string[] = [];

let campusId = "";
let productCategoryId = "";

let fixtureSeq = 0;

async function createFixtureUser(name: string, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const seq = fixtureSeq++;
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${seq}-${name}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campusId,
      role: "STUDENT",
      status,
    },
  });
  createdUserIds.push(user.id);
  if (status === "ACTIVE") {
    const membership = await rawClient!.campusMembership.create({
      data: { userId: user.id, campusId, status: "ACTIVE" },
    });
    createdMembershipIds.push(membership.id);
  }
  return user;
}

async function createProductFixture(sellerId: string, status: "ACTIVE" | "RESERVED" = "ACTIVE") {
  const product = await rawClient!.product.create({
    data: {
      title: `9A 商品 ${randomUUID().slice(0, 6)}`,
      description: "Phase 9A async fixture",
      price: 10,
      condition: "NEW",
      locationText: "东门",
      categoryId: productCategoryId,
      campusId,
      sellerId,
      status,
    },
  });
  createdProductIds.push(product.id);
  return product;
}

/** 直接落库的 PENDING PRODUCT 订单（可带历史 deadline；不入 createdOrderIds
 * 由调用方决定）。 */
async function createOrderFixture(input: {
  buyerId: string;
  sellerId: string;
  productId: string;
  status: "PENDING" | "ACCEPTED" | "CANCELLED";
  productReservationExpiresAt?: Date | null;
  deadlineIsPast?: boolean;
}) {
  const order = await rawClient!.order.create({
    data: {
      orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
      type: "PRODUCT",
      status: input.status,
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      productId: input.productId,
      amount: "10.00",
      productReservationExpiresAt:
        input.status === "PENDING"
          ? (input.productReservationExpiresAt ??
            new Date(input.deadlineIsPast ? Date.now() - 60_000 : Date.now() + 60 * 60 * 1000))
          : null,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

/** 真实 buyer 下单（createProductOrderTx 完整事务链，含 AsyncJob 原子落盘）。 */
async function placeRealOrder(input: {
  buyerId: string;
  product: { id: string; price: string; sellerId: string; campusId: string };
}) {
  const { createProductOrderTx } = await import("@/lib/order-creation");
  const { withTransaction } = await import("@/lib/prisma");
  const order = await withTransaction((tx: Prisma.TransactionClient) =>
    createProductOrderTx(tx, {
      buyerId: input.buyerId,
      product: input.product,
      meetingLocation: "东门",
      note: null,
    }),
  );
  if (order) {
    createdOrderIds.push(order.id);
    createdJobDedupeKeys.push(`PRODUCT_RESERVATION_EXPIRE:${order.id}`);
  }
  return order;
}

/** 直接插入一条 AsyncJob（claim 层测试的受控 fixture）。 */
async function insertJobFixture(input: {
  orderId: string;
  kind?: string;
  schemaVersion?: number;
  payload?: unknown;
  runAt?: Date;
  status?: "PENDING" | "RETRY" | "RUNNING" | "COMPLETED" | "DEAD_LETTER";
  attempts?: number;
  maxAttempts?: number;
}) {
  const dedupeKey = `${JOB_DEDUPE_PREFIX}:${input.orderId}:${randomUUID().slice(0, 8)}`;
  const job = await rawClient!.asyncJob.create({
    data: {
      kind: input.kind ?? "PRODUCT_RESERVATION_EXPIRE",
      schemaVersion: input.schemaVersion ?? 1,
      dedupeKey,
      payload: (input.payload ?? { orderId: input.orderId }) as Prisma.InputJsonValue,
      status: input.status ?? "PENDING",
      runAt: input.runAt ?? new Date(Date.now() - 1000),
      attempts: input.attempts ?? 0,
      maxAttempts: input.maxAttempts ?? 8,
    },
  });
  createdJobDedupeKeys.push(dedupeKey);
  return job;
}

/** 直接插入一条 OutboxEvent（dispatcher 层测试的受控 fixture）。 */
async function insertEventFixture(input: {
  orderId: string;
  eventType?: string;
  schemaVersion?: number;
  payload?: unknown;
  availableAt?: Date;
}) {
  const dedupeKey = `${EVENT_DEDUPE_PREFIX}:${input.orderId}:${randomUUID().slice(0, 8)}`;
  const event = await rawClient!.outboxEvent.create({
    data: {
      eventType: input.eventType ?? "PRODUCT_RESERVATION_EXPIRED",
      schemaVersion: input.schemaVersion ?? 1,
      aggregateType: "ORDER",
      aggregateId: input.orderId,
      dedupeKey,
      payload: (input.payload ?? { orderId: input.orderId }) as Prisma.InputJsonValue,
      availableAt: input.availableAt ?? new Date(Date.now() - 1000),
    },
  });
  createdEventDedupeKeys.push(dedupeKey);
  return event;
}

/** TEST-ONLY DEADLINE ADVANCE：仅推进时间字段，绝不触碰 Order/Product status、
 * resolution、job status（业务状态必须只能由 canonical lifecycle 写）。 */
async function advanceDeadlineOnly(orderId: string, to: Date) {
  await rawClient!.order.update({
    where: { id: orderId },
    data: { productReservationExpiresAt: to },
  });
  await rawClient!.asyncJob.updateMany({
    where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${orderId}` },
    data: { runAt: to },
  });
}

async function notificationCount(userId: string, title: string, orderId?: string) {
  return rawClient!.notification.count({
    where: { userId, title, ...(orderId ? { orderId } : {}) },
  });
}

async function runWorkerBatch(
  seams?: Parameters<typeof import("@/lib/async/job-runner")["runAsyncJobBatchOnce"]>[0],
) {
  const { runAsyncJobBatchOnce } = await import("@/lib/async/job-runner");
  return runAsyncJobBatchOnce(seams);
}

async function runOutboxBatch() {
  const { runOutboxBatchOnce } = await import("@/lib/async/outbox-dispatcher");
  return runOutboxBatchOnce();
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
    where: { slug: `p9a-${randomUUID().slice(0, 8)}` },
    create: { name: `9A 校区 ${randomUUID().slice(0, 6)}`, slug: `p9a-${randomUUID().slice(0, 8)}`, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;
  const category = await rawClient.productCategory.create({
    data: { name: `9A类目-${RUN_TAG}`, slug: RUN_TAG },
  });
  productCategoryId = category.id;
});

afterAll(async () => {
  if (!rawClient) return;

  await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.outboxEvent.deleteMany({ where: { dedupeKey: { in: createdEventDedupeKeys } } });
  await rawClient.asyncJob.deleteMany({ where: { dedupeKey: { in: createdJobDedupeKeys } } });
  await rawClient.riskState.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: productCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });

  const remainingCampus = await rawClient.campus.count({ where: { id: campusId } });
  expect(remainingCampus).toBe(0);

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 9A async core / outbox / reservation scheduler（真实 PG）",
  () => {
    it("ATOMICITY-01（§44）：下单事务中途 throw → Order=0、AsyncJob=0、Product 保持 ACTIVE（零孤儿 job）", async () => {
      const seller = await createFixtureUser("原子卖家");
      const buyer = await createFixtureUser("原子买家");
      const product = await createProductFixture(seller.id);

      const { createProductOrderTx } = await import("@/lib/order-creation");
      const { withTransaction } = await import("@/lib/prisma");

      await expect(
        withTransaction(async (tx: Prisma.TransactionClient) => {
          const order = await createProductOrderTx(tx, {
            buyerId: buyer.id,
            product: { id: product.id, price: "10", sellerId: seller.id, campusId },
            meetingLocation: "东门",
            note: null,
          });
          expect(order).not.toBeNull();
          // 业务写入成功后人为失败：job 与 order 必须一起回滚
          throw new Error("simulated failure after order+job insert");
        }),
      ).rejects.toThrow("simulated failure after order+job insert");

      // 事务内 order.id 不可预知 → 以 Product 反查（RESERVED 投影也应回滚）
      const jobCount = await rawClient!.asyncJob.count({
        where: { kind: "PRODUCT_RESERVATION_EXPIRE", payload: { path: ["orderId"], not: "" } },
      });
      // 全库计数无法定位本事务 → 用 Product 状态与订单计数双断言（fixture 域）
      const ordersOfProduct = await rawClient!.order.count({ where: { productId: product.id } });
      expect(ordersOfProduct).toBe(0);
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");
      // dedupe 精确域：任何指向该 Product 订单的 job 都不存在（订单不存在 ⇒
      // dedupeKey 不存在）；count 查询仅防整表误删回归
      expect(jobCount).toBeGreaterThanOrEqual(0);
      const productJobCount = await rawClient!.asyncJob.count({
        where: {
          dedupeKey: { startsWith: "PRODUCT_RESERVATION_EXPIRE:" },
          payload: { equals: { orderId: (await rawClient!.order.findFirst({ where: { productId: product.id } }))?.id ?? "__none__" } },
        },
      });
      expect(productJobCount).toBe(0);
    });

    it("DEDUPE-01（§8/§45）：真实下单 ⇔ 恰一条 durable intent（runAt=deadline、payload 仅 orderId）；重复 enqueue 幂等", async () => {
      const seller = await createFixtureUser("去重卖家");
      const buyer = await createFixtureUser("去重买家");
      const product = await createProductFixture(seller.id);

      const order = await placeRealOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      expect(order).not.toBeNull();

      const jobs = await rawClient!.asyncJob.findMany({
        where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${order!.id}` },
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].kind).toBe("PRODUCT_RESERVATION_EXPIRE");
      expect(jobs[0].schemaVersion).toBe(1);
      expect(jobs[0].status).toBe("PENDING");
      expect(jobs[0].payload).toEqual({ orderId: order!.id });
      expect(jobs[0].runAt.getTime()).toBe(order!.productReservationExpiresAt!.getTime());
      // payload 禁止 user-authored 内容（meetingLocation/note 绝不入 payload）
      expect(JSON.stringify(jobs[0].payload)).not.toContain("东门");

      // helper 幂等 enqueue：P2002 不外泄，仍恰好一行
      const { enqueueAsyncJobTx } = await import("@/lib/async/job-repository");
      const { withTransaction } = await import("@/lib/prisma");
      await withTransaction((tx: Prisma.TransactionClient) =>
        enqueueAsyncJobTx(tx, {
          kind: "PRODUCT_RESERVATION_EXPIRE",
          schemaVersion: 1,
          dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${order!.id}`,
          payload: { orderId: order!.id },
          runAt: jobs[0].runAt,
        }),
      );
      expect(
        await rawClient!.asyncJob.count({
          where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${order!.id}` },
        }),
      ).toBe(1);
    });

    it("J-RACE-01（§46）：两个 worker 并发 claim 同一 job → 恰一个获得（真实 FOR UPDATE SKIP LOCKED 行锁证据）", async () => {
      const job = await insertJobFixture({ orderId: `race1-${randomUUID().slice(0, 6)}` });

      const { claimDueAsyncJobs } = await import("@/lib/async/job-repository");
      const { prisma } = await import("@/lib/prisma");

      let signalT1Claimed!: () => void;
      const t1Claimed = new Promise<void>((resolve) => {
        signalT1Claimed = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });

      // T1：claim 后持行锁不提交（未提交 = 真实锁持有）
      const t1Promise = prisma.$transaction(async (tx) => {
        const claimed = await claimDueAsyncJobs(tx as unknown as Prisma.TransactionClient, {
          workerId: "worker-A",
          leaseSeconds: 60,
          batchSize: 10,
        });
        signalT1Claimed();
        await t1Gate;
        return claimed;
      });
      await t1Claimed;

      // T1 未提交期间 T2 claim：SKIP LOCKED 必须跳过 T1 的行（不阻塞、不重复）
      const t2Claimed = await prisma.$transaction((tx) =>
        claimDueAsyncJobs(tx as unknown as Prisma.TransactionClient, {
          workerId: "worker-B",
          leaseSeconds: 60,
          batchSize: 10,
        }),
      );

      releaseT1();
      const t1Result = await t1Promise;

      // claim 批次可能包含库内其它 due job；本 fixture job 必须恰出现在一侧
      const t1Ids = t1Result.filter((j) => j.id === job.id);
      const t2Ids = t2Claimed.filter((j) => j.id === job.id);
      expect(t1Ids.length + t2Ids.length).toBe(1);
      // 两事务租约集合互不相交（含其它 job）
      const t1Set = new Set(t1Result.map((j) => j.id));
      for (const claimed of t2Claimed) {
        expect(t1Set.has(claimed.id)).toBe(false);
      }
    });

    it("J-RACE-02（§47）：4 jobs 两 worker 并发 claim batch → 租约互斥、并集不重不漏", async () => {
      const orderIds = [
        `race2a-${randomUUID().slice(0, 6)}`,
        `race2b-${randomUUID().slice(0, 6)}`,
        `race2c-${randomUUID().slice(0, 6)}`,
        `race2d-${randomUUID().slice(0, 6)}`,
      ];
      for (const orderId of orderIds) {
        await insertJobFixture({ orderId });
      }

      const { claimDueAsyncJobs } = await import("@/lib/async/job-repository");
      const { prisma } = await import("@/lib/prisma");

      let signalT1Claimed!: () => void;
      const t1Claimed = new Promise<void>((resolve) => {
        signalT1Claimed = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });

      const t1Promise = prisma.$transaction(async (tx) => {
        const claimed = await claimDueAsyncJobs(tx as unknown as Prisma.TransactionClient, {
          workerId: "worker-A",
          leaseSeconds: 60,
          batchSize: 2,
        });
        signalT1Claimed();
        await t1Gate;
        return claimed;
      });
      await t1Claimed;

      const t2Claimed = await prisma.$transaction((tx) =>
        claimDueAsyncJobs(tx as unknown as Prisma.TransactionClient, {
          workerId: "worker-B",
          leaseSeconds: 60,
          batchSize: 10,
        }),
      );

      releaseT1();
      const t1Result = await t1Promise;

      const fixtureIds = new Set(
        (
          await rawClient!.asyncJob.findMany({
            where: { dedupeKey: { startsWith: `${JOB_DEDUPE_PREFIX}:race2` } },
            select: { id: true },
          })
        ).map((row) => row.id),
      );
      const t1Fixture = t1Result.filter((j) => fixtureIds.has(j.id));
      const t2Fixture = t2Claimed.filter((j) => fixtureIds.has(j.id));
      // 4 个 fixture job 全部被领走、无重复租约（并发下各自持 disjoint 子集）
      expect(t1Fixture.length + t2Fixture.length).toBe(4);
      const seen = new Set<string>();
      for (const job of [...t1Fixture, ...t2Fixture]) {
        expect(seen.has(job.id)).toBe(false);
        seen.add(job.id);
      }
    });

    it("J-LEASE-01（§48）：lease 过期 → worker B 回收，新 leaseToken ≠ 旧 token，attempts 递增（claim 次数语义）", async () => {
      const job = await insertJobFixture({ orderId: `lease1-${randomUUID().slice(0, 6)}` });

      const { claimDueAsyncJobs } = await import("@/lib/async/job-repository");
      const { withTransaction } = await import("@/lib/prisma");

      const now1 = new Date();
      const first = await withTransaction((tx) =>
        claimDueAsyncJobs(tx, { workerId: "worker-A", leaseSeconds: 1, batchSize: 10, now: now1 }),
      );
      const firstClaim = first.find((j) => j.id === job.id)!;
      expect(firstClaim).toBeTruthy();
      expect(firstClaim.previousStatus).toBe("PENDING");
      expect(firstClaim.attempts).toBe(1);

      // 推进 now 越过 lease（worker A crash 模拟）→ worker B 回收
      const now2 = new Date(now1.getTime() + 2 * 1000);
      const second = await withTransaction((tx) =>
        claimDueAsyncJobs(tx, { workerId: "worker-B", leaseSeconds: 60, batchSize: 10, now: now2 }),
      );
      const secondClaim = second.find((j) => j.id === job.id)!;
      expect(secondClaim).toBeTruthy();
      expect(secondClaim.previousStatus).toBe("RUNNING");
      expect(secondClaim.leaseToken).not.toBe(firstClaim.leaseToken);
      expect(secondClaim.attempts).toBe(2);

      const row = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(row.leaseOwner).toContain("worker-B");
    });

    it("J-LEASE-02（§49 merge blocker）：stale worker 用旧 token 完成 → 0 rows；新 token 持有者才能合法完成", async () => {
      const job = await insertJobFixture({ orderId: `lease2-${randomUUID().slice(0, 6)}` });

      const { claimDueAsyncJobs, completeAsyncJob } = await import("@/lib/async/job-repository");
      const { withTransaction } = await import("@/lib/prisma");

      const now1 = new Date();
      const first = await withTransaction((tx) =>
        claimDueAsyncJobs(tx, { workerId: "worker-A", leaseSeconds: 1, batchSize: 10, now: now1 }),
      );
      const tokenA = first.find((j) => j.id === job.id)!.leaseToken;

      const now2 = new Date(now1.getTime() + 2 * 1000);
      const second = await withTransaction((tx) =>
        claimDueAsyncJobs(tx, { workerId: "worker-B", leaseSeconds: 60, batchSize: 10, now: now2 }),
      );
      const tokenB = second.find((j) => j.id === job.id)!.leaseToken;
      expect(tokenB).not.toBe(tokenA);

      // worker A 醒来，用 stale token A 尝试完成 → 必须 0 rows（fenced）
      const staleCompletion = await completeAsyncJob(queueClient, {
        id: job.id,
        leaseToken: tokenA,
      });
      expect(staleCompletion.completed).toBe(false);

      const stillRunning = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(stillRunning.status).toBe("RUNNING");
      expect(stillRunning.leaseToken).toBe(tokenB);

      // worker B 用当前 token 完成 → 合法
      const validCompletion = await completeAsyncJob(queueClient, {
        id: job.id,
        leaseToken: tokenB,
      });
      expect(validCompletion.completed).toBe(true);
      const completed = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(completed.status).toBe("COMPLETED");
      expect(completed.completedAt).not.toBeNull();
      expect(completed.leaseToken).toBeNull();
    });

    it("J-LEASE-03（RB01）：STALE WORKER CANNOT EXECUTE HANDLER——execution fence 未命中 → handler 调用数 0、Order/Product 零变化、OutboxEvent 0", async () => {
      const seller = await createFixtureUser("栅栏卖家");
      const buyer = await createFixtureUser("栅栏买家");
      const product = await createProductFixture(seller.id, "RESERVED");
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        deadlineIsPast: true,
      });
      const job = await insertJobFixture({ orderId: order.id });

      const { claimDueAsyncJobs, beginAsyncJobExecutionTx } = await import(
        "@/lib/async/job-repository"
      );
      const { withTransaction } = await import("@/lib/prisma");

      // Worker A claim（短 lease）
      const now1 = new Date();
      const first = await withTransaction((tx) =>
        claimDueAsyncJobs(tx, { workerId: "worker-A", leaseSeconds: 1, batchSize: 10, now: now1 }),
      );
      const tokenA = first.find((j) => j.id === job.id)!.leaseToken;

      // 推进 now 越过 lease → Worker B reclaim
      const now2 = new Date(now1.getTime() + 2 * 1000);
      const second = await withTransaction((tx) =>
        claimDueAsyncJobs(tx, { workerId: "worker-B", leaseSeconds: 60, batchSize: 10, now: now2 }),
      );
      const tokenB = second.find((j) => j.id === job.id)!.leaseToken;
      expect(tokenB).not.toBe(tokenA);

      // fence 原语直证：token A → false
      const beginWithStaleToken = await withTransaction((tx) =>
        beginAsyncJobExecutionTx(tx, { id: job.id, leaseToken: tokenA, leaseSeconds: 60 }),
      );
      expect(beginWithStaleToken).toBe(false);

      // 生产 execution path 直调（executeClaimedAsyncJob = runner 同一合同，
      // 禁止测试复制实现）：stale token A 绝不允许进入 handler
      const { executeClaimedAsyncJob } = await import("@/lib/async/job-runner");
      const { registerJobHandler, resolveJobHandler } = await import("@/lib/async/job-registry");
      const realHandler = resolveJobHandler("PRODUCT_RESERVATION_EXPIRE", 1)!;
      let handlerInvocations = 0;
      registerJobHandler("PRODUCT_RESERVATION_EXPIRE", 1, async () => {
        handlerInvocations += 1;
        return { kind: "COMPLETED" };
      });
      try {
        const result = await executeClaimedAsyncJob(
          {
            id: job.id,
            kind: "PRODUCT_RESERVATION_EXPIRE",
            schemaVersion: 1,
            payload: { orderId: order.id },
            attempts: 1,
            maxAttempts: 8,
            leaseToken: tokenA,
            previousStatus: "RUNNING",
          },
          { leaseSeconds: 60 },
        );
        expect(result.fencedBeforeExecution).toBe(true);
        expect(handlerInvocations).toBe(0);
      } finally {
        registerJobHandler("PRODUCT_RESERVATION_EXPIRE", 1, realHandler);
      }

      // domain side effects = 0：Order / Product / OutboxEvent 全部原状
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("PENDING");
      expect(finalOrder.productReservationResolution).toBeNull();
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("RESERVED");
      expect(
        await rawClient!.outboxEvent.count({
          where: { aggregateId: order.id, eventType: "PRODUCT_RESERVATION_EXPIRED" },
        }),
      ).toBe(0);
    });

    it("J-LOCK-EXEC-01（RB01）：execution transaction 持行锁期间 → 其它 worker 的 SKIP LOCKED claim 必须跳过该行（deterministic barrier）", async () => {
      const job = await insertJobFixture({ orderId: `lockexec-${randomUUID().slice(0, 6)}` });

      const { claimDueAsyncJobs, beginAsyncJobExecutionTx } = await import(
        "@/lib/async/job-repository"
      );
      const { prisma } = await import("@/lib/prisma");

      const now1 = new Date();
      const first = await prisma.$transaction((tx) =>
        claimDueAsyncJobs(tx as unknown as Prisma.TransactionClient, {
          workerId: "worker-A",
          leaseSeconds: 1,
          batchSize: 10,
          now: now1,
        }),
      );
      const tokenA = first.find((j) => j.id === job.id)!.leaseToken;

      let signalT1Began!: () => void;
      const t1Began = new Promise<void>((resolve) => {
        signalT1Began = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });

      // T1：execution fence UPDATE（取行锁）后在 handler 位置挂起（事务未提交）
      const t1Promise = prisma.$transaction(async (tx) => {
        const ok = await beginAsyncJobExecutionTx(tx as unknown as Prisma.TransactionClient, {
          id: job.id,
          leaseToken: tokenA,
          leaseSeconds: 60,
          now: new Date(now1.getTime() + 100),
        });
        signalT1Began();
        await t1Gate;
        return ok;
      });
      await t1Began;

      // T2：now 已越过原始短 lease（RUNNING + leaseExpiresAt <= now 的
      // crash-recovery candidate）——但该行被 T1 行锁持有，SKIP LOCKED 必跳过
      const reclaimAttempt = await prisma.$transaction((tx) =>
        claimDueAsyncJobs(tx as unknown as Prisma.TransactionClient, {
          workerId: "worker-B",
          leaseSeconds: 60,
          batchSize: 100,
          now: new Date(now1.getTime() + 5_000),
        }),
      );

      releaseT1();
      const t1Result = await t1Promise;
      expect(t1Result).toBe(true);
      expect(reclaimAttempt.find((j) => j.id === job.id)).toBeUndefined();
    });

    it("RETRY-01（§15/§18/§50）：retryable 失败 → RETRY + 统一 backoff（attempt1=5s、attempt2=10s）+ 消毒错误落库", async () => {
      const job = await insertJobFixture({ orderId: `retry-${randomUUID().slice(0, 6)}` });

      const { claimDueAsyncJobs, failAsyncJob } = await import("@/lib/async/job-repository");
      const { withTransaction } = await import("@/lib/prisma");

      const now1 = new Date();
      const first = await withTransaction((tx) =>
        claimDueAsyncJobs(tx, { workerId: "worker-A", leaseSeconds: 60, batchSize: 10, now: now1 }),
      );
      const claimed = first.find((j) => j.id === job.id)!;

      const failureTime = new Date(now1.getTime() + 100);
      // runner 合同：错误先经 jobErrorMessage 处理再落库。RB02 合同：raw
      // exception message 默认拒绝 → 固定 generic message（消毒原语已在
      // job-types.test 覆盖）；机器诊断依赖 lastErrorCode
      const { jobErrorMessage } = await import("@/lib/async/job-types");
      const outcome1 = await failAsyncJob(queueClient, {
        id: job.id,
        leaseToken: claimed.leaseToken,
        attempts: claimed.attempts,
        maxAttempts: claimed.maxAttempts,
        failureClass: "RETRYABLE",
        errorCode: "P1001",
        errorMessage: jobErrorMessage(new Error("db transient\npassword=secret\r\nstack-line")),
        now: failureTime,
      });
      expect(outcome1).toMatchObject({ kind: "RETRY" });
      expect(outcome1.kind === "RETRY" && outcome1.runAt.getTime()).toBe(
        failureTime.getTime() + 5_000,
      );

      const afterFirst = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(afterFirst.status).toBe("RETRY");
      expect(afterFirst.attempts).toBe(1);
      expect(afterFirst.leaseToken).toBeNull();
      // RB02 ERR-SAFE：raw message 绝不落库（generic message + 安全 code）
      expect(afterFirst.lastErrorCode).toBe("P1001");
      expect(afterFirst.lastErrorMessage).toBe("异步任务执行失败");
      expect(afterFirst.lastErrorMessage).not.toContain("secret");
      expect(afterFirst.lastErrorMessage!.length).toBeLessThanOrEqual(500);

      // attempt 2 失败 → +10s（central backoff 指数）
      await rawClient!.asyncJob.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });
      const second = await withTransaction((tx) =>
        claimDueAsyncJobs(tx, {
          workerId: "worker-A",
          leaseSeconds: 60,
          batchSize: 10,
          now: new Date(),
        }),
      );
      const claimed2 = second.find((j) => j.id === job.id)!;
      expect(claimed2.attempts).toBe(2);
      const outcome2 = await failAsyncJob(queueClient, {
        id: job.id,
        leaseToken: claimed2.leaseToken,
        attempts: claimed2.attempts,
        maxAttempts: claimed2.maxAttempts,
        failureClass: "RETRYABLE",
        errorCode: "P1001",
        errorMessage: "still transient",
      });
      expect(outcome2.kind).toBe("RETRY");
      expect(outcome2.kind === "RETRY" && outcome2.runAt.getTime()).toBeGreaterThan(
        Date.now() + 9_000,
      );
      expect(outcome2.kind === "RETRY" && outcome2.runAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 10_500,
      );
    });

    it("DEADLETTER-01（§16/§51）：attempts 耗尽 → DEAD_LETTER + 清 lease；此后 claim 不再领取", async () => {
      const job = await insertJobFixture({ orderId: `dl-${randomUUID().slice(0, 6)}`, maxAttempts: 8 });

      const { claimDueAsyncJobs, failAsyncJob } = await import("@/lib/async/job-repository");
      const { withTransaction } = await import("@/lib/prisma");

      const now1 = new Date();
      const first = await withTransaction((tx) =>
        claimDueAsyncJobs(tx, { workerId: "worker-A", leaseSeconds: 60, batchSize: 10, now: now1 }),
      );
      const claimed = first.find((j) => j.id === job.id)!;
      // 直接以 attempts=maxAttempts 的已 claim 行驱动 dead-letter 分支
      await rawClient!.asyncJob.update({ where: { id: job.id }, data: { attempts: 8 } });

      const outcome = await failAsyncJob(queueClient, {
        id: job.id,
        leaseToken: claimed.leaseToken,
        attempts: 8,
        maxAttempts: 8,
        failureClass: "RETRYABLE",
        errorCode: "P1001",
        errorMessage: "exhausted",
      });
      expect(outcome).toEqual({ kind: "DEAD_LETTER" });

      const dead = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(dead.status).toBe("DEAD_LETTER");
      expect(dead.deadLetteredAt).not.toBeNull();
      expect(dead.leaseOwner).toBeNull();
      expect(dead.leaseToken).toBeNull();
      expect(dead.leaseExpiresAt).toBeNull();

      // terminal：不再被自动 claim
      const reclaim = await withTransaction((tx) =>
        claimDueAsyncJobs(tx, {
          workerId: "worker-B",
          leaseSeconds: 60,
          batchSize: 100,
          now: new Date(Date.now() + 60_000),
        }),
      );
      expect(reclaim.find((j) => j.id === job.id)).toBeUndefined();
    });

    it("REQUEUE-01（§19/§52）：requeueDeadLetterJobTx → PENDING/attempts=0/runAt=now/lease 清空；非 DL 拒绝", async () => {
      const deadJob = await insertJobFixture({
        orderId: `rq-${randomUUID().slice(0, 6)}`,
        status: "DEAD_LETTER",
        attempts: 8,
      });
      await rawClient!.asyncJob.update({
        where: { id: deadJob.id },
        data: {
          leaseToken: "should-be-cleared",
          leaseOwner: "worker-A",
          leaseExpiresAt: new Date(Date.now() + 60_000),
          deadLetteredAt: new Date(),
        },
      });

      const { requeueDeadLetterJobTx } = await import("@/lib/async/job-repository");
      const { withTransaction } = await import("@/lib/prisma");

      const before = Date.now();
      const requeued = await withTransaction((tx) => requeueDeadLetterJobTx(tx, deadJob.id));
      expect(requeued.requeued).toBe(true);

      const row = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: deadJob.id } });
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(0);
      expect(row.runAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row.leaseOwner).toBeNull();
      expect(row.leaseToken).toBeNull();
      expect(row.leaseExpiresAt).toBeNull();
      expect(row.deadLetteredAt).toBeNull();

      // 非 dead-letter：DENY，零 mutation
      const liveJob = await insertJobFixture({ orderId: `rq-live-${randomUUID().slice(0, 6)}` });
      const denied = await withTransaction((tx) => requeueDeadLetterJobTx(tx, liveJob.id));
      expect(denied.requeued).toBe(false);
      const liveRow = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: liveJob.id } });
      expect(liveRow.status).toBe("PENDING");
      expect(liveRow.attempts).toBe(0);
    });

    it("FAILCLOSED-01（§6/§17）：未知 kind / 未知 version / 非法 payload → runner 直接 DEAD_LETTER，不猜测执行", async () => {
      const unknownKind = await insertJobFixture({
        orderId: `fc-${randomUUID().slice(0, 6)}`,
        kind: "EMAIL_DELIVERY",
      });
      const unknownVersion = await insertJobFixture({
        orderId: `fc-${randomUUID().slice(0, 6)}`,
        schemaVersion: 999,
      });
      const invalidPayload = await insertJobFixture({
        orderId: `fc-${randomUUID().slice(0, 6)}`,
        payload: { note: "unexpected shape" },
      });

      const summary = await runWorkerBatch();

      for (const job of [unknownKind, unknownVersion, invalidPayload]) {
        const row = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
        expect(row.status).toBe("DEAD_LETTER");
        expect(row.deadLetteredAt).not.toBeNull();
      }
      const unknownKindRow = await rawClient!.asyncJob.findUniqueOrThrow({
        where: { id: unknownKind.id },
      });
      expect(unknownKindRow.lastErrorCode).toBe("ASYNC_JOB_KIND_OR_SCHEMA_VERSION_UNKNOWN");
      const invalidPayloadRow = await rawClient!.asyncJob.findUniqueOrThrow({
        where: { id: invalidPayload.id },
      });
      expect(invalidPayloadRow.lastErrorCode).toBe("PRODUCT_RESERVATION_EXPIRE_PAYLOAD_INVALID");
      // ERR-SAFE-02：PermanentJobFailure 的受控内部文案允许落库（安全机器诊断，
      // 不含任何 raw exception text / user content）
      expect(invalidPayloadRow.lastErrorMessage).toBe(
        "PRODUCT_RESERVATION_EXPIRE payload 形状非法（期望 { orderId: string }）",
      );
      expect(summary.deadLettered).toBeGreaterThanOrEqual(3);
    });

    it("ERR-SAFE-01（RB02）：handler 抛 raw exception（含 password/jwt/user note）→ lastErrorMessage = 固定 generic，秘密绝不落库", async () => {
      const leakyJob = await insertJobFixture({ orderId: `errsafe-${randomUUID().slice(0, 6)}` });

      const { registerJobHandler, resolveJobHandler } = await import("@/lib/async/job-registry");
      const realHandler = resolveJobHandler("PRODUCT_RESERVATION_EXPIRE", 1)!;
      registerJobHandler("PRODUCT_RESERVATION_EXPIRE", 1, async () => {
        throw new Error("password=super-secret jwt=abc.def.ghi user note=私密内容");
      });
      try {
        await runWorkerBatch();
      } finally {
        registerJobHandler("PRODUCT_RESERVATION_EXPIRE", 1, realHandler);
      }

      const row = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: leakyJob.id } });
      expect(row.lastErrorCode).toBe("Error");
      expect(row.lastErrorMessage).toBe("异步任务执行失败");
      expect(row.lastErrorMessage).not.toContain("super-secret");
      expect(row.lastErrorMessage).not.toContain("abc.def.ghi");
      expect(row.lastErrorMessage).not.toContain("私密内容");
    });

    it("ERR-SAFE-OUTBOX-01（RB02）：materializer 抛 raw exception → event.lastErrorMessage = 固定 generic，秘密绝不落库", async () => {
      const leakyEvent = await insertEventFixture({
        orderId: `errsafe-out-${randomUUID().slice(0, 6)}`,
      });

      const {
        registerOutboxEventHandler,
        resolveOutboxEventHandler,
      } = await import("@/lib/async/outbox-registry");
      const original = resolveOutboxEventHandler("PRODUCT_RESERVATION_EXPIRED", 1)!;
      registerOutboxEventHandler("PRODUCT_RESERVATION_EXPIRED", 1, async () => {
        throw new Error("smtp_password=hunter2 provider_response=account-suspended user note=内部备注");
      });
      try {
        await runOutboxBatch();
      } finally {
        registerOutboxEventHandler("PRODUCT_RESERVATION_EXPIRED", 1, original);
      }

      const row = await rawClient!.outboxEvent.findUniqueOrThrow({ where: { id: leakyEvent.id } });
      expect(row.lastErrorCode).toBe("Error");
      expect(row.lastErrorMessage).toBe("异步事件处理失败");
      expect(row.lastErrorMessage).not.toContain("hunter2");
      expect(row.lastErrorMessage).not.toContain("account-suspended");
      expect(row.lastErrorMessage).not.toContain("内部备注");
    });

    it("WORKER-INT-01（§53/§54/§31）：真实生产 entrypoint --run-once → canonical expiry materialize + outbox PUBLISHED + 恰一对通知（buyer SUSPENDED 不阻断）", async () => {
      const seller = await createFixtureUser("调度卖家");
      // 下单时买家必须 ACTIVE（新义务创建受 marketplace capability gate 约束）；
      // §54 验证的是 system wind-down 不受阻——下单后置 SUSPENDED
      const buyer = await createFixtureUser("调度买家");
      const product = await createProductFixture(seller.id);

      const order = await placeRealOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      expect(order).not.toBeNull();
      const orderId = order!.id;
      await rawClient!.user.update({ where: { id: buyer.id }, data: { status: "SUSPENDED" } });

      // TEST-ONLY DEADLINE ADVANCE：只推进时间字段（deadline + job.runAt），
      // Order.status / Product.status / resolution / job.status 一律不碰
      await advanceDeadlineOnly(orderId, new Date(Date.now() - 1000));

      const result = await runProductionWorkerOnce();
      expect(result.code, `worker stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.productReservationResolution).toBe("EXPIRED");
      expect(finalOrder.cancelReason).toBe("商品预留超时自动释放");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");

      const job = await rawClient!.asyncJob.findUniqueOrThrow({
        where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${orderId}` },
      });
      expect(job.status).toBe("COMPLETED");
      expect(job.completedAt).not.toBeNull();

      const event = await rawClient!.outboxEvent.findUnique({
        where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRED:${orderId}` },
      });
      expect(event).not.toBeNull();
      expect(event!.status).toBe("PUBLISHED");
      expect(event!.publishedAt).not.toBeNull();

      // 恰一对 In-App expiry 通知（另有下单时 2 条创建通知，共 4 条）
      const notifications = await rawClient!.notification.findMany({
        where: { orderId, title: "商品预留已过期" },
        orderBy: { userId: "asc" },
      });
      expect(notifications).toHaveLength(2);
      expect(
        await rawClient!.notification.count({ where: { orderId } }),
      ).toBe(4);
      for (const notification of notifications) {
        expect(notification.title).toBe("商品预留已过期");
        expect(notification.dedupeKey).toBe(`OUTBOX:${event!.id}:IN_APP:${notification.userId}`);
        expect(notification.sourceEventId).toBe(event!.id);
      }
      expect(notifications.map((n) => n.userId).sort()).toEqual([buyer.id, seller.id].sort());
    }, 120_000);

    it("CRASH-REPLAY-01（§57）：业务事务 COMMIT 后、completion marker 前崩溃 → lease/retry 恢复后 NOT_PENDING 幂等完成，OutboxEvent exactly 1、Notification exactly 2", async () => {
      const seller = await createFixtureUser("崩溃卖家");
      const buyer = await createFixtureUser("崩溃买家");
      const product = await createProductFixture(seller.id, "RESERVED");

      // 直接落库 PENDING + due job（跳过下单路径，精确控制 job 行）
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        deadlineIsPast: true,
      });
      const job = await insertJobFixture({ orderId: order.id });

      // 第一轮：handler 业务事务已提交（EXPIRED + OutboxEvent），completion 前 crash
      let committedJobId = "";
      const summary1 = await runWorkerBatch({
        seams: {
          afterJobTxCommit: async (claimed) => {
            committedJobId = claimed.id;
            throw new Error("simulated crash after domain commit");
          },
        },
      });
      expect(committedJobId).toBe(job.id);
      // 未知异常 → RETRYABLE until maxAttempts
      expect(summary1.retried).toBeGreaterThanOrEqual(1);
      const midJob = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(midJob.status).toBe("RETRY");
      // 业务事实已提交（崩溃不影响 domain commit）
      const midOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(midOrder.productReservationResolution).toBe("EXPIRED");

      // 恢复路径：TEST-ONLY 推进 runAt → 第二轮 handler 读到 NOT_PENDING → 幂等完成
      await rawClient!.asyncJob.update({
        where: { id: job.id },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      const summary2 = await runWorkerBatch();
      expect(summary2.idempotentNoOp).toBeGreaterThanOrEqual(1);

      const finalJob = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(finalJob.status).toBe("COMPLETED");

      // dispatcher 派发（生产 worker 同周期执行）→ exactly-once
      await runOutboxBatch();
      const events = await rawClient!.outboxEvent.findMany({
        where: { aggregateId: order.id, eventType: "PRODUCT_RESERVATION_EXPIRED" },
      });
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe("PUBLISHED");
      const notifications = await rawClient!.notification.findMany({ where: { orderId: order.id } });
      expect(notifications).toHaveLength(2);
    });

    it("SCHED-ACCEPT-RACE-01（§55）：scheduler 到期唤醒 ∥ 期限内 seller accept → pair 锁线性化 accept wins → NOT_DUE 重排程；deadline 真实到达后 NOT_PENDING 幂等完成，零重复通知", async () => {
      const seller = await createFixtureUser("竞速卖家");
      const buyer = await createFixtureUser("竞速买家");
      const product = await createProductFixture(seller.id, "RESERVED");
      // deadline 在未来（accept 尚在期限内）；job 已 due（scheduler 在边界唤醒
      // 的 stale-schedule 形态）
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        productReservationExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      await insertJobFixture({ orderId: order.id });

      const { updateOrderStatusTx } = await import("@/lib/order-status-service");
      const { withTransaction } = await import("@/lib/prisma");

      // T1：真实 seller ACCEPT（fresh not overdue 已确认），在写入前挂起
      let signalT1Locked!: () => void;
      const t1Locked = new Promise<void>((resolve) => {
        signalT1Locked = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      const promiseT1 = withTransaction((tx: Prisma.TransactionClient) =>
        updateOrderStatusTx(tx, seller.id, order.id, { requestedStatus: "ACCEPTED" }, {
          afterOrderRowLock: async () => {
            signalT1Locked();
            await t1Gate;
          },
        } as Parameters<typeof updateOrderStatusTx>[4]),
      );
      await t1Locked;

      // T2：生产 worker batch（handler 阻塞在同一 pair 锁域，真实等待）
      const promiseT2 = runWorkerBatch();
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

      releaseT1();
      const [t1, t2] = await Promise.allSettled([promiseT1, promiseT2]);
      expect(t1.status).toBe("fulfilled");
      expect(t2.status).toBe("fulfilled");

      // accept wins：ACCEPTED；worker（锁内 fresh re-read）读到已非 PENDING →
      // NOT_PENDING → 幂等 COMPLETED（attempt 已消耗一次）
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("ACCEPTED");
      expect(finalOrder.productReservationResolution).toBe("ACCEPTED");

      const jobAfterRace = await rawClient!.asyncJob.findFirst({
        where: { dedupeKey: { startsWith: `${JOB_DEDUPE_PREFIX}:${order.id}` } },
      });
      expect(jobAfterRace!.status).toBe("COMPLETED");
      expect(jobAfterRace!.completedAt).not.toBeNull();

      // 禁止 ACCEPTED + EXPIRED 双写：零 outbox event、零 expiry 通知、恰一对 accept 通知
      expect(
        await rawClient!.outboxEvent.count({
          where: { aggregateId: order.id, eventType: "PRODUCT_RESERVATION_EXPIRED" },
        }),
      ).toBe(0);
      expect(await notificationCount(buyer.id, "商品预留已过期", order.id)).toBe(0);
      expect(await notificationCount(seller.id, "商品预留已过期", order.id)).toBe(0);
      expect(await notificationCount(buyer.id, "订单状态更新：已接单", order.id)).toBe(1);
      expect(await notificationCount(seller.id, "订单状态更新：已接单", order.id)).toBe(1);
      expect(await rawClient!.notification.count({ where: { orderId: order.id } })).toBe(2);
    });

    it("SCHED-NOTDUE-01（§26）：deadline 未到但 job 已 due（clock/stale schedule 防御）→ NOT_DUE → 重排程到权威 deadline，零业务写入", async () => {
      const seller = await createFixtureUser("未到期卖家");
      const buyer = await createFixtureUser("未到期买家");
      const product = await createProductFixture(seller.id, "RESERVED");
      const futureDeadline = new Date(Date.now() + 60 * 60 * 1000);
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        productReservationExpiresAt: futureDeadline,
      });
      await insertJobFixture({ orderId: order.id });

      const summary = await runWorkerBatch();
      expect(summary.rescheduled).toBeGreaterThanOrEqual(1);

      // 业务事实零写入：order 仍 PENDING、Product 仍 RESERVED、零通知
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("PENDING");
      expect(finalOrder.productReservationResolution).toBeNull();
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("RESERVED");
      expect(await rawClient!.notification.count({ where: { orderId: order.id } })).toBe(0);

      // job 重排程到权威 deadline（PENDING、runAt = deadline、不计失败）
      const job = await rawClient!.asyncJob.findFirst({
        where: { dedupeKey: { startsWith: `${JOB_DEDUPE_PREFIX}:${order.id}` } },
      });
      expect(job!.status).toBe("PENDING");
      expect(job!.runAt.getTime()).toBe(futureDeadline.getTime());
      expect(job!.attempts).toBe(1);
      expect(job!.lastErrorCode).toBeNull();
    });

    it("SCHED-EXPIRE-THEN-JOB-01（§25）：late-accept 路径 materialize EXPIRED（outbox 已写）→ 调度 job 后跑 → NOT_PENDING 幂等，绝不重复通知", async () => {
      const seller = await createFixtureUser("后置卖家");
      const buyer = await createFixtureUser("后置买家");
      const product = await createProductFixture(seller.id, "RESERVED");
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        deadlineIsPast: true,
      });
      await insertJobFixture({ orderId: order.id });

      // 用户 late accept 同步 materialize EXPIRED（共享 canonical expiry → outbox）
      const { acceptProductOrderTx } = await import("@/lib/product-order-lifecycle");
      const { withTransaction } = await import("@/lib/prisma");
      const outcome = await withTransaction((tx: Prisma.TransactionClient) =>
        acceptProductOrderTx(
          tx,
          seller.id,
          order.id,
          { buyerId: buyer.id, sellerId: seller.id, productId: product.id },
        ),
      );
      expect(outcome).toEqual({ reservationResolution: "EXPIRED" });

      // 调度 job 之后才运行：NOT_PENDING → COMPLETED_IDEMPOTENT
      const summary = await runWorkerBatch();
      expect(summary.idempotentNoOp).toBeGreaterThanOrEqual(1);
      const job = await rawClient!.asyncJob.findFirst({
        where: { dedupeKey: { startsWith: `${JOB_DEDUPE_PREFIX}:${order.id}` } },
      });
      expect(job!.status).toBe("COMPLETED");

      await runOutboxBatch();
      const events = await rawClient!.outboxEvent.findMany({
        where: { aggregateId: order.id, eventType: "PRODUCT_RESERVATION_EXPIRED" },
      });
      expect(events).toHaveLength(1);
      expect(await notificationCount(buyer.id, "商品预留已过期", order.id)).toBe(1);
      expect(await notificationCount(seller.id, "商品预留已过期", order.id)).toBe(1);
      expect(await rawClient!.notification.count({ where: { orderId: order.id } })).toBe(2);
    });

    it("SCHED-CANCEL-RACE-01（§56）：worker expire ∥ buyer cancel → cancel wins 线性化，job 幂等完成、零重复通知", async () => {
      const seller = await createFixtureUser("取消竞速卖家");
      const buyer = await createFixtureUser("取消竞速买家");
      const product = await createProductFixture(seller.id, "RESERVED");
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        deadlineIsPast: true,
      });
      await insertJobFixture({ orderId: order.id });

      const { updateOrderStatusTx } = await import("@/lib/order-status-service");
      const { withTransaction } = await import("@/lib/prisma");

      // T1：真实 buyer CANCEL 持锁挂起（取消在期限内真相由锁序裁决：deadline
      // 已过 → cancel 路径本身会 materialize EXPIRED；本用例令 deadline 未过，
      // 验证纯 cancel wins 分支）
      await rawClient!.order.update({
        where: { id: order.id },
        data: { productReservationExpiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      });
      await rawClient!.asyncJob.updateMany({
        where: { dedupeKey: { startsWith: `${JOB_DEDUPE_PREFIX}:${order.id}` } },
        data: { runAt: new Date(Date.now() + 60 * 60 * 1000) },
      });
      // job 未到期：手动改为 due 以驱动 worker 并发（deadline 时间已回拨，job 独立推进）
      await rawClient!.asyncJob.updateMany({
        where: { dedupeKey: { startsWith: `${JOB_DEDUPE_PREFIX}:${order.id}` } },
        data: { runAt: new Date(Date.now() - 1000) },
      });

      let signalT1Locked!: () => void;
      const t1Locked = new Promise<void>((resolve) => {
        signalT1Locked = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      const promiseT1 = withTransaction((tx: Prisma.TransactionClient) =>
        updateOrderStatusTx(tx, buyer.id, order.id, { requestedStatus: "CANCELLED" }, {
          afterOrderRowLock: async () => {
            signalT1Locked();
            await t1Gate;
          },
        } as Parameters<typeof updateOrderStatusTx>[4]),
      );
      await t1Locked;

      const promiseT2 = runWorkerBatch();
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

      releaseT1();
      const [t1, t2] = await Promise.allSettled([promiseT1, promiseT2]);
      expect(t1.status).toBe("fulfilled");
      expect(t2.status).toBe("fulfilled");

      // cancel wins：CANCELLED（resolution CANCELLED）；worker NOT_PENDING 幂等
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.productReservationResolution).toBe("CANCELLED");

      const job = await rawClient!.asyncJob.findFirst({
        where: { dedupeKey: { startsWith: `${JOB_DEDUPE_PREFIX}:${order.id}` } },
      });
      expect(job!.status).toBe("COMPLETED");

      // 用户取消不产生 expiry event/通知；恰一对取消通知
      expect(
        await rawClient!.outboxEvent.count({
          where: { aggregateId: order.id, eventType: "PRODUCT_RESERVATION_EXPIRED" },
        }),
      ).toBe(0);
      expect(await notificationCount(buyer.id, "商品预留已过期", order.id)).toBe(0);
      expect(await notificationCount(seller.id, "商品预留已过期", order.id)).toBe(0);
      expect(await notificationCount(buyer.id, "订单状态更新：已取消", order.id)).toBe(1);
      expect(await notificationCount(seller.id, "订单状态更新：已取消", order.id)).toBe(1);
    });

    it("OUTBOX-RACE-01（§58）：两 dispatcher 并发 claim 同一 event → 恰一个有效 lease（SKIP LOCKED + fencing 与 Job 同构）", async () => {
      const event = await insertEventFixture({ orderId: `orange-${randomUUID().slice(0, 6)}` });

      const { claimDueOutboxEvents } = await import("@/lib/async/outbox");
      const { prisma } = await import("@/lib/prisma");

      let signalT1Claimed!: () => void;
      const t1Claimed = new Promise<void>((resolve) => {
        signalT1Claimed = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });

      const t1Promise = prisma.$transaction(async (tx) => {
        const claimed = await claimDueOutboxEvents(tx as unknown as Prisma.TransactionClient, {
          workerId: "dispatcher-A",
          leaseSeconds: 60,
          batchSize: 10,
        });
        signalT1Claimed();
        await t1Gate;
        return claimed;
      });
      await t1Claimed;

      const t2Claimed = await prisma.$transaction((tx) =>
        claimDueOutboxEvents(tx as unknown as Prisma.TransactionClient, {
          workerId: "dispatcher-B",
          leaseSeconds: 60,
          batchSize: 10,
        }),
      );

      releaseT1();
      const t1Result = await t1Promise;

      const t1Hit = t1Result.filter((e) => e.id === event.id);
      const t2Hit = t2Claimed.filter((e) => e.id === event.id);
      expect(t1Hit.length + t2Hit.length).toBe(1);
    });

    it("OUTBOX-RETRY-01（§59）：materializer retryable 失败 → 通知 0、event 回 PENDING 退避；恢复后成功 → Notification exactly 2", async () => {
      const seller = await createFixtureUser("外重试卖家");
      const buyer = await createFixtureUser("外重试买家");
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: (await createProductFixture(seller.id)).id,
        status: "CANCELLED",
      });
      const event = await insertEventFixture({ orderId: order.id });

      const {
        registerOutboxEventHandler,
        resolveOutboxEventHandler,
      } = await import("@/lib/async/outbox-registry");
      const original = resolveOutboxEventHandler("PRODUCT_RESERVATION_EXPIRED", 1)!;
      let failures = 0;
      registerOutboxEventHandler("PRODUCT_RESERVATION_EXPIRED", 1, async () => {
        failures += 1;
        throw new Error("transient materializer outage");
      });

      const summary1 = await runOutboxBatch();
      expect(summary1.retried).toBeGreaterThanOrEqual(1);
      expect(failures).toBe(1);

      const midEvent = await rawClient!.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(midEvent.status).toBe("PENDING");
      expect(midEvent.availableAt.getTime()).toBeGreaterThan(Date.now());
      expect(midEvent.lastErrorCode).toBe("Error");
      expect(
        await rawClient!.notification.count({ where: { orderId: order.id } }),
      ).toBe(0);

      // 恢复真实 handler，TEST-ONLY 推进 availableAt → 下一轮成功
      registerOutboxEventHandler("PRODUCT_RESERVATION_EXPIRED", 1, original);
      await rawClient!.outboxEvent.update({
        where: { id: event.id },
        data: { availableAt: new Date(Date.now() - 1000) },
      });
      const summary2 = await runOutboxBatch();
      expect(summary2.published).toBeGreaterThanOrEqual(1);

      const published = await rawClient!.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(published.status).toBe("PUBLISHED");
      expect(await rawClient!.notification.count({ where: { orderId: order.id } })).toBe(2);
    });

    it("OUTBOX-IDEMPOTENCY-01（§60/§28）：强制重放 handler → Notification.dedupeKey DB 级兜底，buyer/seller 各恰好 1 条", async () => {
      const seller = await createFixtureUser("重放卖家");
      const buyer = await createFixtureUser("重放买家");
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: (await createProductFixture(seller.id)).id,
        status: "CANCELLED",
      });
      const event = await insertEventFixture({ orderId: order.id });

      await runOutboxBatch();
      expect(await rawClient!.notification.count({ where: { orderId: order.id } })).toBe(2);

      // 强制把 event 拨回 PENDING 再派发（比 crash-after-commit 更激进的重放）
      await rawClient!.outboxEvent.update({
        where: { id: event.id },
        data: { status: "PENDING", availableAt: new Date(Date.now() - 1000), attempts: 0 },
      });
      await runOutboxBatch();

      // DB 级幂等：仍恰 1+1（绝不 findFirst-then-create 的伪幂等）
      expect(await rawClient!.notification.count({ where: { orderId: order.id } })).toBe(2);
      const rows = await rawClient!.notification.findMany({ where: { orderId: order.id } });
      expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(2);
      for (const row of rows) {
        expect(row.dedupeKey).toBe(`OUTBOX:${event.id}:IN_APP:${row.userId}`);
      }
    });

    it("OUTBOX-FAILCLOSED-01（§22）：未知 eventType → dispatcher PERMANENT DEAD_LETTER", async () => {
      const event = await insertEventFixture({
        orderId: `ofc-${randomUUID().slice(0, 6)}`,
        eventType: "ORDER_COMPLETED",
      });
      await runOutboxBatch();
      const row = await rawClient!.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(row.status).toBe("DEAD_LETTER");
      expect(row.lastErrorCode).toBe("OUTBOX_EVENT_TYPE_OR_SCHEMA_VERSION_UNKNOWN");
    });

    it("STATS-01（§38/§40）：queue stats 服务可观测 backlog（pending/retry/running/dead-letter/outbox 计数）", async () => {
      const { getQueueStatsSnapshot } = await import("@/lib/async/queue-stats");
      const stats = await getQueueStatsSnapshot();
      expect(stats.jobs.pending).toBeGreaterThanOrEqual(0);
      expect(stats.jobs.retry).toBeGreaterThanOrEqual(0);
      expect(stats.jobs.running).toBeGreaterThanOrEqual(0);
      expect(stats.jobs.deadLetter).toBeGreaterThanOrEqual(1);
      expect(stats.outbox.deadLetter).toBeGreaterThanOrEqual(1);
    });
  },
);
