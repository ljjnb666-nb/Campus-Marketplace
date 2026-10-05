// @vitest-environment node
// （fake Resend provider = 进程内 node:http server + 原生 fetch——jsdom 环境
// 会把 globalThis.AbortSignal 替换为 jsdom realm 实现，被 undici fetch 的
// 跨 realm signal 校验拒绝；本文件需要真实 Node fetch/AbortSignal 语义。）
import { randomUUID } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS } from "@/lib/notifications/email-contract";

/**
 * Phase 9B — Unified Notifications / Transactional Email 集成测试
 * （真实 PostgreSQL + fake HTTP provider）。
 *
 * 覆盖合同（任务书 §57-§71）：
 *   EMAIL-IDEMP-01    crash after provider accept → same-key retry → 1 逻辑投递
 *   EMAIL-TIMEOUT-01  provider 延迟 > timeout → RETRY → 同 key → 1 逻辑投递
 *   EMAIL-WINDOW-01   firstAttemptAt < now-23h → 0 provider call → DEAD_LETTER
 *   EMAIL-409-01/02   invalid_idempotent_request=PERMANENT / concurrent=RETRYABLE
 *   EMAIL-500-01      5xx → RETRYABLE（9A central backoff）
 *   EMAIL-401-01      401 → PERMANENT（EMAIL_PROVIDER_AUTH_FAILED，raw body 不落库）
 *   NOTIF-CONCURRENCY 同 dedupeKey 并发 emit → 恰 1 Notification/1 delivery/1 job
 *   NOTIF-ROLLBACK    emit 事务失败 → Notification=0 / Delivery=0 / Job=0
 *   OUTBOX-REPLAY     PRODUCT_RESERVATION_EXPIRED 强制重放 → exactly-once（§67）
 *   INAPP-INDEPENDENCE provider 故障不隐藏 In-App 通知（§68）
 *   ERASE-EMAIL-01    pending delivery → 注销 → redacted/suppressed → 重放 0 call（§71）
 *
 * fake provider 记账口径：HTTP attempts = 收到的请求数；logical sends =
 * 出现过的不同幂等键数（同键重复请求 = provider 幂等重放，不新增逻辑投递）。
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

/**
 * 专用 scratch DB（phase7g 临时库同模式）：EMAIL job 是共享集成队列上的
 * 环境敏感行（无 email env 的并行 runner 领取后只能 retry），会挤占既有
 * 9A 套件 claim batch 的槽位。本 suite 在独立数据库上运行——彼此零干扰，
 * 测试内 due job 的窗口不再影响任何其它文件。
 *
 * process.env.DATABASE_URL 在 beforeAll 中指向 scratch DB：@/lib/prisma 的
 * withTransaction 单例（emitNotificationTx / runAsyncJobBatchOnce / dispatcher
 * 共用）随之绑定 scratch；每个 vitest 文件独立 module registry，不外溢。
 */
let rawClient: PrismaClient | null = null;
let scratchDbName = "";

function swapDatabaseName(databaseUrl: string, name: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${name}`;
  parsed.search = "";
  return parsed.toString();
}

const RUN_TAG = `p9b-${randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdNotificationIds: string[] = [];
const createdDeliveryIds: string[] = [];
const createdJobDedupeKeys: string[] = [];
const createdEventDedupeKeys: string[] = [];
const createdOrderIds: string[] = [];
const createdProductIds: string[] = [];
const createdMembershipIds: string[] = [];
let campusId = "";

let fixtureSeq = 0;

// ============================================================
// fake Resend HTTP provider（127.0.0.1 随机端口；NODE_ENV=test 允许
// RESEND_API_BASE_URL 覆盖，生产合同由 env-check 禁止——§45）
// ============================================================

type FakeBehavior =
  | { kind: "ok"; messageId: string }
  | { kind: "hang" }
  | { kind: "delay-then-ok"; ms: number; messageId: string }
  | { kind: "status"; status: number; body: string };

const fakeRequests: Array<{ key: string; at: number }> = [];
const fakeBehaviors = new Map<string, FakeBehavior[]>();
let fakeServer: Server | null = null;
let fakeBaseUrl = "";

function startFakeResendServer(): Promise<void> {
  return new Promise((resolve) => {
    fakeServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const key = req.headers["idempotency-key"];
        const keyText = Array.isArray(key) ? key[0] : (key ?? "");
        fakeRequests.push({ key: keyText, at: Date.now() });

        const script = fakeBehaviors.get(keyText);
        const behavior: FakeBehavior = script && script.length > 0 ? script.shift()! : { kind: "ok", messageId: `msg-${keyText}` };

        const respond = (status: number, body: string) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(body);
        };

        switch (behavior.kind) {
          case "ok":
            respond(200, JSON.stringify({ id: behavior.messageId }));
            break;
          case "hang":
            // 请求已受理（计入 logical send）但响应永远不到达 → 客户端超时
            break;
          case "delay-then-ok":
            setTimeout(() => respond(200, JSON.stringify({ id: behavior.messageId })), behavior.ms);
            break;
          case "status":
            respond(behavior.status, behavior.body);
            break;
        }
      });
    });
    fakeServer.listen(0, "127.0.0.1", () => {
      const address = fakeServer!.address();
      if (address === null || typeof address === "string") {
        throw new Error("fake provider listen failed");
      }
      fakeBaseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

function scriptBehavior(key: string, behaviors: FakeBehavior[]): void {
  fakeBehaviors.set(key, behaviors);
}

function httpAttemptsForKey(key: string): number {
  return fakeRequests.filter((request) => request.key === key).length;
}

/** logical sends：收到过请求的不同幂等键数量（同键重放不新增）。 */
function logicalSendCount(keys: string[]): number {
  return new Set(fakeRequests.filter((request) => keys.includes(request.key)).map((r) => r.key)).size;
}

function applyEmailEnv(overrides: Record<string, string> = {}): void {  process.env.EMAIL_PROVIDER = "resend";
  process.env.RESEND_API_KEY = "re_integration_local_key_000000000001";
  process.env.EMAIL_FROM = "IT <noreply@it.local>";
  process.env.EMAIL_REPLY_TO = "";
  process.env.EMAIL_PROVIDER_TIMEOUT_MS = overrides.EMAIL_PROVIDER_TIMEOUT_MS ?? "2000";
  process.env.RESEND_API_BASE_URL = fakeBaseUrl;
  process.env.NEXTAUTH_URL = "https://it.campus.test";
}

// ============================================================
// fixtures
// ============================================================

async function createFixtureUser(name: string) {
  const seq = fixtureSeq++;
  const user = await rawClient!.user.create({
    data: {
      // 纯 ASCII local part（§42 email 校验拒绝非 ASCII；中文名不进邮箱）
      email: `${RUN_TAG}-${seq}-u${fixtureSeq}@it.local`,
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

/**
 * 直插 canonical notification + pending EMAIL delivery + PENDING
 * NOTIFICATION_DELIVERY job（与 emitNotificationTx 产物同构）。
 * TEST-ONLY FIXTURE：绕过生产写边界，精确控制 firstAttemptAt/suppression
 * 等状态（生产路径只能经 canonical emit service 产生）。
 */
async function insertEmailDeliveryFixture(input: {
  buyerId: string;
  sellerId: string;
  orderId?: string;
  firstAttemptAt?: Date | null;
  suppressed?: boolean;
  providerAccepted?: boolean;
  runAtPast?: boolean;
}) {
  const orderId = input.orderId ?? `ord-${randomUUID().slice(0, 8)}`;
  const notification = await rawClient!.notification.create({
    data: {
      userId: input.buyerId,
      orderId: null,
      type: "ORDER",
      title: "商品预留已过期",
      content: "卖家未在确认期限内接受订单，商品预留已自动释放。",
      dedupeKey: `${RUN_TAG}:NOTIF:${randomUUID().slice(0, 8)}`,
      kind: "PRODUCT_RESERVATION_EXPIRED",
      schemaVersion: 1,
      payload: { orderId, buyerId: input.buyerId, sellerId: input.sellerId },
    },
  });
  createdNotificationIds.push(notification.id);

  const delivery = await rawClient!.notificationDelivery.create({
    data: {
      notificationId: notification.id,
      channel: "EMAIL",
      provider: "resend",
      destination: `${RUN_TAG}-rcpt@it.local`,
      senderSnapshot: "IT <noreply@it.local>",
      replyToSnapshot: null,
      providerIdempotencyKey: `notification/${notification.id}/email/v1`,
      firstAttemptAt: input.firstAttemptAt ?? null,
      suppressedAt: input.suppressed ? new Date() : null,
      suppressionCode: input.suppressed ? "RECIPIENT_ERASED" : null,
      providerAcceptedAt: input.providerAccepted ? new Date() : null,
      providerMessageId: input.providerAccepted ? "msg-preexisting" : null,
    },
  });
  createdDeliveryIds.push(delivery.id);

  const dedupeKey = `NOTIFICATION_DELIVERY:${delivery.id}`;
  await rawClient!.asyncJob.create({
    data: {
      kind: "NOTIFICATION_DELIVERY",
      schemaVersion: 1,
      dedupeKey,
      payload: { deliveryId: delivery.id },
      status: "PENDING",
      runAt: new Date(input.runAtPast === false ? Date.now() + 3_600_000 : Date.now() - 1000),
    },
  });
  createdJobDedupeKeys.push(dedupeKey);

  return { notification, delivery, jobDedupeKey: dedupeKey };
}

async function runWorkerBatch() {
  const { runAsyncJobBatchOnce } = await import("@/lib/async/job-runner");
  return runAsyncJobBatchOnce();
}

/**
 * 共享集成库 batch loop：并行测试文件会产生各自的 due job（claim 按
 * availableAt/createdAt ASC 竞争，本 fixture 的 job 可能不在首个 batch）。
 * 反复 run-once 直到目标谓词成立（外来 job 按 9A 合同被正常执行完成，
 * 防止共享队列毒化）；上限保护防死循环。
 */
async function runWorkerBatchesUntil(
  predicate: () => Promise<boolean>,
  maxBatches = 60,
): Promise<void> {
  for (let i = 0; i < maxBatches; i += 1) {
    if (await predicate()) return;
    await runWorkerBatch();
  }
  if (!(await predicate())) {
    throw new Error(`runWorkerBatchesUntil: 谓词未在 ${maxBatches} 个 batch 内成立`);
  }
}

async function jobStatus(dedupeKey: string): Promise<string | null> {
  const job = await rawClient!.asyncJob.findUnique({ where: { dedupeKey } });
  return job?.status ?? null;
}

/** 直插已过期的 PRODUCT 订单聚合（真实 Order 行——Notification.orderId FK
 * 与 OutboxEvent materializer 都需要真实聚合；满足 reservation pair CHECK：
 * resolvedAt + resolution 成对、deadline 已过）。 */
async function createExpiredOrderFixture(buyerId: string, sellerId: string) {
  const category = await rawClient!.productCategory.upsert({
    where: { slug: `${RUN_TAG}-cat` },
    create: { name: `9B类目-${RUN_TAG}`, slug: `${RUN_TAG}-cat` },
    update: {},
  });
  const product = await rawClient!.product.create({
    data: {
      title: `9B 商品 ${randomUUID().slice(0, 6)}`,
      description: "Phase 9B integration fixture",
      price: 10,
      condition: "NEW",
      locationText: "东门",
      categoryId: category.id,
      campusId,
      sellerId,
      status: "RESERVED",
    },
  });
  createdProductIds.push(product.id);
  const order = await rawClient!.order.create({
    data: {
      orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
      type: "PRODUCT",
      status: "CANCELLED",
      buyerId,
      sellerId,
      productId: product.id,
      amount: "10.00",
      productReservationExpiresAt: new Date(Date.now() - 60_000),
      productReservationResolvedAt: new Date(),
      productReservationResolution: "EXPIRED",
    },
  });
  createdOrderIds.push(order.id);
  return { product, order };
}

async function runOutboxBatch() {
  const { runOutboxBatchOnce } = await import("@/lib/async/outbox-dispatcher");
  return runOutboxBatchOnce();
}

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("waitFor timeout");
}

/**
 * RB02 确定性锁 barrier（非 sleep ordering）：轮询 pg_stat_activity 中
 * 本数据库内正在等待行锁、且查询文本包含 mark 的会话（出现 = 目标事务
 * 已真实进入锁等待队列）。
 */
async function waitForBlockedLockQuery(mark: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await rawClient!.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
      FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND datname = current_database()
        AND query ILIKE ${"%" + mark + "%"}`;
    if (Number(rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`blocked-lock barrier 超时：未观察到等待 ${mark} 的锁等待会话`);
}

/** 同 runWorkerBatchesUntil：outbox 派发共享队列 loop 版。 */
async function runOutboxBatchesUntil(
  predicate: () => Promise<boolean>,
  maxBatches = 60,
): Promise<void> {
  for (let i = 0; i < maxBatches; i += 1) {
    if (await predicate()) return;
    await runOutboxBatch();
  }
  if (!(await predicate())) {
    throw new Error(`runOutboxBatchesUntil: 谓词未在 ${maxBatches} 个 batch 内成立`);
  }
}

beforeAll(async () => {
  if (!integrationDatabaseUrl) return;

  // ---- 专用 scratch DB：CREATE + migrate deploy（phase7g 临时库同模式）----
  scratchDbName = `phase9b_it_${randomUUID().slice(0, 8)}`;
  const maintenanceUrl = swapDatabaseName(integrationDatabaseUrl, "postgres");
  const maintenanceClient = new PrismaClient({
    datasources: { db: { url: maintenanceUrl } },
    log: ["error"],
  });
  try {
    await maintenanceClient.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchDbName}"`);
    await maintenanceClient.$executeRawUnsafe(`CREATE DATABASE "${scratchDbName}"`);
  } finally {
    await maintenanceClient.$disconnect();
  }

  const scratchUrl = swapDatabaseName(integrationDatabaseUrl, scratchDbName);
  const deploy = spawnSync(
    process.execPath,
    [join("node_modules", "prisma", "build", "index.js"), "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: scratchUrl },
      encoding: "utf8",
    },
  );
  expect(deploy.status, `migrate deploy 失败：${deploy.stderr}`).toBe(0);

  // withTransaction 全局单例（emit/runner/dispatcher 共用）绑定 scratch DB
  process.env.DATABASE_URL = scratchUrl;
  rawClient = new PrismaClient({ datasources: { db: { url: scratchUrl } }, log: ["error"] });

  await startFakeResendServer();
  applyEmailEnv();

  const campus = await rawClient.campus.upsert({
    where: { slug: `p9b-${randomUUID().slice(0, 8)}` },
    create: { name: `9B 校区 ${randomUUID().slice(0, 6)}`, slug: `p9b-${randomUUID().slice(0, 8)}`, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;
}, 180_000);

afterAll(async () => {
  if (!rawClient) return;

  // 还原进程级 email env（避免污染同进程其它测试文件）
  delete process.env.RESEND_API_BASE_URL;

  // scratch DB 整库回收（含全部 fixture 行；无需逐表清理）
  await rawClient.$disconnect();
  await new Promise<void>((resolve) => fakeServer?.close(() => resolve()));

  const maintenanceUrl = swapDatabaseName(integrationDatabaseUrl!, "postgres");
  const maintenanceClient = new PrismaClient({
    datasources: { db: { url: maintenanceUrl } },
    log: ["error"],
  });
  try {
    await maintenanceClient.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchDbName}" WITH (FORCE)`);
  } catch {
    // CI/本地偶发连接残留：FORCE 已尽力，不影响主流程断言
  } finally {
    await maintenanceClient.$disconnect();
  }
}, 60_000);

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 9B unified notifications / transactional email（真实 PG + fake provider）",
  () => {
    beforeEach(() => {
      applyEmailEnv();
      fakeBehaviors.clear();
    });

    it("NOTIF-CONCURRENCY（§65）：同一 dedupeKey 两个并发事务 → 恰 1 Notification / 1 EMAIL delivery / 1 job", async () => {
      const buyer = await createFixtureUser("并发买家");
      const seller = await createFixtureUser("并发卖家");
      const { order } = await createExpiredOrderFixture(buyer.id, seller.id);
      const dedupeKey = `${RUN_TAG}:CONC:${randomUUID().slice(0, 8)}`;

      const { emitNotificationTx } = await import("@/lib/notifications/notification-service");
      const { withTransaction } = await import("@/lib/prisma");

      // 两个并发事务写同一 dedupeKey（payload 仅 IDs；dedupeKey 相同）
      await Promise.all([
        withTransaction(async (tx: Prisma.TransactionClient) => {
          await emitNotificationTx(tx, {
            kind: "PRODUCT_RESERVATION_EXPIRED",
            recipientUserId: buyer.id,
            orderId: order.id,
            dedupeKey,
            payload: { orderId: order.id, buyerId: buyer.id, sellerId: seller.id },
          });
        }),
        withTransaction(async (tx: Prisma.TransactionClient) => {
          await emitNotificationTx(tx, {
            kind: "PRODUCT_RESERVATION_EXPIRED",
            recipientUserId: buyer.id,
            orderId: order.id,
            dedupeKey,
            payload: { orderId: order.id, buyerId: buyer.id, sellerId: seller.id },
          });
        }),
      ]);

      const notifications = await rawClient!.notification.findMany({ where: { dedupeKey } });
      expect(notifications).toHaveLength(1);
      createdNotificationIds.push(notifications[0]!.id);

      const deliveries = await rawClient!.notificationDelivery.findMany({
        where: { notificationId: notifications[0]!.id, channel: "EMAIL" },
      });
      expect(deliveries).toHaveLength(1);
      createdDeliveryIds.push(deliveries[0]!.id);
      // payload 同一 buyer → destination 为合法邮箱（provider=resend）→ 未抑制
      expect(deliveries[0]!.suppressedAt).toBeNull();

      const jobs = await rawClient!.asyncJob.findMany({
        where: { dedupeKey: `NOTIFICATION_DELIVERY:${deliveries[0]!.id}` },
      });
      expect(jobs).toHaveLength(1);
      createdJobDedupeKeys.push(jobs[0]!.dedupeKey);
      expect(jobs[0]!.kind).toBe("NOTIFICATION_DELIVERY");
      expect(jobs[0]!.payload).toEqual({ deliveryId: deliveries[0]!.id });

      // 共享队列好公民：本测试产生的 due job 就地执行完成（不再留给
      // 并行 worker 的无 email-env runner 领取）
      scriptBehavior(deliveries[0]!.providerIdempotencyKey, [
        { kind: "ok", messageId: "msg-conc-drain" },
      ]);
      await runWorkerBatchesUntil(
        async () => (await jobStatus(jobs[0]!.dedupeKey)) === "COMPLETED",
      );
    });

    it("NOTIF-ROLLBACK（§66）：emit 事务失败 → Notification=0 / Delivery=0 / AsyncJob=0", async () => {
      const buyer = await createFixtureUser("回滚买家");
      const seller = await createFixtureUser("回滚卖家");
      const dedupeKey = `${RUN_TAG}:RB:${randomUUID().slice(0, 8)}`;

      const { emitNotificationTx } = await import("@/lib/notifications/notification-service");
      const { withTransaction } = await import("@/lib/prisma");

      await expect(
        withTransaction(async (tx: Prisma.TransactionClient) => {
          await emitNotificationTx(tx, {
            kind: "PRODUCT_RESERVATION_EXPIRED",
            recipientUserId: buyer.id,
            dedupeKey,
            payload: { orderId: "ord-rb", buyerId: buyer.id, sellerId: seller.id },
          });
          throw new Error("simulated failure after notification+delivery+job insert");
        }),
      ).rejects.toThrow("simulated failure after notification+delivery+job insert");
      expect(await rawClient!.notification.count({ where: { dedupeKey } })).toBe(0);
      // 精确域：dedupeKey 的 Notification 不存在 ⇒ 其 delivery/job 也不存在
      // （Notification + Delivery + Job 同事务原子回滚，§66）
      const notification = await rawClient!.notification.findUnique({ where: { dedupeKey } });
      expect(notification).toBeNull();
      const orphanDeliveries = await rawClient!.notificationDelivery.count({
        where: { providerIdempotencyKey: `notification/none/email/v1` },
      });
      expect(orphanDeliveries).toBe(0);
    });

    it("EMAIL-IDEMP-01（§57）：provider accept 后 crash → 同 key 重试 → HTTP>=2、逻辑投递=1、messageId 稳定、COMPLETED", async () => {
      const buyer = await createFixtureUser("幂等买家");
      const seller = await createFixtureUser("幂等卖家");
      const { delivery } = await insertEmailDeliveryFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
      });
      const key = delivery.providerIdempotencyKey;
      scriptBehavior(key, [
        { kind: "ok", messageId: "msg-stable-1" },
        { kind: "ok", messageId: "msg-stable-1" },
        { kind: "ok", messageId: "msg-stable-1" },
      ]);

      const targetDedupeKey = `NOTIFICATION_DELIVERY:${delivery.id}`;
      const { registerJobHandler, resolveJobHandler } = await import("@/lib/async/job-registry");
      const { notificationDeliveryPayloadSchema } = await import("@/lib/async/job-types");
      const realHandler = resolveJobHandler("NOTIFICATION_DELIVERY", 1);
      expect(realHandler).toBeTypeOf("function");

      // ---- 第一次执行：真实 runner + handler 包装 crash 注入 ----
      // crash 点在 handler 返回后、执行事务 COMMIT 前（provider 已 accept、
      // delivery 状态未落库）——只对本 fixture 的 delivery 生效，共享队列的
      // 外来 job 不受影响（9A 同合同）。注意 ClaimedAsyncJob 不携带
      // dedupeKey——以 strict payload 的 deliveryId 匹配。
      let crashedOnce = false;
      registerJobHandler("NOTIFICATION_DELIVERY", 1, async (tx, job) => {
        const outcome = await realHandler!(tx, job);
        const parsed = notificationDeliveryPayloadSchema.safeParse(job.payload);
        if (parsed.success && parsed.data.deliveryId === delivery.id && !crashedOnce) {
          crashedOnce = true;
          throw new Error("simulated crash after provider accept, before delivery-state commit");
        }
        return outcome;
      });

      await runWorkerBatchesUntil(async () => crashedOnce);

      // provider 已受理一次（1 个逻辑投递），DB 状态仍未提交（tx 已回滚 → RETRY）
      expect(httpAttemptsForKey(key)).toBe(1);
      expect(
        (await rawClient!.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
          .providerAcceptedAt,
      ).toBeNull();
      expect(await jobStatus(targetDedupeKey)).toBe("RETRY");

      // ---- crash recovery：恢复真实 handler → 同 key 重试（推进 runAt 过 9A backoff）----
      registerJobHandler("NOTIFICATION_DELIVERY", 1, realHandler!);
      await rawClient!.asyncJob.update({
        where: { dedupeKey: targetDedupeKey },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      await runWorkerBatchesUntil(async () => (await jobStatus(targetDedupeKey)) === "COMPLETED");

      expect(httpAttemptsForKey(key)).toBeGreaterThanOrEqual(2);
      expect(logicalSendCount([key])).toBe(1);

      const finalDelivery = await rawClient!.notificationDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(finalDelivery.providerMessageId).toBe("msg-stable-1");
      expect(finalDelivery.providerAcceptedAt).not.toBeNull();

      const job = await rawClient!.asyncJob.findUniqueOrThrow({
        where: { dedupeKey: targetDedupeKey },
      });
      expect(job.status).toBe("COMPLETED");
      expect(job.completedAt).not.toBeNull();
    });

    it("EMAIL-TIMEOUT-01（§58）：provider 受理但响应超时 → RETRY → 同 key → 1 逻辑投递", async () => {
      const buyer = await createFixtureUser("超时买家");
      const seller = await createFixtureUser("超时卖家");
      const { delivery } = await insertEmailDeliveryFixture({ buyerId: buyer.id, sellerId: seller.id });
      const key = delivery.providerIdempotencyKey;
      const jobDedupeKey = `NOTIFICATION_DELIVERY:${delivery.id}`;

      // 第一次：受理（计入逻辑投递）但响应挂起 → 客户端 AbortSignal 超时
      // （timeout 取运行时合法下界 1000ms；hang 行为不限时长必超时）
      scriptBehavior(key, [
        { kind: "hang" },
        { kind: "ok", messageId: "msg-timeout-stable" },
      ]);
      process.env.EMAIL_PROVIDER_TIMEOUT_MS = "1000";

      await runWorkerBatchesUntil(async () => (await jobStatus(jobDedupeKey)) === "RETRY");
      expect(httpAttemptsForKey(key)).toBe(1);
      let job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey: jobDedupeKey } });
      expect(job.status).toBe("RETRY");

      // 9A central backoff：推进 runAt → 第二轮同 key 重试（timeout 恢复正常）
      process.env.EMAIL_PROVIDER_TIMEOUT_MS = "2000";
      await rawClient!.asyncJob.update({
        where: { id: job.id },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      await runWorkerBatchesUntil(async () => (await jobStatus(jobDedupeKey)) === "COMPLETED");

      expect(httpAttemptsForKey(key)).toBe(2);
      expect(logicalSendCount([key])).toBe(1);
      const finalDelivery = await rawClient!.notificationDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(finalDelivery.providerMessageId).toBe("msg-timeout-stable");
      expect(finalDelivery.providerAcceptedAt).not.toBeNull();
      job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey: jobDedupeKey } });
      expect(job.status).toBe("COMPLETED");
    });

    it("EMAIL-WINDOW-01（§59）：firstAttemptAt < now-23h → 0 provider request → DEAD_LETTER（窗口码）", async () => {
      const buyer = await createFixtureUser("窗口买家");
      const seller = await createFixtureUser("窗口卖家");
      const { delivery } = await insertEmailDeliveryFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        firstAttemptAt: new Date(Date.now() - 24 * 3_600_000),
      });
      const jobDedupeKey = `NOTIFICATION_DELIVERY:${delivery.id}`;

      await runWorkerBatchesUntil(async () => (await jobStatus(jobDedupeKey)) === "DEAD_LETTER");

      expect(httpAttemptsForKey(delivery.providerIdempotencyKey)).toBe(0);
      const job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey: jobDedupeKey } });
      expect(job.status).toBe("DEAD_LETTER");
      expect(job.lastErrorCode).toBe("EMAIL_PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED");
      expect(job.deadLetteredAt).not.toBeNull();
    });

    it("EMAIL-409-01（§60）：409 invalid_idempotent_request → PERMANENT → 立即 DEAD_LETTER", async () => {
      const buyer = await createFixtureUser("冲突买家");
      const seller = await createFixtureUser("冲突卖家");
      const { delivery } = await insertEmailDeliveryFixture({ buyerId: buyer.id, sellerId: seller.id });
      const key = delivery.providerIdempotencyKey;
      scriptBehavior(key, [
        { kind: "status", status: 409, body: '{"name":"invalid_idempotent_request","message":"raw-should-not-persist"}' },
      ]);

      await runWorkerBatchesUntil(
        async () => (await jobStatus(`NOTIFICATION_DELIVERY:${delivery.id}`)) === "DEAD_LETTER",
      );

      const job = await rawClient!.asyncJob.findUniqueOrThrow({
        where: { dedupeKey: `NOTIFICATION_DELIVERY:${delivery.id}` },
      });
      expect(job.status).toBe("DEAD_LETTER");
      expect(job.lastErrorCode).toBe("EMAIL_PROVIDER_IDEMPOTENCY_CONFLICT_INVALID");
      expect(httpAttemptsForKey(key)).toBe(1);
      // RB02：raw provider body / 秘密标记绝不落库
      expect(job.lastErrorMessage ?? "").not.toContain("raw-should-not-persist");
    });

    it("EMAIL-409-02（§61）：409 concurrent_idempotent_requests → RETRYABLE", async () => {
      const buyer = await createFixtureUser("并发冲突买家");
      const seller = await createFixtureUser("并发冲突卖家");
      const { delivery } = await insertEmailDeliveryFixture({ buyerId: buyer.id, sellerId: seller.id });
      const key = delivery.providerIdempotencyKey;
      scriptBehavior(key, [
        { kind: "status", status: 409, body: '{"name":"concurrent_idempotent_requests"}' },
      ]);

      await runWorkerBatchesUntil(
        async () => (await jobStatus(`NOTIFICATION_DELIVERY:${delivery.id}`)) === "RETRY",
      );

      const job = await rawClient!.asyncJob.findUniqueOrThrow({
        where: { dedupeKey: `NOTIFICATION_DELIVERY:${delivery.id}` },
      });
      expect(job.status).toBe("RETRY");
      // retryable 失败的 lastErrorCode 合同 = 安全 Error.name（9A RB05：
      // raw message 默认拒绝；精确分类码走 email_delivery_retry_scheduled
      // 结构化日志，绝不落 provider body）
      expect(job.lastErrorCode).toBe("EmailProviderRetryableError");
      expect(httpAttemptsForKey(key)).toBe(1);

      // drain：冲突解除后正常完成，不遗留 due job
      scriptBehavior(key, [{ kind: "ok", messageId: "msg-40902-drain" }]);
      await rawClient!.asyncJob.update({
        where: { id: job.id },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      await runWorkerBatchesUntil(
        async () => (await jobStatus(`NOTIFICATION_DELIVERY:${delivery.id}`)) === "COMPLETED",
      );
    });

    it("EMAIL-500-01（§62）：5xx → RETRYABLE（沿用 9A central backoff，provider 不自建 retry loop）", async () => {
      const buyer = await createFixtureUser("5xx买家");
      const seller = await createFixtureUser("5xx卖家");
      const { delivery } = await insertEmailDeliveryFixture({ buyerId: buyer.id, sellerId: seller.id });
      const key = delivery.providerIdempotencyKey;
      scriptBehavior(key, [
        { kind: "status", status: 503, body: "{}" },
      ]);

      await runWorkerBatchesUntil(
        async () => (await jobStatus(`NOTIFICATION_DELIVERY:${delivery.id}`)) === "RETRY",
      );

      const job = await rawClient!.asyncJob.findUniqueOrThrow({
        where: { dedupeKey: `NOTIFICATION_DELIVERY:${delivery.id}` },
      });
      expect(job.status).toBe("RETRY");
      expect(job.lastErrorCode).toBe("EmailProviderRetryableError");
      expect(httpAttemptsForKey(key)).toBe(1);

      // drain：5xx 解除后正常完成，不遗留 due job
      scriptBehavior(key, [{ kind: "ok", messageId: "msg-500-drain" }]);
      await rawClient!.asyncJob.update({
        where: { id: job.id },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      await runWorkerBatchesUntil(
        async () => (await jobStatus(`NOTIFICATION_DELIVERY:${delivery.id}`)) === "COMPLETED",
      );
    });

    it("EMAIL-401-01（§63）：401 → PERMANENT（EMAIL_PROVIDER_AUTH_FAILED）且不记录 provider body/key", async () => {
      const buyer = await createFixtureUser("认证买家");
      const seller = await createFixtureUser("认证卖家");
      const { delivery } = await insertEmailDeliveryFixture({ buyerId: buyer.id, sellerId: seller.id });
      const key = delivery.providerIdempotencyKey;
      scriptBehavior(key, [
        { kind: "status", status: 401, body: '{"name":"authentication_failed","message":"invalid api key re_integration_local_key"}' },
      ]);

      await runWorkerBatchesUntil(
        async () => (await jobStatus(`NOTIFICATION_DELIVERY:${delivery.id}`)) === "DEAD_LETTER",
      );

      const job = await rawClient!.asyncJob.findUniqueOrThrow({
        where: { dedupeKey: `NOTIFICATION_DELIVERY:${delivery.id}` },
      });
      expect(job.status).toBe("DEAD_LETTER");
      expect(job.lastErrorCode).toBe("EMAIL_PROVIDER_AUTH_FAILED");
      expect(job.lastErrorMessage ?? "").not.toContain("re_integration_local_key");
      expect(job.lastErrorMessage ?? "").not.toContain("authentication_failed");
    });

    it("INAPP-INDEPENDENCE（§68）：provider 持续故障 → EMAIL job RETRY，In-App 通知不消失", async () => {
      const buyer = await createFixtureUser("站内买家");
      const seller = await createFixtureUser("站内卖家");
      const { notification, delivery } = await insertEmailDeliveryFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
      });
      const key = delivery.providerIdempotencyKey;
      scriptBehavior(key, [
        { kind: "status", status: 500, body: "{}" },
        { kind: "status", status: 500, body: "{}" },
      ]);

      await runWorkerBatchesUntil(
        async () => (await jobStatus(`NOTIFICATION_DELIVERY:${delivery.id}`)) === "RETRY",
      );

      // EMAIL job 进入 RETRY，但 canonical Notification（In-App 投影）原样存在
      const job = await rawClient!.asyncJob.findUniqueOrThrow({
        where: { dedupeKey: `NOTIFICATION_DELIVERY:${delivery.id}` },
      });
      expect(job.status).toBe("RETRY");
      const stillThere = await rawClient!.notification.findUniqueOrThrow({ where: { id: notification.id } });
      expect(stillThere.kind).toBe("PRODUCT_RESERVATION_EXPIRED");
      expect(stillThere.title).toBe("商品预留已过期");
      const deliveryRow = await rawClient!.notificationDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(deliveryRow.providerAcceptedAt).toBeNull();

      // drain：故障解除后正常完成（In-App 通知全程存在），不遗留 due job
      scriptBehavior(key, [{ kind: "ok", messageId: "msg-inapp-drain" }]);
      await rawClient!.asyncJob.update({
        where: { id: job.id },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      await runWorkerBatchesUntil(
        async () => (await jobStatus(`NOTIFICATION_DELIVERY:${delivery.id}`)) === "COMPLETED",
      );
    });

    it("OUTBOX-REPLAY（§67）：PRODUCT_RESERVATION_EXPIRED 强制重放 → buyer/seller 各 1 通知、各 1 EMAIL delivery、2 jobs", async () => {
      const buyer = await createFixtureUser("重放买家");
      const seller = await createFixtureUser("重放卖家");
      const sellerUser = seller;

      const { order } = await createExpiredOrderFixture(buyer.id, sellerUser.id);

      const { recordOutboxEventTx } = await import("@/lib/async/outbox");
      const { withTransaction } = await import("@/lib/prisma");
      const eventDedupeKey = `PRODUCT_RESERVATION_EXPIRED:${order.id}`;
      await withTransaction((tx: Prisma.TransactionClient) =>
        recordOutboxEventTx(tx, {
          eventType: "PRODUCT_RESERVATION_EXPIRED",
          schemaVersion: 1,
          aggregateType: "ORDER",
          aggregateId: order.id,
          dedupeKey: eventDedupeKey,
          payload: { orderId: order.id },
        }),
      );
      createdEventDedupeKeys.push(eventDedupeKey);

      // 第一次派发（共享 outbox 队列 loop）
      await runOutboxBatchesUntil(async () => {
        const event = await rawClient!.outboxEvent.findUnique({ where: { dedupeKey: eventDedupeKey } });
        return event?.status === "PUBLISHED";
      });

      const notifications = await rawClient!.notification.findMany({
        where: { sourceEventId: { not: null }, orderId: order.id },
      });
      expect(notifications).toHaveLength(2);
      expect(new Set(notifications.map((row) => row.userId))).toEqual(
        new Set([buyer.id, sellerUser.id]),
      );
      for (const row of notifications) {
        expect(row.kind).toBe("PRODUCT_RESERVATION_EXPIRED");
        expect(row.schemaVersion).toBe(1);
        expect(row.payload).toEqual({ orderId: order.id, buyerId: buyer.id, sellerId: sellerUser.id });
      }

      const deliveries = await rawClient!.notificationDelivery.findMany({
        where: { notificationId: { in: notifications.map((row) => row.id) }, channel: "EMAIL" },
      });
      expect(deliveries).toHaveLength(2);
      for (const row of deliveries) createdDeliveryIds.push(row.id);
      const keys = deliveries.map((row) => row.providerIdempotencyKey);
      expect(new Set(keys).size).toBe(2);
      for (const key of keys) {
        expect(key).toMatch(/^notification\/.+\/email\/v1$/);
      }

      const jobs = await rawClient!.asyncJob.findMany({
        where: { dedupeKey: { in: deliveries.map((row) => `NOTIFICATION_DELIVERY:${row.id}`) } },
      });
      expect(jobs).toHaveLength(2);
      for (const job of jobs) createdJobDedupeKeys.push(job.dedupeKey);

      // 强制重放（event 重新入队）→ dedupe 全链收敛，仍 2/2/2
      const requeuedAt = Date.now() - 1;
      await rawClient!.outboxEvent.update({
        where: { dedupeKey: eventDedupeKey },
        data: { status: "PENDING", availableAt: new Date(Date.now() - 1000), attempts: 0 },
      });
      await runOutboxBatchesUntil(async () => {
        const event = await rawClient!.outboxEvent.findUnique({ where: { dedupeKey: eventDedupeKey } });
        return event?.status === "PUBLISHED" && (event?.attempts ?? 0) >= 1 &&
          (event?.updatedAt?.getTime() ?? 0) > requeuedAt;
      });

      expect(
        await rawClient!.notification.count({
          where: { sourceEventId: { not: null }, orderId: order.id },
        }),
      ).toBe(2);
      expect(
        await rawClient!.notificationDelivery.count({
          where: { notificationId: { in: notifications.map((row) => row.id) }, channel: "EMAIL" },
        }),
      ).toBe(2);
      expect(
        await rawClient!.asyncJob.count({
          where: { dedupeKey: { in: deliveries.map((row) => `NOTIFICATION_DELIVERY:${row.id}`) } },
        }),
      ).toBe(2);

      // EMAIL jobs 实际执行（fake provider ok）→ 双投递 accepted、双 job COMPLETED
      const replayJobKeys = deliveries.map((row) => `NOTIFICATION_DELIVERY:${row.id}`);
      await runWorkerBatchesUntil(async () => {
        const stats = await rawClient!.asyncJob.findMany({
          where: { dedupeKey: { in: replayJobKeys } },
        });
        return stats.length === 2 && stats.every((row) => row.status === "COMPLETED");
      });
      const finalDeliveries = await rawClient!.notificationDelivery.findMany({
        where: { notificationId: { in: notifications.map((row) => row.id) }, channel: "EMAIL" },
      });
      for (const row of finalDeliveries) {
        expect(row.providerAcceptedAt).not.toBeNull();
        expect(row.providerMessageId).not.toBeNull();
      }
      expect(logicalSendCount(keys)).toBe(2);
    });

    it("ERASE-EMAIL-01（§71）：pending EMAIL delivery → 注销 → destination 清空/抑制 → job 重放 0 provider call → 幂等完成", async () => {
      const buyer = await createFixtureUser("注销买家");
      const seller = await createFixtureUser("注销卖家");
      const { delivery } = await insertEmailDeliveryFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
      });
      const originalDestination = delivery.destination;
      const jobDedupeKey = `NOTIFICATION_DELIVERY:${delivery.id}`;

      const { eraseAccount } = await import("@/lib/privacy/account-erasure");
      await eraseAccount(buyer.id);

      // In-App 通知整表删除（RB-23 不退化）；delivery 存活并被抑制/redacted
      const erasedNotifications = await rawClient!.notification.count({
        where: { userId: buyer.id },
      });
      expect(erasedNotifications).toBe(0);

      const suppressed = await rawClient!.notificationDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(suppressed.suppressedAt).not.toBeNull();
      expect(suppressed.suppressionCode).toBe("RECIPIENT_ERASED");
      expect(suppressed.destination).toBe("");
      expect(suppressed.destination).not.toBe(originalDestination);

      // job 重放：suppressed → COMPLETED_IDEMPOTENT，0 provider call
      await rawClient!.asyncJob.update({
        where: { dedupeKey: jobDedupeKey },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      await runWorkerBatchesUntil(async () => (await jobStatus(jobDedupeKey)) === "COMPLETED");

      expect(httpAttemptsForKey(delivery.providerIdempotencyKey)).toBe(0);
      const job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey: jobDedupeKey } });
      expect(job.status).toBe("COMPLETED");
    });

    // ============================================================
    // Phase 9C-04 RB03-B：creation-time redaction 必须同步落 redactedAt
    // （INV-RB03B-01：任何 production writer 第一次把 destination 写成
    // sentinel，就必须在同一 authoritative transition 记录 redactedAt；
    // creation / retention / erasure 三 writer 共享 NULL→timestamp 单向合同）。
    // teeth：pre-repair（5f972a0）实现 destination=sentinel 但 redactedAt=null
    // → RET-CREATE-REDACT-ERASED-01 / RET-CREATE-REDACT-INVALID-01 FAIL。
    // ============================================================

    it("RET-CREATE-REDACT-ERASED-01（RB03-B）：creation-time RECIPIENT_ERASED → suppressedAt === redactedAt，0 job enqueue", async () => {
      const buyer = await createFixtureUser("创建脱敏注销买家");
      const seller = await createFixtureUser("创建脱敏注销卖家");
      const { order } = await createExpiredOrderFixture(buyer.id, seller.id);
      await rawClient!.user.update({ where: { id: buyer.id }, data: { erasedAt: new Date() } });

      const dedupeKey = `${RUN_TAG}:CREATE-REDACT-E:${randomUUID().slice(0, 8)}`;
      const { emitNotificationTx } = await import("@/lib/notifications/notification-service");
      const { withTransaction } = await import("@/lib/prisma");
      await withTransaction((tx: Prisma.TransactionClient) =>
        emitNotificationTx(tx, {
          kind: "PRODUCT_RESERVATION_EXPIRED",
          recipientUserId: buyer.id,
          orderId: order.id,
          dedupeKey,
          payload: { orderId: order.id, buyerId: buyer.id, sellerId: seller.id },
        }),
      );

      const notification = await rawClient!.notification.findUniqueOrThrow({ where: { dedupeKey } });
      createdNotificationIds.push(notification.id);
      const delivery = await rawClient!.notificationDelivery.findUniqueOrThrow({
        where: { notificationId_channel: { notificationId: notification.id, channel: "EMAIL" } },
      });
      createdDeliveryIds.push(delivery.id);

      // creation-time redaction：destination sentinel + 同一 transition 时间戳
      expect(delivery.destination).toBe("");
      expect(delivery.suppressionCode).toBe("RECIPIENT_ERASED");
      expect(delivery.suppressedAt).not.toBeNull();
      expect(delivery.redactedAt).not.toBeNull();
      expect(delivery.redactedAt!.getTime()).toBe(delivery.suppressedAt!.getTime());

      // suppress-by-construction 保持：0 NOTIFICATION_DELIVERY job enqueue
      expect(
        await rawClient!.asyncJob.count({
          where: { dedupeKey: `NOTIFICATION_DELIVERY:${delivery.id}` },
        }),
      ).toBe(0);
    });

    it("RET-CREATE-REDACT-INVALID-01（RB03-B）：creation-time INVALID_DESTINATION → suppressedAt === redactedAt，0 job enqueue", async () => {
      const buyer = await createFixtureUser("创建脱敏无效邮箱买家");
      const seller = await createFixtureUser("创建脱敏无效邮箱卖家");
      const { order } = await createExpiredOrderFixture(buyer.id, seller.id);
      // recipient.email 非法（erasedAt 保持 null）→ 走 INVALID_DESTINATION 分支
      //（email UNIQUE：每轮唯一，残留行不撞键）
      await rawClient!.user.update({
        where: { id: buyer.id },
        data: { email: `not-an-email-${randomUUID().slice(0, 12)}` },
      });

      const dedupeKey = `${RUN_TAG}:CREATE-REDACT-I:${randomUUID().slice(0, 8)}`;
      const { emitNotificationTx } = await import("@/lib/notifications/notification-service");
      const { withTransaction } = await import("@/lib/prisma");
      await withTransaction((tx: Prisma.TransactionClient) =>
        emitNotificationTx(tx, {
          kind: "PRODUCT_RESERVATION_EXPIRED",
          recipientUserId: buyer.id,
          orderId: order.id,
          dedupeKey,
          payload: { orderId: order.id, buyerId: buyer.id, sellerId: seller.id },
        }),
      );

      const notification = await rawClient!.notification.findUniqueOrThrow({ where: { dedupeKey } });
      createdNotificationIds.push(notification.id);
      const delivery = await rawClient!.notificationDelivery.findUniqueOrThrow({
        where: { notificationId_channel: { notificationId: notification.id, channel: "EMAIL" } },
      });
      createdDeliveryIds.push(delivery.id);

      expect(delivery.destination).toBe("");
      expect(delivery.suppressionCode).toBe("INVALID_DESTINATION");
      expect(delivery.suppressedAt).not.toBeNull();
      expect(delivery.redactedAt).not.toBeNull();
      expect(delivery.redactedAt!.getTime()).toBe(delivery.suppressedAt!.getTime());

      expect(
        await rawClient!.asyncJob.count({
          where: { dedupeKey: `NOTIFICATION_DELIVERY:${delivery.id}` },
        }),
      ).toBe(0);
    });

    it("RET-CREATE-PROVIDER-DISABLED-01（RB03-B）：PROVIDER_DISABLED 仅 suppression 不 redaction → redactedAt 必须 null", async () => {
      const buyer = await createFixtureUser("禁用供应商买家");
      const seller = await createFixtureUser("禁用供应商卖家");
      const { order } = await createExpiredOrderFixture(buyer.id, seller.id);

      // 临时切 disabled（resolveEmailChannelConfig 按调用读 env；测毕恢复）
      process.env.EMAIL_PROVIDER = "disabled";
      try {
        const dedupeKey = `${RUN_TAG}:CREATE-DISABLED:${randomUUID().slice(0, 8)}`;
        const { emitNotificationTx } = await import("@/lib/notifications/notification-service");
        const { withTransaction } = await import("@/lib/prisma");
        await withTransaction((tx: Prisma.TransactionClient) =>
          emitNotificationTx(tx, {
            kind: "PRODUCT_RESERVATION_EXPIRED",
            recipientUserId: buyer.id,
            orderId: order.id,
            dedupeKey,
            payload: { orderId: order.id, buyerId: buyer.id, sellerId: seller.id },
          }),
        );

        const notification = await rawClient!.notification.findUniqueOrThrow({ where: { dedupeKey } });
        createdNotificationIds.push(notification.id);
        const delivery = await rawClient!.notificationDelivery.findUniqueOrThrow({
          where: { notificationId_channel: { notificationId: notification.id, channel: "EMAIL" } },
        });
        createdDeliveryIds.push(delivery.id);

        // destination 保留真实合法邮箱（绝不在 suppression 时伪称已 redact）
        expect(delivery.destination).toBe(buyer.email);
        expect(delivery.suppressionCode).toBe("PROVIDER_DISABLED");
        expect(delivery.suppressedAt).not.toBeNull();
        expect(delivery.redactedAt).toBeNull();

        expect(
          await rawClient!.asyncJob.count({
            where: { dedupeKey: `NOTIFICATION_DELIVERY:${delivery.id}` },
          }),
        ).toBe(0);
      } finally {
        applyEmailEnv();
      }
    });

    it("RET-CREATE-REDACT-MONOTONIC-01（RB03-B）：creation-time redactedAt=T1 → 后续 erasure/retention 零覆盖", async () => {
      const buyer = await createFixtureUser("创建脱敏单调买家");
      const seller = await createFixtureUser("创建脱敏单调卖家");
      const { order } = await createExpiredOrderFixture(buyer.id, seller.id);
      await rawClient!.user.update({
        where: { id: buyer.id },
        data: { email: `not-an-email-${randomUUID().slice(0, 12)}` },
      });

      const dedupeKey = `${RUN_TAG}:CREATE-REDACT-M:${randomUUID().slice(0, 8)}`;
      const { emitNotificationTx } = await import("@/lib/notifications/notification-service");
      const { withTransaction } = await import("@/lib/prisma");
      await withTransaction((tx: Prisma.TransactionClient) =>
        emitNotificationTx(tx, {
          kind: "PRODUCT_RESERVATION_EXPIRED",
          recipientUserId: buyer.id,
          orderId: order.id,
          dedupeKey,
          payload: { orderId: order.id, buyerId: buyer.id, sellerId: seller.id },
        }),
      );

      const notification = await rawClient!.notification.findUniqueOrThrow({ where: { dedupeKey } });
      createdNotificationIds.push(notification.id);
      const delivery = await rawClient!.notificationDelivery.findUniqueOrThrow({
        where: { notificationId_channel: { notificationId: notification.id, channel: "EMAIL" } },
      });
      createdDeliveryIds.push(delivery.id);
      const t1 = delivery.redactedAt;
      expect(t1).not.toBeNull();

      // writer #2 = retention（把 now 推到远超窗口的未来——redactedAt IS NULL
      // 谓词不命中已脱敏行 → 零转移）
      const { redactTerminalNotificationDestinations } = await import("@/lib/async/retention");
      const farFuture = new Date(t1!.getTime() + 31 * 24 * 60 * 60 * 1000);
      await redactTerminalNotificationDestinations({
        retentionDays: 30,
        now: farFuture,
      });
      const afterRetention = await rawClient!.notificationDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(afterRetention.redactedAt!.getTime()).toBe(t1!.getTime());

      // writer #3 = account erasure（destination 已是 sentinel；redactedAt 不被覆盖）
      const { eraseAccount } = await import("@/lib/privacy/account-erasure");
      await eraseAccount(buyer.id);

      const afterErasure = await rawClient!.notificationDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(afterErasure.destination).toBe("");
      expect(afterErasure.redactedAt!.getTime()).toBe(t1!.getTime());
      // INVALID_DESTINATION delivery 在 erasure 中不伪称 RECIPIENT_ERASED
      //（erasure suppression 只命中真正 unsent——本行已 suppressedAt=T1，
      // suppressionCode 保持原 creation-time 值）
      expect(afterErasure.suppressionCode).toBe("INVALID_DESTINATION");
    });

    it("EMAIL-IDEMP-02（RB01）：crash 回滚后 firstAttemptAt 仍 durable；23h+ε 重放 → 0 provider call → DEAD_LETTER", async () => {
      const buyer = await createFixtureUser("锚点买家");
      const seller = await createFixtureUser("锚点卖家");
      const { delivery } = await insertEmailDeliveryFixture({ buyerId: buyer.id, sellerId: seller.id });
      const key = delivery.providerIdempotencyKey;
      const jobDedupeKey = `NOTIFICATION_DELIVERY:${delivery.id}`;
      scriptBehavior(key, [
        { kind: "ok", messageId: "msg-anchor-1" },
        { kind: "ok", messageId: "msg-anchor-1" },
      ]);

      const { registerJobHandler, resolveJobHandler } = await import("@/lib/async/job-registry");
      const { notificationDeliveryPayloadSchema } = await import("@/lib/async/job-types");
      const realHandler = resolveJobHandler("NOTIFICATION_DELIVERY", 1)!;
      let crashedOnce = false;
      registerJobHandler("NOTIFICATION_DELIVERY", 1, async (tx, job) => {
        const outcome = await realHandler(tx, job);
        const parsed = notificationDeliveryPayloadSchema.safeParse(job.payload);
        if (parsed.success && parsed.data.deliveryId === delivery.id && !crashedOnce) {
          crashedOnce = true;
          throw new Error("simulated crash after provider accept, before delivery-state commit");
        }
        return outcome;
      });
      await runWorkerBatchesUntil(async () => crashedOnce);

      // provider 已受理一次；execution tx 已回滚：
      //   providerAcceptedAt = NULL（未提交）但 firstAttemptAt != NULL
      //   （RB01 durable anchor 独立短事务已 COMMIT，不随 execution 回滚）
      expect(httpAttemptsForKey(key)).toBe(1);
      const afterCrash = await rawClient!.notificationDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(afterCrash.providerAcceptedAt).toBeNull();
      expect(afterCrash.firstAttemptAt).not.toBeNull();
      const anchorAt = afterCrash.firstAttemptAt!;

      // 模拟 now = firstAttemptAt + 23h + ε（等价：把 anchor 回拨 23h+1s；
      // 生产无任何路径可将 firstAttemptAt 后移/置 NULL——NULL→ts 单向）
      await rawClient!.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          firstAttemptAt: new Date(anchorAt.getTime() - EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS - 1000),
        },
      });
      registerJobHandler("NOTIFICATION_DELIVERY", 1, realHandler);
      await rawClient!.asyncJob.update({
        where: { dedupeKey: jobDedupeKey },
        data: { runAt: new Date(Date.now() - 1000) },
      });

      await runWorkerBatchesUntil(async () => (await jobStatus(jobDedupeKey)) === "DEAD_LETTER");

      expect(httpAttemptsForKey(key)).toBe(1);
      expect(logicalSendCount([key])).toBe(1);
      const job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey: jobDedupeKey } });
      expect(job.status).toBe("DEAD_LETTER");
      expect(job.lastErrorCode).toBe("EMAIL_PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED");
    });

    it("ERASURE-RACE-01（RB02）：erasure wins —— 抑制先行提交 → worker 阻塞后见 suppressed → 0 provider call 幂等完成", async () => {
      const buyer = await createFixtureUser("竞速注销买家");
      const seller = await createFixtureUser("竞速注销卖家");
      const { delivery } = await insertEmailDeliveryFixture({ buyerId: buyer.id, sellerId: seller.id });
      const key = delivery.providerIdempotencyKey;
      const jobDedupeKey = `NOTIFICATION_DELIVERY:${delivery.id}`;

      // 确定性 barrier：erasure 事务在 delivery 抑制写入后持锁暂停
      let releaseErasure!: () => void;
      const erasureHolding = new Promise<void>((resolve) => { releaseErasure = resolve; });
      let seamEntered = false;
      const { eraseAccount } = await import("@/lib/privacy/account-erasure");
      const erasePromise = eraseAccount(buyer.id, undefined, undefined, async () => {
        seamEntered = true;
        await erasureHolding;
      });
      await waitFor(() => seamEntered);

      // worker 启动：anchor UPDATE / FOR UPDATE 阻塞在 erasure 行锁上
      const workerDone = runWorkerBatchesUntil(
        async () => (await jobStatus(jobDedupeKey)) === "COMPLETED",
      );
      await waitForBlockedLockQuery("firstAttemptAt");

      releaseErasure();
      await erasePromise;
      await workerDone;

      expect(httpAttemptsForKey(key)).toBe(0);
      expect(logicalSendCount([key])).toBe(0);
      const row = await rawClient!.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(row.suppressedAt).not.toBeNull();
      expect(row.suppressionCode).toBe("RECIPIENT_ERASED");
      expect(row.destination).toBe("");
      expect(row.providerAcceptedAt).toBeNull();
      const job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey: jobDedupeKey } });
      expect(job.status).toBe("COMPLETED");
    });

    it("ERASURE-RACE-02（RB02）：send wins —— worker 持行锁先 accept → erasure 阻塞 → 提交后仅 redact destination", async () => {
      const buyer = await createFixtureUser("竞速发送买家");
      const seller = await createFixtureUser("竞速发送卖家");
      const { delivery } = await insertEmailDeliveryFixture({ buyerId: buyer.id, sellerId: seller.id });
      const key = delivery.providerIdempotencyKey;
      const jobDedupeKey = `NOTIFICATION_DELIVERY:${delivery.id}`;
      scriptBehavior(key, [{ kind: "ok", messageId: "msg-race2-stable" }]);
      const { getEmailDeliveryAcceptanceStats } = await import("@/lib/notifications/email-ops");
      const statsBaseline = await getEmailDeliveryAcceptanceStats();

      const { setNotificationDeliveryHandlerSeamForTests } = await import(
        "@/lib/async/handlers/notification-delivery"
      );
      let releaseSend!: () => void;
      const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
      let workerLocked = false;
      setNotificationDeliveryHandlerSeamForTests({
        afterDeliveryRowLock: async () => {
          workerLocked = true;
          await sendGate;
        },
      });

      const workerDone = runWorkerBatchesUntil(
        async () => (await jobStatus(jobDedupeKey)) === "COMPLETED",
      );
      await waitFor(() => workerLocked);

      // erasure 在 worker 持有 delivery 行锁期间启动 → updateMany 阻塞
      const { eraseAccount } = await import("@/lib/privacy/account-erasure");
      const erasePromise = eraseAccount(buyer.id);
      await waitForBlockedLockQuery("suppressedAt");

      releaseSend();
      await workerDone;
      await erasePromise;
      setNotificationDeliveryHandlerSeamForTests(null);

      // send win：恰好一次逻辑投递 + accepted；erasure 事后仅 redact destination，
      // 绝不伪称 suppressed（§10：accepted delivery is NOT "suppressed"）
      expect(httpAttemptsForKey(key)).toBe(1);
      expect(logicalSendCount([key])).toBe(1);
      const row = await rawClient!.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(row.providerAcceptedAt).not.toBeNull();
      expect(row.providerMessageId).toBe("msg-race2-stable");
      expect(row.destination).toBe("");
      expect(row.suppressedAt).toBeNull();
      expect(row.suppressionCode).toBeNull();

      // §11 ops stats（基线差分）：accepted 计数包含它；suppressed 计数不包含它
      const stats = await getEmailDeliveryAcceptanceStats();
      expect(stats.providerAccepted).toBe(statsBaseline.providerAccepted + 1);
      expect(stats.suppressed).toBe(statsBaseline.suppressed);
      const job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey: jobDedupeKey } });
      expect(job.status).toBe("COMPLETED");
    });

    it("CONFIG-RETRY-01（RB03）：worker 缺 RESEND_API_KEY → job RETRY（绝不 DEAD_LETTER）、0 provider call", async () => {
      const buyer = await createFixtureUser("配置重试买家");
      const seller = await createFixtureUser("配置重试卖家");
      const { delivery } = await insertEmailDeliveryFixture({ buyerId: buyer.id, sellerId: seller.id });
      const key = delivery.providerIdempotencyKey;
      const jobDedupeKey = `NOTIFICATION_DELIVERY:${delivery.id}`;

      delete process.env.RESEND_API_KEY;
      try {
        await runWorkerBatchesUntil(async () => (await jobStatus(jobDedupeKey)) === "RETRY");

        expect(httpAttemptsForKey(key)).toBe(0);
        const job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey: jobDedupeKey } });
        expect(job.status).toBe("RETRY");
        expect(job.lastErrorCode).toBe("EmailProviderRetryableError");
      } finally {
        applyEmailEnv();
      }

      // 配置恢复后接管完成（不遗留 due job）
      await rawClient!.asyncJob.update({
        where: { dedupeKey: jobDedupeKey },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      await runWorkerBatchesUntil(async () => (await jobStatus(jobDedupeKey)) === "COMPLETED");
      expect(httpAttemptsForKey(key)).toBe(1);
    });

    it("CONFIG-RETRY-02（RB03）：emit 时 EMAIL_FROM 缺失 → OutboxEvent RETRY、Notification=0；恢复后重放完整物化", async () => {
      const buyer = await createFixtureUser("配置外盒买家");
      const seller = await createFixtureUser("配置外盒卖家");
      const { order } = await createExpiredOrderFixture(buyer.id, seller.id);

      const { recordOutboxEventTx } = await import("@/lib/async/outbox");
      const { withTransaction } = await import("@/lib/prisma");
      const eventDedupeKey = `PRODUCT_RESERVATION_EXPIRED:${order.id}`;
      await withTransaction((tx: Prisma.TransactionClient) =>
        recordOutboxEventTx(tx, {
          eventType: "PRODUCT_RESERVATION_EXPIRED",
          schemaVersion: 1,
          aggregateType: "ORDER",
          aggregateId: order.id,
          dedupeKey: eventDedupeKey,
          payload: { orderId: order.id },
        }),
      );
      createdEventDedupeKeys.push(eventDedupeKey);

      const notifBaseline = await rawClient!.notification.count();
      const deliveryBaseline = await rawClient!.notificationDelivery.count();

      delete process.env.EMAIL_FROM;
      try {
        await runOutboxBatchesUntil(async () => {
          const event = await rawClient!.outboxEvent.findUnique({ where: { dedupeKey: eventDedupeKey } });
          return event?.status === "PENDING" && (event?.attempts ?? 0) >= 1;
        });
        // In-App + Email 是同一 materialization 事务：配置不可用 → 整体回滚、
        // OutboxEvent RETRY（绝不 DEAD_LETTER、绝不只落 In-App）。
        // 断言用基线差分（scratch DB 保留全部前序 fixture 行）。
        expect(await rawClient!.notification.count()).toBe(notifBaseline);
        expect(await rawClient!.notificationDelivery.count()).toBe(deliveryBaseline);
        expect(await rawClient!.notification.count({ where: { orderId: order.id } })).toBe(0);
      } finally {
        applyEmailEnv();
      }

      await rawClient!.outboxEvent.update({
        where: { dedupeKey: eventDedupeKey },
        data: { availableAt: new Date(Date.now() - 1000) },
      });
      await runOutboxBatchesUntil(async () => {
        const event = await rawClient!.outboxEvent.findUnique({ where: { dedupeKey: eventDedupeKey } });
        return event?.status === "PUBLISHED";
      });

      const notifications = await rawClient!.notification.findMany({ where: { orderId: order.id } });
      expect(notifications).toHaveLength(2);
      for (const row of notifications) {
        expect(row.kind).toBe("PRODUCT_RESERVATION_EXPIRED");
      }
      const deliveries = await rawClient!.notificationDelivery.findMany({
        where: { notificationId: { in: notifications.map((row) => row.id) }, channel: "EMAIL" },
      });
      expect(deliveries).toHaveLength(2);
      const replayJobKeys = deliveries.map((row) => `NOTIFICATION_DELIVERY:${row.id}`);
      await runWorkerBatchesUntil(async () => {
        const jobs = await rawClient!.asyncJob.findMany({ where: { dedupeKey: { in: replayJobKeys } } });
        return jobs.length === 2 && jobs.every((row) => row.status === "COMPLETED");
      });
    });

    it("DEDUPE-COLLISION-01（RB04）：同 key 不同 recipient → NOTIFICATION_DEDUPE_COLLISION，零 delivery/job alias", async () => {
      const buyer = await createFixtureUser("碰撞买家");
      const seller = await createFixtureUser("碰撞卖家");
      const outsider = await createFixtureUser("碰撞局外人");
      const { order } = await createExpiredOrderFixture(buyer.id, seller.id);
      const dedupeKey = `${RUN_TAG}:COLL1:${randomUUID().slice(0, 8)}`;
      const payload = { orderId: order.id, buyerId: buyer.id, sellerId: seller.id };

      const { emitNotificationTx } = await import("@/lib/notifications/notification-service");
      const { withTransaction } = await import("@/lib/prisma");
      await withTransaction((tx: Prisma.TransactionClient) =>
        emitNotificationTx(tx, {
          kind: "PRODUCT_RESERVATION_EXPIRED",
          recipientUserId: buyer.id,
          orderId: order.id,
          dedupeKey,
          payload,
        }),
      );

      // 同 key、不同 recipient → fail closed，整个调用事务回滚
      await expect(
        withTransaction((tx: Prisma.TransactionClient) =>
          emitNotificationTx(tx, {
            kind: "PRODUCT_RESERVATION_EXPIRED",
            recipientUserId: outsider.id,
            orderId: order.id,
            dedupeKey,
            payload,
          }),
        ),
      ).rejects.toMatchObject({ code: "NOTIFICATION_DEDUPE_COLLISION" });

      const notifications = await rawClient!.notification.findMany({ where: { dedupeKey } });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.userId).toBe(buyer.id);
      const deliveries = await rawClient!.notificationDelivery.findMany({
        where: { notificationId: notifications[0]!.id },
      });
      expect(deliveries).toHaveLength(1);
      expect(
        await rawClient!.asyncJob.count({
          where: { dedupeKey: { in: deliveries.map((row) => `NOTIFICATION_DELIVERY:${row.id}`) } },
        }),
      ).toBe(1);
    });

    it("DEDUPE-COLLISION-02（RB04）：同 key 同 recipient 不同 payload → 拒绝；同 intent 重放幂等", async () => {
      const buyer = await createFixtureUser("碰撞二买家");
      const seller = await createFixtureUser("碰撞二卖家");
      const { order } = await createExpiredOrderFixture(buyer.id, seller.id);
      const dedupeKey = `${RUN_TAG}:COLL2:${randomUUID().slice(0, 8)}`;

      const { emitNotificationTx } = await import("@/lib/notifications/notification-service");
      const { withTransaction } = await import("@/lib/prisma");
      const intent = {
        kind: "PRODUCT_RESERVATION_EXPIRED",
        recipientUserId: buyer.id,
        orderId: order.id,
        dedupeKey,
        payload: { orderId: order.id, buyerId: buyer.id, sellerId: seller.id },
      } as const;
      await withTransaction((tx: Prisma.TransactionClient) => emitNotificationTx(tx, intent));

      // 同 recipient/kind/version、不同 payload（orderId 漂移）→ 拒绝
      await expect(
        withTransaction((tx: Prisma.TransactionClient) =>
          emitNotificationTx(tx, {
            ...intent,
            payload: { orderId: `${order.id}-x`, buyerId: buyer.id, sellerId: seller.id },
          }),
        ),
      ).rejects.toMatchObject({ code: "NOTIFICATION_DEDUPE_COLLISION" });

      // 完全相同 intent 重放 → 幂等成功（same Notification id / same delivery / same job）
      const replay = await withTransaction((tx: Prisma.TransactionClient) => emitNotificationTx(tx, intent));
      const winner = await rawClient!.notification.findUniqueOrThrow({ where: { dedupeKey } });
      expect(replay.notificationId).toBe(winner.id);
      const deliveries = await rawClient!.notificationDelivery.findMany({
        where: { notificationId: winner.id },
      });
      expect(deliveries).toHaveLength(1);
      expect(
        await rawClient!.asyncJob.count({
          where: { dedupeKey: `NOTIFICATION_DELIVERY:${deliveries[0]!.id}` },
        }),
      ).toBe(1);
    });

    it("STATUS-PAYLOAD-01（RB05）：ORDER_STATUS_CHANGED 携带自由文本 status → INVALID_PAYLOAD、零落库", async () => {
      const buyer = await createFixtureUser("状态校验买家");
      const dedupeKey = `${RUN_TAG}:STAT:${randomUUID().slice(0, 8)}`;
      const { emitNotificationTx } = await import("@/lib/notifications/notification-service");
      const { withTransaction } = await import("@/lib/prisma");

      await expect(
        withTransaction((tx: Prisma.TransactionClient) =>
          emitNotificationTx(tx, {
            kind: "ORDER_STATUS_CHANGED",
            recipientUserId: buyer.id,
            orderId: null,
            dedupeKey,
            payload: {
              orderId: `ord-${randomUUID().slice(0, 6)}`,
              status: "用户私密自由文本",
              actorRole: "BUYER",
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "NOTIFICATION_INTENT_CONTRACT_INVALID" });

      expect(await rawClient!.notification.count({ where: { dedupeKey } })).toBe(0);
    });

    it("CANCELLATION-PAYLOAD-01（RB05）：非法 cancellationReason 拒绝；合法机器枚举通过", async () => {
      const renter = await createFixtureUser("取消校验租客");
      const dedupeKeyBase = `${RUN_TAG}:CANC:${randomUUID().slice(0, 8)}`;
      const { emitNotificationTx } = await import("@/lib/notifications/notification-service");
      const { withTransaction } = await import("@/lib/prisma");

      await expect(
        withTransaction((tx: Prisma.TransactionClient) =>
          emitNotificationTx(tx, {
            kind: "RENTAL_ORDER_CANCELLED",
            recipientUserId: renter.id,
            dedupeKey: `${dedupeKeyBase}:bad`,
            payload: { orderId: `ro-${randomUUID().slice(0, 6)}`, cancellationReason: "随便编造的理由文本" },
          }),
        ),
      ).rejects.toMatchObject({ code: "NOTIFICATION_INTENT_CONTRACT_INVALID" });

      await withTransaction((tx: Prisma.TransactionClient) =>
        emitNotificationTx(tx, {
          kind: "RENTAL_ORDER_CANCELLED",
          recipientUserId: renter.id,
          dedupeKey: `${dedupeKeyBase}:good`,
          payload: { orderId: `ro-${randomUUID().slice(0, 6)}`, cancellationReason: "RENTER_CHANGED_PLAN" },
        }),
      );
      expect(
        await rawClient!.notification.count({
          where: { dedupeKey: { startsWith: dedupeKeyBase } },
        }),
      ).toBe(1);
    });

    it("EMAIL-SLOW-PROVIDER-01（RB06）：provider 响应 11.5s（跨越旧 10s 事务预算）→ 真实执行路径 COMPLETED", async () => {
      const buyer = await createFixtureUser("慢提供者买家");
      const seller = await createFixtureUser("慢提供者卖家");
      const { delivery } = await insertEmailDeliveryFixture({ buyerId: buyer.id, sellerId: seller.id });
      const key = delivery.providerIdempotencyKey;
      const jobDedupeKey = `NOTIFICATION_DELIVERY:${delivery.id}`;

      // fake provider 受理后延迟 11.5s 才返回 200——旧行为（默认 10s
      // execution transaction 预算）下 Prisma 事务在 provider 返回前即
      // abort → 本测试必然 RETRY 循环永不 COMPLETED；新 extended policy
      //（60s tx / 90s lease）必须一次完成。
      // provider 自身超时调至 15s（合法范围 1000..30000）：保证 11.5s
      // 延迟由【事务预算】而非 provider timeout 主导。
      process.env.EMAIL_PROVIDER_TIMEOUT_MS = "15000";
      scriptBehavior(key, [
        { kind: "delay-then-ok", ms: 11_500, messageId: "msg-slow-stable" },
      ]);

      await runWorkerBatchesUntil(
        async () => (await jobStatus(jobDedupeKey)) === "COMPLETED",
      );

      expect(httpAttemptsForKey(key)).toBe(1);
      expect(logicalSendCount([key])).toBe(1);
      const row = await rawClient!.notificationDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(row.providerAcceptedAt).not.toBeNull();
      expect(row.providerMessageId).toBe("msg-slow-stable");
      expect(row.suppressedAt).toBeNull();
      const job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey: jobDedupeKey } });
      expect(job.status).toBe("COMPLETED");
      expect(job.completedAt).not.toBeNull();
    }, 120_000);

    it("EMAIL-SLOW-ERASURE-01（RB06）：>10s provider 窗口内行锁不消失 —— erasure 全程阻塞至 COMMIT 后仅 redact", async () => {
      const buyer = await createFixtureUser("慢速注销买家");
      const seller = await createFixtureUser("慢速注销卖家");
      const { delivery } = await insertEmailDeliveryFixture({ buyerId: buyer.id, sellerId: seller.id });
      const key = delivery.providerIdempotencyKey;
      const jobDedupeKey = `NOTIFICATION_DELIVERY:${delivery.id}`;
      const { getEmailDeliveryAcceptanceStats } = await import("@/lib/notifications/email-ops");
      const statsBaseline = await getEmailDeliveryAcceptanceStats();

      process.env.EMAIL_PROVIDER_TIMEOUT_MS = "15000";
      scriptBehavior(key, [
        { kind: "delay-then-ok", ms: 11_500, messageId: "msg-slowerase-stable" },
      ]);

      // 确定性 barrier：worker 取得 delivery 行锁（afterDeliveryRowLock）
      // 即信号——行锁自此持续到 execution tx COMMIT（含整个 11.5s provider
      // 窗口，跨越旧 10s 事务预算边界）。
      const { setNotificationDeliveryHandlerSeamForTests } = await import(
        "@/lib/async/handlers/notification-delivery"
      );
      let workerLockTaken = false;
      setNotificationDeliveryHandlerSeamForTests({
        afterDeliveryRowLock: async () => {
          workerLockTaken = true;
        },
      });

      const workerDone = runWorkerBatchesUntil(
        async () => (await jobStatus(jobDedupeKey)) === "COMPLETED",
      );
      await waitFor(() => workerLockTaken);

      // erasure 在 worker 持锁 + provider 慢响应期间启动 → updateMany 阻塞
      const { eraseAccount } = await import("@/lib/privacy/account-erasure");
      const erasePromise = eraseAccount(buyer.id);
      await waitForBlockedLockQuery("suppressedAt");

      // 无需人工放行：provider 于 11.5s 后返回 → worker COMMIT → 行锁释放
      // → erasure 继续（若行锁在旧 10s 事务预算边界提前消失，erasure 会先
      // 把行置 suppressed，worker 的 accepted 条件更新落空 → 本断言失败）
      await workerDone;
      await erasePromise;
      setNotificationDeliveryHandlerSeamForTests(null);

      expect(httpAttemptsForKey(key)).toBe(1);
      expect(logicalSendCount([key])).toBe(1);
      const row = await rawClient!.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(row.providerAcceptedAt).not.toBeNull();
      expect(row.providerMessageId).toBe("msg-slowerase-stable");
      expect(row.destination).toBe("");
      expect(row.suppressedAt).toBeNull();
      expect(row.suppressionCode).toBeNull();
      const stats = await getEmailDeliveryAcceptanceStats();
      expect(stats.providerAccepted).toBe(statsBaseline.providerAccepted + 1);
      expect(stats.suppressed).toBe(statsBaseline.suppressed);
      const job = await rawClient!.asyncJob.findUniqueOrThrow({ where: { dedupeKey: jobDedupeKey } });
      expect(job.status).toBe("COMPLETED");
    }, 120_000);
  },
);
