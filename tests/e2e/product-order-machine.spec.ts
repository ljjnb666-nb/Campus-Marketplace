import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * GOLDEN FLOW 3 — 商品订单完整状态机
 * 买家下单 → 卖家接受 → 买家确认完成 → 商品 SOLD
 * 负例：无关用户看不到也操作不了该订单；完成后商品不可再购买
 */

test("商品订单：买家下单 → 卖家接受 → 买家确认完成 → 商品售罄", async ({ browser }) => {
  const tag = uniqueTag("gf3");
  const title = `E2E状态机商品 ${tag}`;

  // ---------- 卖家发布商品 ----------
  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const seller = await sellerContext.newPage();
  await seller.goto("/products/new");
  await seller.locator('input[name="title"]').first().fill(title);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "数码产品" });
  await seller.locator('input[name="price"]').first().fill("88");
  await seller.locator('input[name="locationText"]').first().fill("E2E 教学楼 B");
  await seller.locator('textarea[name="description"]').first().fill(`E2E 状态机测试 ${tag}`);
  await seller.getByRole("button", { name: "确认发布商品" }).first().click();
  await seller.waitForURL(/\/products\/(?!new)[^/]+$/, { timeout: 30_000 });
  const productId = new URL(seller.url()).pathname.split("/").pop() ?? "";

  // ---------- 买家下单 ----------
  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyer = await buyerContext.newPage();
  await buyer.goto(`/products/${productId}`);
  await buyer.getByRole("button", { name: "立即购买" }).first().click();
  await buyer.locator('input[name="meetingLocation"]').fill("E2E 图书馆大厅");
  await buyer.getByRole("button", { name: "确认提交订单" }).click();
  await buyer.waitForURL(/\/my\/orders/, { timeout: 20_000 });

  const order = await e2eDb().order.findFirst({ where: { productId } });
  expect(order?.status).toBe("PENDING");

  // ---------- 卖家接受订单 ----------
  await seller.goto("/my/orders");
  const sellerCard = seller.locator("article", { hasText: title }).first();
  await expect(sellerCard).toBeVisible();
  await sellerCard.getByRole("button", { name: "接受订单" }).click();

  // 表单 action 提交后 /my/orders 不自动刷新：以 DB 为准，reload 后验证 UI 徽标
  await expect
    .poll(async () => (await e2eDb().order.findFirst({ where: { productId } }))?.status)
    .toBe("ACCEPTED");
  await seller.reload();
  await expect(
    seller.locator("article", { hasText: title }).first().getByText("交付履约中").first(),
  ).toBeVisible();

  // ---------- 买家确认完成 ----------
  await buyer.goto("/my/orders");
  const buyerCard = buyer.locator("article", { hasText: title }).first();
  await expect(buyerCard).toBeVisible();
  await buyerCard.getByRole("button", { name: "确认完成" }).click();
  await buyer.getByRole("button", { name: "确认收货/完成" }).click();

  // 确认弹窗内 window.location.reload() 会刷新订单中心（完成徽标 = 交易已完成，
  // 桌面+移动各渲染一份，取 first）
  await expect(
    buyer.locator("article", { hasText: title }).first().getByText("交易已完成").first(),
  ).toBeVisible({
    timeout: 20_000,
  });

  // ---------- DB 最终状态：订单完成、商品 SOLD、双方完成单数 +1 ----------
  await expect
    .poll(async () => {
      const finalOrder = await e2eDb().order.findFirst({ where: { productId } });
      return { status: finalOrder?.status, completedAt: finalOrder?.completedAt };
    })
    .toEqual({ status: "COMPLETED", completedAt: expect.any(Date) });

  const soldProduct = await e2eDb().product.findUnique({ where: { id: productId } });
  expect(soldProduct?.status).toBe("SOLD");

  const [buyerUser, sellerUser] = await Promise.all([
    e2eDb().user.findUnique({ where: { email: "e2e-buyer@e2e.test" } }),
    e2eDb().user.findUnique({ where: { email: "e2e-seller@e2e.test" } }),
  ]);
  expect(buyerUser?.completedOrdersCount).toBeGreaterThanOrEqual(1);
  expect(sellerUser?.completedOrdersCount).toBeGreaterThanOrEqual(1);

  // ---------- 负例 1：商品完成后不可再购买 ----------
  await buyer.goto(`/products/${productId}`);
  await expect(buyer.getByText("不可购买").first()).toBeVisible();
  await expect(buyer.getByRole("button", { name: "立即购买" })).toHaveCount(0);

  await buyerContext.close();
  await sellerContext.close();

  // ---------- 负例 2：无关用户看不到该订单（服务端也拒绝其状态转换） ----------
  const outsiderContext = await browser.newContext({ storageState: storageStatePath("outsider") });
  const outsider = await outsiderContext.newPage();
  await outsider.goto("/my/orders?type=product");
  await expect(outsider.getByText(title)).toHaveCount(0);
  await outsiderContext.close();

  // DB 不变量：无关用户从未出现在订单参与方
  const finalOrder = await e2eDb().order.findFirstOrThrow({ where: { productId } });
  const outsiderUser = await e2eDb().user.findUniqueOrThrow({
    where: { email: "e2e-outsider@e2e.test" },
  });
  expect(finalOrder.buyerId).not.toBe(outsiderUser.id);
  expect(finalOrder.sellerId).not.toBe(outsiderUser.id);
});
