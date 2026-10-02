import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";

// Phase 9A RB03：bounded graceful shutdown（真实子进程 + 真实 PostgreSQL）。
//
// 合同（任务书 §13-§18）：
//   SHUTDOWN-01  idle worker：SIGTERM → 停止新 claim → 当前周期完成 →
//                exit 0（grace 内，无 shutdown_timeout 事件）
//   SHUTDOWN-02  当前周期挂起（handler 阻塞在 governance 锁上——确定性
//                barrier，非 sleep）：SIGTERM → grace 超时 → 记
//                async_worker_shutdown_timeout → 进程 bounded 退出；
//                未完成 job 绝不伪造 COMPLETED（仍 RUNNING）；
//                新 worker 在 lease 过期后 recovery 重放 → canonical expiry
//                materialize + job COMPLETED + 通知恰好一次
//
// 平台说明：Windows 的 uv_kill(SIGTERM) 对独立进程是硬终止（不触发
// handler），信号合同只能在 POSIX 上验证——本文件 skipIf(win32)，
// 由 CI（ubuntu）承载；lease recovery 的 durable 合同另由
// phase9a-async-core CRASH-REPLAY-01 在进程内覆盖。
//
// worker 以【真实生产 entrypoint】（scripts/ops/async-worker.ts，loop 模式）
// 子进程运行——与 compose async-worker 服务同一入口。

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

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

const RUN_TAG = `p9ashut-${randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdOrderIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdJobDedupeKeys: string[] = [];

let campusId = "";
let productCategoryId = "";

let fixtureSeq = 0;

interface WorkerHandle {
  exitCode: Promise<number | null>;
  stdout: () => string;
  stderr: () => string;
  child: ReturnType<typeof spawn>;
}

function spawnWorkerLoop(graceMs: number): WorkerHandle {
  let stdout = "";
  let stderr = "";
  const child = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(process.cwd(), "scripts", "ops", "async-worker.ts"),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: process.env.DATABASE_URL ?? integrationDatabaseUrl ?? "",
        ASYNC_WORKER_POLL_MS: "250",
        ASYNC_WORKER_SHUTDOWN_GRACE_MS: String(graceMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout!.on("data", (chunk: Buffer) => (stdout += String(chunk)));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += String(chunk)));
  const exitCode = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  return { exitCode, stdout: () => stdout, stderr: () => stderr, child };
}

async function waitForStdoutLine(
  worker: WorkerHandle,
  event: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = worker
      .stdout()
      .split("\n")
      .find((candidate) => candidate.includes(event));
    if (line) {
      return line;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `等待 ${event} 超时；stdout=${worker.stdout()} stderr=${worker.stderr()}`,
  );
}

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
  createdUserIds.push(user.id);
  const membership = await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId, status: "ACTIVE" },
  });
  createdMembershipIds.push(membership.id);
  return user;
}

/** PENDING 订单 + 到期 durable intent（deadline / runAt 均 TEST-ONLY 推进）。 */
async function createDueReservationFixture(input: {
  buyerId: string;
  sellerId: string;
  productId: string;
}) {
  const order = await rawClient!.order.create({
    data: {
      orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
      type: "PRODUCT",
      status: "PENDING",
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      productId: input.productId,
      amount: "10.00",
      productReservationExpiresAt: new Date(Date.now() - 60_000),
    },
  });
  createdOrderIds.push(order.id);
  const job = await rawClient!.asyncJob.create({
    data: {
      kind: "PRODUCT_RESERVATION_EXPIRE",
      schemaVersion: 1,
      dedupeKey: `${RUN_TAG}:job:${order.id}`,
      payload: { orderId: order.id },
      status: "PENDING",
      runAt: new Date(Date.now() - 60_000),
    },
  });
  createdJobDedupeKeys.push(job.dedupeKey);
  return { order, job };
}

beforeAll(async () => {
  if (!rawClient) return;
  const campus = await rawClient.campus.upsert({
    where: { slug: RUN_TAG },
    create: { name: `9A shutdown 校区 ${RUN_TAG}`, slug: RUN_TAG, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;
  const category = await rawClient.productCategory.create({
    data: { name: `9A shutdown 类目-${RUN_TAG}`, slug: RUN_TAG },
  });
  productCategoryId = category.id;
});

afterAll(async () => {
  if (!rawClient) return;
  await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.outboxEvent.deleteMany({
    where: { dedupeKey: { in: createdOrderIds.map((id) => `PRODUCT_RESERVATION_EXPIRED:${id}`) } },
  });
  await rawClient.asyncJob.deleteMany({ where: { dedupeKey: { in: createdJobDedupeKeys } } });
  await rawClient.riskState.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: productCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });
  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl || process.platform === "win32")(
  "Phase 9A RB03 bounded shutdown（真实 worker 子进程 + 真实 PG；POSIX 信号合同）",
  () => {
    it("SHUTDOWN-01：idle worker SIGTERM → 停止新 claim → 当前周期完成 → exit 0（grace 内）", async () => {
      const worker = spawnWorkerLoop(2_000);
      await waitForStdoutLine(worker, "async_worker_started");

      const startedAt = Date.now();
      worker.child.kill("SIGTERM");
      const code = await worker.exitCode;
      const elapsedMs = Date.now() - startedAt;

      expect(code).toBe(0);
      // idle 周期远小于 grace：必须干净退出且绝不触发 timeout 事件
      expect(elapsedMs).toBeLessThan(8_000);
      expect(worker.stdout()).not.toContain("async_worker_shutdown_timeout");
      expect(worker.stdout()).toContain("async_worker_started");
    });

    it("SHUTDOWN-02：当前周期挂起（handler 阻塞在 governance 锁）→ SIGTERM → grace 超时退出；job 不伪造 COMPLETED，lease recovery 后重放完成", async () => {
      const seller = await createFixtureUser("挂起卖家");
      const buyer = await createFixtureUser("挂起买家");
      const product = await rawClient!.product.create({
        data: {
          title: `9A shutdown 商品 ${randomUUID().slice(0, 6)}`,
          description: "RB03 fixture",
          price: 10,
          condition: "NEW",
          locationText: "东门",
          categoryId: productCategoryId,
          campusId,
          sellerId: seller.id,
          status: "RESERVED",
        },
      });
      createdProductIds.push(product.id);
      const { order, job } = await createDueReservationFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
      });

      const { prisma } = await import("@/lib/prisma");
      const { acquireGovernanceSubjectLocks } = await import(
        "@/lib/governance/governance-lock"
      );

      // 测试侧先持有 buyer/seller pair 治理锁（未提交事务）→ worker 的
      // expireProductReservationTx 将确定性阻塞在其锁等待上
      let signalHeld!: () => void;
      const lockHeld = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      let releaseLocks!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        releaseLocks = resolve;
      });
      const lockHolderTx = prisma.$transaction(
        async (tx) => {
          await acquireGovernanceSubjectLocks(tx as unknown as Prisma.TransactionClient, [
            { subjectType: "USER", subjectId: buyer.id },
            { subjectType: "USER", subjectId: seller.id },
          ]);
          signalHeld();
          await releaseGate;
        },
        // Prisma 交互事务默认 5s 超时会提前杀掉持锁事务、放行 handler，
        // 使 grace 超时路径不可达——持锁必须覆盖整个 shutdown 观测窗口
        { timeout: 60_000, maxWait: 10_000 },
      );
      await lockHeld;

      const graceMs = 2_000;
      const worker = spawnWorkerLoop(graceMs);
      try {
        await waitForStdoutLine(worker, "async_worker_started");
        // 确定性 barrier：handler 已进入 pair 锁等待（非 sleep 排序）
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

        const signalAt = Date.now();
        worker.child.kill("SIGTERM");
        const code = await worker.exitCode;
        const elapsedMs = Date.now() - signalAt;

        // bounded：grace 超时路径退出（grace 2s + 调度余量），且非伪造成功
        expect(elapsedMs).toBeLessThan(10_000);
        expect(code).toBe(0);
        expect(worker.stdout()).toContain("async_worker_shutdown_signal");
        expect(worker.stdout()).toContain("async_worker_shutdown_timeout");

        // 未完成 job 绝不伪造 COMPLETED：仍 RUNNING（worker 进程退出 →
        // 连接断开 → handler 事务回滚 → 业务零副作用）
        const interruptedJob = await rawClient!.asyncJob.findUniqueOrThrow({
          where: { id: job.id },
        });
        expect(interruptedJob.status).toBe("RUNNING");
        expect(interruptedJob.completedAt).toBeNull();
        const interruptedOrder = await rawClient!.order.findUniqueOrThrow({
          where: { id: order.id },
        });
        expect(interruptedOrder.status).toBe("PENDING");
        expect(interruptedOrder.productReservationResolution).toBeNull();
      } finally {
        releaseLocks();
        await lockHolderTx.catch(() => undefined);
      }

      // lease recovery（TEST-ONLY 推进 lease 时间字段）→ 新 worker 重放：
      // canonical expiry materialize + job COMPLETED + 通知恰好一次
      await rawClient!.asyncJob.update({
        where: { id: job.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      const { runAsyncJobBatchOnce } = await import("@/lib/async/job-runner");
      const jobSummary = await runAsyncJobBatchOnce();
      expect(jobSummary.leaseRecovered).toBeGreaterThanOrEqual(1);

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.productReservationResolution).toBe("EXPIRED");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");

      const finalJob = await rawClient!.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(finalJob.status).toBe("COMPLETED");
      expect(finalJob.completedAt).not.toBeNull();

      const { runOutboxBatchOnce } = await import("@/lib/async/outbox-dispatcher");
      await runOutboxBatchOnce();
      const events = await rawClient!.outboxEvent.findMany({
        where: { aggregateId: order.id, eventType: "PRODUCT_RESERVATION_EXPIRED" },
      });
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe("PUBLISHED");
      const expiryNotifications = await rawClient!.notification.findMany({
        where: { orderId: order.id, title: "商品预留已过期" },
      });
      expect(expiryNotifications).toHaveLength(2);
    });
  },
);
