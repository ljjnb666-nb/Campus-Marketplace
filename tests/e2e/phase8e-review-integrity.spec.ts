import { expect, test } from "@playwright/test";

import { e2eDb } from "./helpers/db";
import { E2E_ACCOUNTS, storageStatePath, uniqueTag } from "./helpers/e2e";

/**
 * Phase 8E Review Integrity E2E（真实 browser → production build →
 * server action → canonical Tx service → PostgreSQL）。
 *
 * 原则：Browser drives action, DB verifies invariant（e2eDb = 被测同库真实
 * PrismaClient）；server action 为真实链路（/my/orders 卡片 → ReviewDialog →
 * submitOrderReviewTx / submitRentalReviewTx）。
 *
 * 覆盖（指令 §44-§47）：
 *  - E2E-01 双盲 General Review：buyer 提交 1 星 → seller /my/reviews
 *    看不到评分/内容、无泄漏通知、public profile aggregate 不变 →
 *    seller 提交 5 星 → 双方评价互见；DB：2 rows 均 publishedAt 非空
 *  - E2E-02 单边 window expiry：buyer 提交后 seller 不可见 →
 *    TEST-ONLY REVIEW WINDOW ADVANCE（blindUntil 推进到过去，不绕过
 *    production submission service）→ seller reload 即可见（无 scheduler）
 *  - E2E-03 Review then Dispute：buyer 完成评价后发起 General dispute →
 *    Review row 保留、Order IN_DISPUTE、seller 收到的评价隐藏
 *  - E2E-04 Rental blind review：COMPLETED RentalOrder，renter 提交 →
 *    owner 不可见 → owner 提交 → 双方 published
 */

async function createCompletedProductFixture(tag: string) {
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const seller = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.seller.email } });
  const buyer = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.buyer.email } });

  const category = await db.productCategory.create({
    data: { name: `E2E8E类目 ${tag}`, slug: `e2e-p8e-${tag}` },
  });
  const product = await db.product.create({
    data: {
      title: `E2E8E 商品 ${tag}`,
      description: "Phase 8E E2E review 夹具商品",
      price: 66,
      condition: "NEW",
      locationText: "E2E 南门",
      categoryId: category.id,
      campusId: campus.id,
      sellerId: seller.id,
      status: "SOLD",
    },
  });
  const order = await db.order.create({
    data: {
      orderNo: `E2EP8E-${tag}`,
      type: "PRODUCT",
      status: "COMPLETED",
      completedAt: new Date(),
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: product.id,
      amount: "66.00",
    },
  });
  return { db, seller, buyer, order };
}

async function createCompletedRentalFixture(tag: string) {
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const seller = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.seller.email } });
  const buyer = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.buyer.email } });

  const category = await db.rentalCategory.create({
    data: { name: `E2E8E租赁类目 ${tag}`, slug: `e2e-p8e-rental-${tag}`, isActive: true },
  });
  const listing = await db.rentalListing.create({
    data: {
      ownerId: seller.id,
      categoryId: category.id,
      campusId: campus.id,
      title: `E2E8E 租赁物品 ${tag}`,
      description: "Phase 8E E2E rental review 夹具",
      condition: "NORMAL_USED",
      price: 40,
      pricingUnit: "PER_DAY",
      depositAmount: 0,
      minimumDuration: 1,
      maximumDuration: 30,
      pickupLocation: "E2E 北门",
      returnLocation: "E2E 北门",
      status: "AVAILABLE",
    },
  });
  const now = new Date();
  const order = await db.rentalOrder.create({
    data: {
      orderNumber: `E2EP8ER-${tag}`,
      rentalListingId: listing.id,
      ownerId: seller.id,
      renterId: buyer.id,
      startTime: now,
      endTime: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      quantity: 1,
      unitPriceSnapshot: 40,
      pricingUnitSnapshot: "PER_DAY",
      rentalDuration: 1,
      rentalAmount: 40,
      depositAmount: 0,
      finalAmount: 40,
      paymentStatus: "OFFLINE_PENDING",
      depositStatus: "NOT_REQUIRED",
      status: "COMPLETED",
      completedAt: now,
      pickupLocationSnapshot: "E2E 北门",
      returnLocationSnapshot: "E2E 北门",
    },
  });
  return { db, seller, buyer, order };
}

async function buyerPage(browser: import("@playwright/test").Browser) {
  const context = await browser.newContext({ storageState: storageStatePath("buyer") });
  return { context, page: await context.newPage() };
}

async function sellerPage(browser: import("@playwright/test").Browser) {
  const context = await browser.newContext({ storageState: storageStatePath("seller") });
  return { context, page: await context.newPage() };
}

/** 在统一订单中心卡片上打开评价 Dialog 并提交 */
async function submitReviewFromOrderCard(
  page: import("@playwright/test").Page,
  titleText: string,
  options: { stars: number; content?: string },
) {
  await page.goto("/my/orders");
  const card = page.locator("article", { hasText: titleText }).first();
  await expect(card.getByRole("button", { name: "发表评价" })).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "发表评价" }).click();
  const dialog = page.getByRole("dialog", { name: "发表交易评价" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: `${options.stars} 星` }).click();
  if (options.content) {
    await dialog.getByLabel("详细评价内容 (选填)").fill(options.content);
  }
  await dialog.getByRole("button", { name: "提交评价" }).click();
  await expect(dialog).not.toBeVisible({ timeout: 30_000 });
}

test("8E E2E-01：双盲 General Review（blind → 双评互见，零泄漏通知）", async ({ browser }) => {
  test.setTimeout(240_000);
  const tag = uniqueTag("p8e01");
  const { db, seller, order } = await createCompletedProductFixture(tag);

  // ── buyer：提交 1 星评价 ────────────────────────────────────────────────
  const buyerCtx = await buyerPage(browser);
  await submitReviewFromOrderCard(buyerCtx.page, `E2E8E 商品 ${tag}`, {
    stars: 1,
    content: "8E-E2E01 差评原文（blind 期间不得泄漏）",
  });

  const review = await db.review.findFirstOrThrow({ where: { orderId: order.id } });
  expect(review.rating).toBe(1);
  expect(review.publishedAt).toBeNull();
  expect(review.blindUntil.getTime()).toBe(
    order.completedAt!.getTime() + 7 * 24 * 60 * 60 * 1000,
  );

  // ── seller：不可见、无泄漏通知、aggregate 不变 ──────────────────────────
  const sellerCtx = await sellerPage(browser);
  await sellerCtx.page.goto("/my/reviews");
  await expect(sellerCtx.page.getByRole("heading", { name: "我收到的评价" })).toBeVisible();
  await expect(sellerCtx.page.getByText("你暂时还没有收到公开的评价。")).toBeVisible();
  await expect(sellerCtx.page.getByText("差评原文")).toHaveCount(0);

  // 无"收到评价"类泄漏通知（§23 FIRST_BLIND_REVIEW → ZERO notification）
  await sellerCtx.page.goto("/notifications");
  await expect(sellerCtx.page.getByText(/收到.*评价|收到新评价/)).toHaveCount(0);

  // public profile aggregate 不变（publishedReviewCount == 0 → 暂无评价）
  await sellerCtx.page.goto(`/users/${seller.id}`);
  await expect(sellerCtx.page.getByText("暂无评价")).toBeVisible();

  // DB：零评价通知
  expect(
    await db.notification.count({ where: { userId: seller.id, type: "REVIEW" } }),
  ).toBe(0);

  // ── seller：提交 5 星 → 双方评价立即互见 ────────────────────────────────
  await submitReviewFromOrderCard(sellerCtx.page, `E2E8E 商品 ${tag}`, {
    stars: 5,
    content: "8E-E2E01 好评原文",
  });

  const reviews = await db.review.findMany({ where: { orderId: order.id } });
  expect(reviews).toHaveLength(2);
  expect(reviews.every((r) => r.publishedAt !== null)).toBe(true);

  // 双方都能看到收到的评价
  await buyerCtx.page.goto("/my/reviews");
  await expect(buyerCtx.page.getByText("好评原文")).toBeVisible();
  await sellerCtx.page.goto("/my/reviews");
  await expect(sellerCtx.page.getByText("差评原文")).toBeVisible();
  // generic 公开事件通知（不含评分/内容）
  await sellerCtx.page.goto("/notifications");
  await expect(sellerCtx.page.getByText("交易评价已公开").first()).toBeVisible();

  await buyerCtx.context.close();
  await sellerCtx.context.close();
});

test("8E E2E-02：单边评价 window expiry（query-time 可见，无 scheduler）", async ({ browser }) => {
  test.setTimeout(240_000);
  const tag = uniqueTag("p8e02");
  const { db, seller, order } = await createCompletedProductFixture(tag);

  const buyerCtx = await buyerPage(browser);
  await submitReviewFromOrderCard(buyerCtx.page, `E2E8E 商品 ${tag}`, {
    stars: 3,
    content: "8E-E2E02 单边评价原文",
  });

  // seller 暂不可见
  const sellerCtx = await sellerPage(browser);
  await sellerCtx.page.goto("/my/reviews");
  await expect(sellerCtx.page.getByText("你暂时还没有收到公开的评价。")).toBeVisible();

  // TEST-ONLY REVIEW WINDOW ADVANCE：把该评价 blindUntil 推进到过去
  //（不绕过 production submission service 创建评价）
  const review = await db.review.findFirstOrThrow({ where: { orderId: order.id } });
  await db.review.update({
    where: { id: review.id },
    data: { blindUntil: new Date(Date.now() - 1000) },
  });

  // seller reload → 评价变为可见（证明无需任何 scheduler）
  await sellerCtx.page.goto("/my/reviews");
  await expect(sellerCtx.page.getByText("单边评价原文")).toBeVisible();
  await expect(sellerCtx.page.getByText("评分：3 / 5")).toBeVisible();
  void seller;

  await buyerCtx.context.close();
  await sellerCtx.context.close();
});

test("8E E2E-03：Review then Dispute（评价保留 + 隐藏，Order IN_DISPUTE）", async ({ browser }) => {
  test.setTimeout(240_000);
  const tag = uniqueTag("p8e03");
  const { db, buyer, seller, order } = await createCompletedProductFixture(tag);

  // buyer 完成评价并推进到已公开形状（走真实提交路径 + TEST-ONLY 提前公开，
  // 便于区分 dispute 隐藏与 blind 隐藏）
  const buyerCtx = await buyerPage(browser);
  await submitReviewFromOrderCard(buyerCtx.page, `E2E8E 商品 ${tag}`, {
    stars: 2,
    content: "8E-E2E03 纠纷前评价",
  });
  const review = await db.review.findFirstOrThrow({ where: { orderId: order.id } });
  await db.review.update({
    where: { id: review.id },
    data: { publishedAt: new Date(), blindUntil: new Date(Date.now() - 1000) },
  });

  // buyer 发起 General OrderDispute（订单中心卡片 → 申诉 Dialog）
  await buyerCtx.page.goto("/my/orders");
  const card = buyerCtx.page.locator("article", { hasText: `E2E8E 商品 ${tag}` }).first();
  await card.getByRole("button", { name: "发起申诉" }).click();
  const disputeDialog = buyerCtx.page.getByRole("dialog");
  await disputeDialog.getByLabel(/纠纷说明/).fill("8E-E2E03 纠纷原因事实说明");
  await disputeDialog.getByRole("button", { name: /提交申诉|提交/ }).click();
  await expect(disputeDialog).not.toBeVisible({ timeout: 30_000 });

  // DB：Review row 保留 + Order IN_DISPUTE
  expect(await db.review.count({ where: { orderId: order.id } })).toBe(1);
  const finalOrder = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(finalOrder.status).toBe("IN_DISPUTE");

  // seller 收到的评价隐藏（canonical visibility = FALSE）
  const sellerCtx = await sellerPage(browser);
  await sellerCtx.page.goto("/my/reviews");
  await expect(sellerCtx.page.getByText("纠纷前评价")).toHaveCount(0);

  void buyer;
  void seller;
  await buyerCtx.context.close();
  await sellerCtx.context.close();
});

test("8E E2E-04：Rental blind review（renter → owner blind → 双评 published）", async ({ browser }) => {
  test.setTimeout(240_000);
  const tag = uniqueTag("p8e04");
  const { db, order } = await createCompletedRentalFixture(tag);

  // renter（buyer 账号）提交 4 星
  const renterCtx = await buyerPage(browser);
  await submitReviewFromOrderCard(renterCtx.page, `E2E8E 租赁物品 ${tag}`, {
    stars: 4,
    content: "8E-E2E04 租客评价",
  });

  const first = await db.rentalReview.findFirstOrThrow({ where: { orderId: order.id } });
  expect(first.overallRating).toBe(4);
  expect(first.publishedAt).toBeNull();

  // owner（seller 账号）不可见
  const ownerCtx = await sellerPage(browser);
  await ownerCtx.page.goto("/my/reviews");
  await expect(ownerCtx.page.getByText("你暂时还没有收到公开的评价。")).toBeVisible();

  // owner 提交 5 星 → 双方 published
  await submitReviewFromOrderCard(ownerCtx.page, `E2E8E 租赁物品 ${tag}`, {
    stars: 5,
    content: "8E-E2E04 出租者评价",
  });

  const reviews = await db.rentalReview.findMany({ where: { orderId: order.id } });
  expect(reviews).toHaveLength(2);
  expect(reviews.every((r) => r.publishedAt !== null)).toBe(true);

  await renterCtx.page.goto("/my/reviews");
  await expect(renterCtx.page.getByText("出租者评价")).toBeVisible();
  await ownerCtx.page.goto("/my/reviews");
  await expect(ownerCtx.page.getByText("租客评价")).toBeVisible();

  await renterCtx.context.close();
  await ownerCtx.context.close();
});
