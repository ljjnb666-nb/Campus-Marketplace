import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";

import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * Phase 9B — 9B-E2E-01：PRODUCT 预留过期 → In-App + EMAIL 双渠道
 * （真实 async-worker + fake Resend HTTP provider）。
 *
 * 流程（任务书 §76/§77）：
 *   buyer 经正常 UI 创建 PRODUCT order → TEST-ONLY deadline advance
 *   → 真实 production worker（--run-once）cycle 1：reservation expire +
 *     outbox materialize → buyer/seller In-App 通知 + EMAIL delivery +
 *     NOTIFICATION_DELIVERY AsyncJob（同事务原子）
 *   → 启动 fake Resend provider（127.0.0.1 随机端口；worker env 注入
 *     RESEND_API_BASE_URL——NODE_ENV=test 允许，生产 env-check 禁止）
 *   → worker cycle 2：EMAIL jobs 执行 → 2 封逻辑邮件（buyer/seller 各 1）
 *   → §77 duplicate retry：buyer 的 key 第一次请求被 provider 受理但响应
 *     挂起（客户端超时）→ RETRY → 同 key 重放 → buyer 逻辑邮件仍 = 1
 *
 * 最终断言：
 *   buyer/seller 站内通知存在；fake provider buyer email = 1、seller = 1
 *   （逻辑口径 = 不同幂等键）；DB 2 条 EMAIL delivery providerAcceptedAt
 *   非空；2 个 EMAIL job COMPLETED。
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public";

// ---- fake Resend provider ----

type FakeBehavior = { kind: "ok"; messageId: string } | { kind: "hang" };
const fakeRequests: Array<{ key: string }> = [];
const fakeBehaviors = new Map<string, FakeBehavior[]>();
let fakeServer: Server | null = null;
let fakeBaseUrl = "";

function startFakeResendServer(): Promise<void> {
  return new Promise((resolve) => {
    fakeServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        const rawKey = req.headers["idempotency-key"];
        const key = Array.isArray(rawKey) ? rawKey[0] : (rawKey ?? "");
        fakeRequests.push({ key });

        const script = fakeBehaviors.get(key);
        const behavior: FakeBehavior =
          script && script.length > 0 ? script.shift()! : { kind: "ok", messageId: `msg-${key}` };
        if (behavior.kind === "hang") {
          return; // 受理但响应永远不到达 → 客户端 AbortSignal 超时
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: behavior.messageId }));
      });
    });
    fakeServer.listen(0, "127.0.0.1", () => {
      const address = fakeServer!.address();
      if (address === null || typeof address === "string") throw new Error("listen failed");
      fakeBaseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

function logicalEmailCount(): number {
  return new Set(fakeRequests.map((request) => request.key)).size;
}

function attemptsForKey(key: string): number {
  return fakeRequests.filter((request) => request.key === key).length;
}

function runProductionWorkerOnce(extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
          DATABASE_URL: E2E_DATABASE_URL,
          ...extraEnv,
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

test("9B-E2E-01：商品预留过期 → In-App + EMAIL 双渠道 → fake Resend 恰好 2 封逻辑邮件（§76/§77）", async ({ browser }) => {
  test.setTimeout(180_000);
  await startFakeResendServer();

  const tag = uniqueTag("p9b");
  const title = `9B双渠道过期商品 ${tag}`;
  const workerEmailEnv = {
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_e2e_local_key_000000000001",
    EMAIL_FROM: "E2E <noreply@e2e.test>",
    EMAIL_PROVIDER_TIMEOUT_MS: "1000",
    RESEND_API_BASE_URL: fakeBaseUrl,
    NEXTAUTH_URL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
  };

  try {
    // ---------- 卖家发布商品 ----------
    const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
    const seller = await sellerContext.newPage();
    await seller.goto("/products/new");
    await seller.locator('input[name="title"]').first().fill(title);
    await seller.locator('select[name="categoryId"]').first().selectOption({ label: "数码产品" });
    await seller.locator('input[name="price"]').first().fill("66");
    await seller.locator('input[name="locationText"]').first().fill("E2E 双渠道楼");
    await seller.locator('textarea[name="description"]').first().fill(`E2E Phase 9B ${tag}`);
    await seller.getByRole("button", { name: "确认发布商品" }).first().click();
    await seller.waitForURL(/\/products\/(?!new)[^/]+$/, { timeout: 30_000 });
    const productId = new URL(seller.url()).pathname.split("/").pop() ?? "";

    // ---------- 买家经正常 UI 下单 ----------
    const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
    const buyer = await buyerContext.newPage();
    await buyer.goto(`/products/${productId}`);
    await buyer.getByRole("button", { name: "立即购买" }).first().click();
    await buyer.locator('input[name="meetingLocation"]').fill("E2E 双渠道大厅");
    await buyer.getByRole("button", { name: "确认提交订单" }).click();
    await buyer.waitForURL(/\/my\/orders/, { timeout: 20_000 });

    const order = await e2eDb().order.findFirst({ where: { productId } });
    expect(order?.status).toBe("PENDING");
    const orderId = order!.id;

    // ---------- TEST-ONLY DEADLINE ADVANCE ----------
    const advanced = new Date(Date.now() - 1000);
    await e2eDb().order.update({
      where: { id: orderId },
      data: { productReservationExpiresAt: advanced },
    });
    await e2eDb().asyncJob.update({
      where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${orderId}` },
      data: { runAt: advanced },
    });

    // ---------- worker cycle 1：expire + outbox materialize（通知 + EMAIL 意图）----------
    const cycle1 = await runProductionWorkerOnce(workerEmailEnv);
    expect(cycle1.code, `stdout=${cycle1.stdout}\nstderr=${cycle1.stderr}`).toBe(0);

    const outbox = await e2eDb().outboxEvent.findUnique({
      where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRED:${orderId}` },
    });
    expect(outbox).not.toBeNull();
    expect(outbox!.status).toBe("PUBLISHED");

    const notifications = await e2eDb().notification.findMany({
      where: { orderId, title: "商品预留已过期" },
    });
    expect(notifications).toHaveLength(2);
    expect(new Set(notifications.map((n) => n.userId))).toEqual(
      new Set([order!.buyerId, order!.sellerId]),
    );
    for (const notification of notifications) {
      expect(notification.kind).toBe("PRODUCT_RESERVATION_EXPIRED");
      expect(notification.schemaVersion).toBe(1);
      expect(notification.payload).toEqual({
        orderId,
        buyerId: order!.buyerId,
        sellerId: order!.sellerId,
      });
    }

    // 同事务原子：2 条 EMAIL delivery + 2 个 NOTIFICATION_DELIVERY job
    const deliveries = await e2eDb().notificationDelivery.findMany({
      where: { notificationId: { in: notifications.map((n) => n.id) }, channel: "EMAIL" },
    });
    expect(deliveries).toHaveLength(2);
    for (const delivery of deliveries) {
      expect(delivery.provider).toBe("resend");
      expect(delivery.providerAcceptedAt).toBeNull();
      expect(delivery.suppressedAt).toBeNull();
      expect(delivery.providerIdempotencyKey).toBe(
        `notification/${delivery.notificationId}/email/v1`,
      );
    }

    // ---------- §77 duplicate retry：buyer 的 key 第一次受理但响应丢失 ----------
    const buyerEmail = (
      await e2eDb().user.findUniqueOrThrow({ where: { id: order!.buyerId } })
    ).email;
    const buyerDelivery = deliveries.find((delivery) => delivery.destination === buyerEmail)!;
    expect(buyerDelivery).toBeDefined();
    fakeBehaviors.set(buyerDelivery.providerIdempotencyKey, [
      { kind: "hang" },
      { kind: "ok", messageId: "msg-buyer-stable" },
    ]);

    // ---------- worker cycle 2：EMAIL jobs 执行（buyer 超时 → RETRY；seller 完成）----------
    const cycle2 = await runProductionWorkerOnce(workerEmailEnv);
    expect(cycle2.code, `stdout=${cycle2.stdout}\nstderr=${cycle2.stderr}`).toBe(0);

    const sellerDelivery = deliveries.find((delivery) => delivery.id !== buyerDelivery.id)!;
    await expect
      .poll(async () => {
        const row = await e2eDb().notificationDelivery.findUniqueOrThrow({ where: { id: sellerDelivery.id } });
        return row.providerAcceptedAt === null ? null : row.providerMessageId;
      })
      .toMatch(/^msg-/);

    // ---------- buyer RETRY（9A backoff 5s 后）→ 同 key 重放 → 逻辑邮件仍 1 ----------
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const cycle3 = await runProductionWorkerOnce(workerEmailEnv);
    expect(cycle3.code, `stdout=${cycle3.stdout}\nstderr=${cycle3.stderr}`).toBe(0);

    const buyerRow = await e2eDb().notificationDelivery.findUniqueOrThrow({
      where: { id: buyerDelivery.id },
    });
    expect(buyerRow.providerAcceptedAt).not.toBeNull();
    expect(buyerRow.providerMessageId).toBe("msg-buyer-stable");

    // ---------- 最终状态（§76）----------
    expect(attemptsForKey(buyerDelivery.providerIdempotencyKey)).toBe(2);
    expect(attemptsForKey(sellerDelivery.providerIdempotencyKey)).toBe(1);
    expect(logicalEmailCount()).toBe(2);

    const jobKeys = deliveries.map((delivery) => `NOTIFICATION_DELIVERY:${delivery.id}`);
    const jobs = await e2eDb().asyncJob.findMany({ where: { dedupeKey: { in: jobKeys } } });
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.status).toBe("COMPLETED");
      expect(job.completedAt).not.toBeNull();
    }

    // ---------- 浏览器：买家/卖家通知中心 ----------
    await buyer.goto("/notifications");
    await expect(buyer.getByText("商品预留已过期").first()).toBeVisible();
    await expect(buyer.getByText("卖家未在确认期限内接受订单，商品预留已自动释放。").first()).toBeVisible();

    await seller.goto("/notifications");
    await expect(seller.getByText("商品预留已过期").first()).toBeVisible();
    await expect(seller.getByText("该商品订单已超过确认期限，预留已自动释放。").first()).toBeVisible();

    await buyerContext.close();
    await sellerContext.close();
  } finally {
    await new Promise<void>((resolve) => fakeServer?.close(() => resolve()));
  }
});
