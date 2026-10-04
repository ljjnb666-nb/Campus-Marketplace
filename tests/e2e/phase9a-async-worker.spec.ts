import { spawn } from "node:child_process";
import path from "node:path";

import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";
import { withE2EAsyncWorkerProtocolLock } from "./helpers/async-worker-lock";

/**
 * Phase 9A — 9A-E2E-01：reservation expiry 由真实 async-worker 自动 materialize。
 *
 * 流程（任务书 §61/§62）：
 *   buyer 经正常 UI 创建 PRODUCT order → Product RESERVED + AsyncJob durable
 *   intent 已存在（与 Order 同事务落盘）
 *   → TEST-ONLY DEADLINE ADVANCE（仅推进 productReservationExpiresAt 与
 *     AsyncJob.runAt 到过去；绝不直接修改 Order.status / Product.status /
 *     resolution / job.status）
 *   → 调用真实 production worker entrypoint（scripts/ops/async-worker.ts
 *     --run-once；与 compose async-worker 服务同一入口；scheduler 绝不是
 *     Next app 内的 setInterval——§62 禁止架构）
 *   → 浏览器 reload：buyer / seller 订单徽标 = 已取消；通知中心出现
 *     「商品预留已过期」
 *   → DB：resolution = EXPIRED、job = COMPLETED、outbox = PUBLISHED、
 *     expiry 通知恰好一次（dedupeKey DB 级幂等）
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public";

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
          DATABASE_URL: E2E_DATABASE_URL,
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

test("9A-E2E-01：商品预留到期 → async-worker 自动过期释放 + outbox 通知 exactly-once", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p9a");
  const title = `9A异步过期商品 ${tag}`;

  // ---------- 卖家发布商品 ----------
  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const seller = await sellerContext.newPage();
  await seller.goto("/products/new");
  await seller.locator('input[name="title"]').first().fill(title);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "数码产品" });
  await seller.locator('input[name="price"]').first().fill("66");
  await seller.locator('input[name="locationText"]').first().fill("E2E 异步楼");
  await seller.locator('textarea[name="description"]').first().fill(`E2E Phase 9A ${tag}`);
  await seller.getByRole("button", { name: "确认发布商品" }).first().click();
  await seller.waitForURL(/\/products\/(?!new)[^/]+$/, { timeout: 30_000 });
  const productId = new URL(seller.url()).pathname.split("/").pop() ?? "";

  // ---------- 买家经正常 UI 下单 ----------
  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyer = await buyerContext.newPage();
  await buyer.goto(`/products/${productId}`);
  await buyer.getByRole("button", { name: "立即购买" }).first().click();
  await buyer.locator('input[name="meetingLocation"]').fill("E2E 异步大厅");
  await buyer.getByRole("button", { name: "确认提交订单" }).click();
  await buyer.waitForURL(/\/my\/orders/, { timeout: 20_000 });

  const order = await e2eDb().order.findFirst({ where: { productId } });
  expect(order?.status).toBe("PENDING");
  const orderId = order!.id;

  // Order exists ⇔ durable expiry intent exists（同事务原子落盘）
  const job = await e2eDb().asyncJob.findUnique({
    where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${orderId}` },
  });
  expect(job).not.toBeNull();
  expect(job!.kind).toBe("PRODUCT_RESERVATION_EXPIRE");
  expect(job!.schemaVersion).toBe(1);
  expect(job!.status).toBe("PENDING");
  expect(job!.payload).toEqual({ orderId });
  expect(job!.runAt.getTime()).toBe(order!.productReservationExpiresAt!.getTime());
  expect(
    (await e2eDb().product.findUniqueOrThrow({ where: { id: productId } })).status,
  ).toBe("RESERVED");

  // ---------- TEST-ONLY DEADLINE ADVANCE → worker → DB final assertions ----------
  // RB06：本 spec 的 worker runtime 虽为普通 env，但仍可 claim 9B 的专属
  // email jobs——整个 queue protocol（deadline advance → worker execution →
  // target AsyncJob/Outbox/Notification 终态断言）纳入同一个 E2E
  // async-worker protocol 互斥锁（跨 Playwright worker 进程）。
  await withE2EAsyncWorkerProtocolLock("phase9a-async-worker", async () => {
    // 仅推进时间字段（deadline + job.runAt）到过去；Order.status / Product.status /
    // productReservationResolution / AsyncJob.status 一律不直接修改——业务状态
    // 只能由 canonical lifecycle（expireProductReservationTx）写入。
    const advanced = new Date(Date.now() - 1000);
    await e2eDb().order.update({
      where: { id: orderId },
      data: { productReservationExpiresAt: advanced },
    });
    await e2eDb().asyncJob.update({
      where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${orderId}` },
      data: { runAt: advanced },
    });

    // ---------- 真实 production worker entrypoint（--run-once）----------
    const result = await runProductionWorkerOnce();
    expect(result.code, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);

    // ---------- DB 最终状态 ----------
    await expect
      .poll(async () => {
        const finalOrder = await e2eDb().order.findUniqueOrThrow({ where: { id: orderId } });
        return {
          status: finalOrder.status,
          resolution: finalOrder.productReservationResolution,
        };
      })
      .toEqual({ status: "CANCELLED", resolution: "EXPIRED" });

    expect(
      (await e2eDb().product.findUniqueOrThrow({ where: { id: productId } })).status,
    ).toBe("ACTIVE");

    const completedJob = await e2eDb().asyncJob.findUnique({
      where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${orderId}` },
    });
    expect(completedJob!.status).toBe("COMPLETED");
    expect(completedJob!.completedAt).not.toBeNull();

    const outbox = await e2eDb().outboxEvent.findUnique({
      where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRED:${orderId}` },
    });
    expect(outbox).not.toBeNull();
    expect(outbox!.status).toBe("PUBLISHED");
    expect(outbox!.publishedAt).not.toBeNull();

    // expiry 通知恰好一次（另有下单时 2 条创建通知）
    const expiryNotifications = await e2eDb().notification.findMany({
      where: { orderId, title: "商品预留已过期" },
    });
    expect(expiryNotifications).toHaveLength(2);
    expect(new Set(expiryNotifications.map((n) => n.userId))).toEqual(
      new Set([order!.buyerId, order!.sellerId]),
    );
    for (const notification of expiryNotifications) {
      expect(notification.dedupeKey).toBe(`OUTBOX:${outbox!.id}:IN_APP:${notification.userId}`);
      expect(notification.sourceEventId).toBe(outbox!.id);
    }
  });

  // ---------- 浏览器断言（queue 无关，锁外）----------
  // ---------- 浏览器：买家视角 ----------
  await buyer.goto("/my/orders");
  const buyerCard = buyer.locator("article", { hasText: title }).first();
  await expect(buyerCard).toBeVisible();
  await expect(buyerCard.getByText("订单已取消").first()).toBeVisible();
  await buyer.goto("/notifications");
  await expect(buyer.getByText("商品预留已过期").first()).toBeVisible();
  await expect(buyer.getByText("卖家未在确认期限内接受订单，商品预留已自动释放。").first()).toBeVisible();

  // ---------- 浏览器：卖家视角 ----------
  await seller.goto("/my/orders");
  const sellerCard = seller.locator("article", { hasText: title }).first();
  await expect(sellerCard).toBeVisible();
  await expect(sellerCard.getByText("订单已取消").first()).toBeVisible();
  await seller.goto("/notifications");
  await expect(seller.getByText("商品预留已过期").first()).toBeVisible();
  await expect(seller.getByText("该商品订单已超过确认期限，预留已自动释放。").first()).toBeVisible();

  await buyerContext.close();
  await sellerContext.close();
});
