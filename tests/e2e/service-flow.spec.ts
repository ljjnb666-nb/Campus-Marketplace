import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * GOLDEN FLOW 5 — 技能服务：卖家发布 → 买家预约 → 卖家接受 → 卖家开始 → 买家确认完成
 */

test("技能服务：发布 → 预约 → 接受 → 开始服务 → 买家确认完成", async ({ browser }) => {
  const tag = uniqueTag("gf5");
  const title = `E2E服务 ${tag}`;

  // ---------- 卖家发布服务 ----------
  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const seller = await sellerContext.newPage();
  await seller.goto("/services/new");
  // 服务发布页桌面/移动各渲染一份表单，取第一份
  await seller.locator('input[name="title"]').first().fill(title);
  await seller.locator('textarea[name="description"]').first().fill(`E2E 技能服务描述 ${tag}`);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "摄影" });
  await seller.locator('input[name="price"]').first().fill("128");
  await seller.locator('select[name="pricingUnit"]').first().selectOption({ label: "每次" });
  await seller.locator('input[name="locationText"]').first().fill("E2E 线上");
  await seller.locator('textarea[name="availableSchedule"]').first().fill("E2E 周末全天");
  await seller.getByRole("button", { name: "发布服务" }).click();
  // Next.js client-side 软导航不触发 load 事件：等详情页标题出现
  await expect(seller.getByRole("heading", { level: 1, name: title })).toBeVisible({
    timeout: 30_000,
  });
  await seller.waitForURL(/\/services\/(?!new)[^/]+$/, { waitUntil: "commit" });
  const serviceId = new URL(seller.url()).pathname.split("/").pop() ?? "";

  await expect
    .poll(async () => (await e2eDb().serviceListing.findUnique({ where: { id: serviceId } }))?.status)
    .toBe("ACTIVE");
  const service = await e2eDb().serviceListing.findUnique({ where: { id: serviceId } });
  expect(service?.status).toBe("ACTIVE");

  // ---------- 买家预约 ----------
  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyer = await buyerContext.newPage();
  await buyer.goto("/services");
  await buyer.locator('input[name="q"]').fill(tag);
  await buyer.keyboard.press("Enter");
  await buyer.getByRole("link", { name: new RegExp(title) }).first().click();
  await buyer.waitForURL(/\/services\/[^/]+$/);

  await buyer.getByRole("button", { name: "预约服务" }).first().click();
  await buyer.locator('input[name="meetingLocation"]').fill("E2E 创新中心 301");
  await buyer.getByRole("button", { name: "确认提交预约" }).click();
  // 抽屉先展示 1.2s 成功动画再 window.location.href 跳转
  await expect(buyer.getByText("预约请求已发送！")).toBeVisible({ timeout: 15_000 });
  await buyer.waitForURL(/\/my\/orders/, { timeout: 20_000 });

  const order = await e2eDb().order.findFirst({ where: { serviceListingId: serviceId } });
  expect(order?.status).toBe("PENDING");
  expect(order?.type).toBe("SERVICE");

  // ---------- 卖家接受 → 开始服务 ----------
  await seller.goto("/my/orders?type=service");
  const sellerCard = seller.locator("article", { hasText: title }).first();
  await expect(sellerCard).toBeVisible();
  await sellerCard.getByRole("button", { name: "接受订单" }).click();
  await expect
    .poll(async () => (await e2eDb().order.findFirst({ where: { serviceListingId: serviceId } }))?.status)
    .toBe("ACCEPTED");

  await seller.reload();
  const refreshedSellerCard = seller.locator("article", { hasText: title }).first();
  await refreshedSellerCard.getByRole("button", { name: "开始服务" }).click();
  await expect
    .poll(async () => (await e2eDb().order.findFirst({ where: { serviceListingId: serviceId } }))?.status)
    .toBe("IN_PROGRESS");

  // ---------- 买家确认完成 ----------
  await buyer.goto("/my/orders?type=service");
  const buyerCard = buyer.locator("article", { hasText: title }).first();
  await expect(buyerCard).toBeVisible();
  await buyerCard.getByRole("button", { name: "确认完成" }).click();
  await buyer.getByRole("button", { name: "确认收货/完成" }).click();
  await expect(
    buyer.locator("article", { hasText: title }).first().getByText("服务已完成").first(),
  ).toBeVisible({
    timeout: 20_000,
  });

  const finalOrder = await e2eDb().order.findFirstOrThrow({
    where: { serviceListingId: serviceId },
  });
  expect(finalOrder.status).toBe("COMPLETED");

  const finalService = await e2eDb().serviceListing.findUnique({ where: { id: serviceId } });
  expect(finalService?.completedOrderCount).toBe(1);

  await sellerContext.close();
  await buyerContext.close();
});
