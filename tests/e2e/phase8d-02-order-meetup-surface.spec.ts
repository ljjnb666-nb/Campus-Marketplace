import { expect, test } from "@playwright/test";

import { formatMarketplaceDateTimeLocalInput } from "../../src/lib/marketplace-time";
import { e2eDb } from "./helpers/db";
import { E2E_ACCOUNTS, storageStatePath, uniqueTag } from "./helpers/e2e";

/**
 * Phase 8D-02 Meetup User Surface E2E（真实 browser → production build →
 * server action → canonical 8D-01 domain → PostgreSQL）。
 *
 * 原则：Browser drives action, DB verifies invariant（e2eDb = 被测同库真实
 * PrismaClient）；server action 为真实链路（/my/orders 卡片入口 → 真实
 * propose/confirm/arrival/no-show action → canonical Tx service）。
 *
 * 覆盖（指令 §22-§24）：
 *  - E2E-01 PRODUCT 正常 Meetup：buyer 发起（推荐见面点 + 未来时间）→
 *    seller 确认 → TEST-ONLY clock advance → 双方 self check-in →
 *    双方已到场；DB：COMPLETED + 双 arrival + Order 仍 ACCEPTED
 *    （明确断言 Meetup 完成不自动完成 Order）
 *  - E2E-02 SERVICE No-show：buyer 发起（自定义地点）→ seller 确认 →
 *    clock advance 越过 grace → buyer 到场 → 报告对方未到场（确认
 *    Dialog 冻结文案）→ UI 已报告未到场 + 订单已进入纠纷处理；DB：
 *    NO_SHOW_REPORTED + triggeredDisputeId + dispute OPEN + Order
 *    IN_DISPUTE + 2 DataHold ACTIVE + 无任何自动判责
 *  - E2E-03 unauthorized：第三方直接访问 /my/orders/{id}/meetup → 404，
 *    不泄露地点 / 时间 / 到场 / dispute
 *  - E2E-TIME-01 跨时区：America/Los_Angeles 浏览器提交 campus-local
 *    14:30 → DB scheduledAt = Asia/Shanghai 14:30 的绝对 instant，
 *    页面回显仍是 campus-local 14:30（旧实现 new Date(naive) 在 UTC
 *    server 上必然得 14:30Z，该测试必然失败）
 *  - Mobile 390x844：核心表单可操作、无横向溢出
 */

const MIN = 60 * 1000;

async function createProductFixture(tag: string) {
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const seller = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.seller.email } });
  const buyer = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.buyer.email } });

  const category = await db.productCategory.create({
    data: { name: `E2E8D02类目 ${tag}`, slug: `e2e-p8d02-${tag}` },
  });
  const product = await db.product.create({
    data: {
      title: `E2E8D02 商品 ${tag}`,
      description: "Phase 8D-02 E2E meetup 夹具商品",
      price: 88,
      condition: "NEW",
      locationText: "E2E 东门",
      categoryId: category.id,
      campusId: campus.id,
      sellerId: seller.id,
      status: "ACTIVE",
    },
  });
  const order = await db.order.create({
    data: {
      orderNo: `E2EP8D02-${tag}`,
      type: "PRODUCT",
      status: "ACCEPTED",
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: product.id,
      amount: "88.00",
      meetingLocation: "E2E 东门",
    },
  });
  return { db, campus, seller, buyer, product, order };
}

async function createServiceFixture(tag: string) {
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const seller = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.seller.email } });
  const buyer = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.buyer.email } });

  const category = await db.serviceCategory.create({
    data: { name: `E2E8D02服务类目 ${tag}`, slug: `e2e-p8d02-svc-${tag}` },
  });
  const service = await db.serviceListing.create({
    data: {
      title: `E2E8D02 服务 ${tag}`,
      description: "Phase 8D-02 E2E no-show 夹具服务",
      price: 50,
      pricingUnit: "PER_SESSION",
      locationText: "E2E 实验楼",
      providerId: seller.id,
      campusId: campus.id,
      categoryId: category.id,
      status: "ACTIVE",
    },
  });
  const order = await db.order.create({
    data: {
      orderNo: `E2EP8D02S-${tag}`,
      type: "SERVICE",
      status: "ACCEPTED",
      buyerId: buyer.id,
      sellerId: seller.id,
      serviceListingId: service.id,
      amount: "50.00",
      meetingLocation: "E2E 实验楼",
    },
  });
  return { db, campus, seller, buyer, order };
}

/**
 * TEST-ONLY CLOCK ADVANCE：直接把 scheduledAt 推进到指定时刻。
 * 不是绕过 production service 创建状态——只是移动既有 CONFIRMED meetup 的
 * 约定时间，使 arrival / no-show 时间窗口对浏览器可操作；后续全部状态
 * 迁移仍由真实 server action → canonical Tx service 在锁内裁决。
 */
async function advanceScheduledAt(meetupId: string, scheduledAt: Date) {
  await e2eDb().orderMeetup.update({ where: { id: meetupId }, data: { scheduledAt } });
}

async function buyerPage(browser: import("@playwright/test").Browser) {
  const context = await browser.newContext({ storageState: storageStatePath("buyer") });
  return { context, page: await context.newPage() };
}

async function sellerPage(browser: import("@playwright/test").Browser) {
  const context = await browser.newContext({ storageState: storageStatePath("seller") });
  return { context, page: await context.newPage() };
}

test("8D-02 E2E-01：PRODUCT 正常 Meetup 全链路（发起→确认→双方到场）", async ({ browser }) => {
  test.setTimeout(180_000);
  const tag = uniqueTag("p8d02a");
  const { db, order } = await createProductFixture(tag);
  const point = await db.meetupPoint.create({
    data: {
      campusId: (await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } })).id,
      name: `E2E8D02见面点 ${tag}`,
      locationText: "E2E 图书馆北门台阶",
      isActive: true,
    },
  });

  // ── buyer：订单中心 → 见面约定 → 推荐见面点 + 未来时间 → 发起 ──────────
  const buyer = await buyerPage(browser);
  await buyer.page.goto("/my/orders");
  const buyerCard = buyer.page.locator("article", { hasText: `E2E8D02 商品 ${tag}` }).first();
  await expect(buyerCard.getByRole("link", { name: "见面约定" })).toBeVisible();
  await buyerCard.getByRole("link", { name: "见面约定" }).click();

  await expect(buyer.page.getByRole("heading", { name: "见面约定", exact: true })).toBeVisible();
  await buyer.page.getByRole("radio", { name: "校内推荐见面点" }).click();
  await buyer.page
    .getByRole("combobox", { name: "选择校内推荐见面点" })
    .selectOption({ value: point.id });
  await buyer.page.getByLabel("约定时间").fill(formatMarketplaceDateTimeLocalInput(new Date(Date.now() + 60 * MIN)));
  await buyer.page.getByRole("button", { name: "发起见面约定" }).click();

  // 发起成功 → 页面刷新为 PROPOSED（中文状态，无 raw enum）
  await expect(buyer.page.getByText("待对方确认").first()).toBeVisible({ timeout: 30_000 });
  await expect(buyer.page.getByText(/等待对方确认/)).toBeVisible();

  let meetup = await db.orderMeetup.findFirstOrThrow({ where: { orderId: order.id } });
  expect(meetup.status).toBe("PROPOSED");
  expect(meetup.locationTextSnapshot).toBe("E2E 图书馆北门台阶");
  expect(meetup.locationSource).toBe("MEETUP_POINT");

  // ── seller：订单中心 → 进入见面约定 → 确认约定 ─────────────────────────
  const seller = await sellerPage(browser);
  await seller.page.goto("/my/orders");
  const sellerCard = seller.page.locator("article", { hasText: `E2E8D02 商品 ${tag}` }).first();
  await expect(sellerCard.getByRole("link", { name: "见面约定" })).toBeVisible();
  await sellerCard.getByRole("link", { name: "见面约定" }).click();

  await expect(seller.page.getByText("待对方确认").first()).toBeVisible();
  await expect(seller.page.getByText(/对方发起了见面约定/)).toBeVisible();
  await seller.page.getByRole("button", { name: "确认约定" }).click();
  await expect(seller.page.getByText("已确认见面").first()).toBeVisible({ timeout: 30_000 });

  meetup = await db.orderMeetup.findUniqueOrThrow({ where: { id: meetup.id } });
  expect(meetup.status).toBe("CONFIRMED");
  expect(meetup.confirmedById).toBe((await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.seller.email } })).id);

  // ── TEST-ONLY CLOCK ADVANCE：scheduledAt 推进到过去，开放 arrival 窗口 ──
  await advanceScheduledAt(meetup.id, new Date(Date.now() - 2 * MIN));

  // ── buyer：我已到达 ────────────────────────────────────────────────────
  await buyer.page.reload();
  await expect(buyer.page.getByRole("button", { name: "我已到达" })).toBeVisible();
  // 时间未到不显示可操作取消（窗口已关闭）
  await expect(buyer.page.getByRole("button", { name: "取消约定" })).toHaveCount(0);
  await buyer.page.getByRole("button", { name: "我已到达" }).click();
  await expect(buyer.page.getByText(/你已到达，等待对方到场/)).toBeVisible({ timeout: 30_000 });

  // ── seller：我已到达 → 双方已到场 ──────────────────────────────────────
  await seller.page.reload();
  await expect(seller.page.getByRole("button", { name: "我已到达" })).toBeVisible();
  await seller.page.getByRole("button", { name: "我已到达" }).click();
  await expect(seller.page.getByText("双方已到场").first()).toBeVisible({ timeout: 30_000 });
  // Meetup COMPLETED ≠ Order COMPLETED 的页面语义必须可见
  await expect(seller.page.getByText(/见面约定完成不等于订单完成/)).toBeVisible();

  // ── DB 不变量：COMPLETED + 双 arrival + Order 未被自动完成 ─────────────
  meetup = await db.orderMeetup.findUniqueOrThrow({ where: { id: meetup.id } });
  expect(meetup.status).toBe("COMPLETED");
  expect(meetup.buyerArrivedAt).not.toBeNull();
  expect(meetup.sellerArrivedAt).not.toBeNull();

  const finalOrder = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  // 明确断言：Meetup completion did NOT auto-complete Order
  expect(finalOrder.status).toBe("ACCEPTED");

  await buyer.context.close();
  await seller.context.close();
});

test("8D-02 E2E-02：SERVICE no-show → 纠纷原子创建（allegation 语义）", async ({ browser }) => {
  test.setTimeout(180_000);
  const tag = uniqueTag("p8d02b");
  const testStart = new Date();
  const { db, order } = await createServiceFixture(tag);
  const buyer = await buyerPage(browser);
  const seller = await sellerPage(browser);

  // ── buyer：自定义地点发起 ───────────────────────────────────────────────
  await buyer.page.goto(`/my/orders/${order.id}/meetup`);
  await expect(buyer.page.getByRole("heading", { name: "见面约定", exact: true })).toBeVisible();
  await buyer.page.getByRole("radio", { name: "自定义地点" }).click();
  await buyer.page
    .getByRole("textbox", { name: "自定义见面地点" })
    .fill("E2E 自定义地点 快递柜旁");
  await buyer.page.getByLabel("约定时间").fill(formatMarketplaceDateTimeLocalInput(new Date(Date.now() + 60 * MIN)));
  await buyer.page.getByRole("button", { name: "发起见面约定" }).click();
  await expect(buyer.page.getByText("待对方确认").first()).toBeVisible({ timeout: 30_000 });

  const meetup = await db.orderMeetup.findFirstOrThrow({ where: { orderId: order.id } });
  expect(meetup.locationSource).toBe("CUSTOM");
  expect(meetup.locationTextSnapshot).toBe("E2E 自定义地点 快递柜旁");

  // ── seller：确认 ───────────────────────────────────────────────────────
  await seller.page.goto(`/my/orders/${order.id}/meetup`);
  await expect(seller.page.getByText("待对方确认").first()).toBeVisible();
  await seller.page.getByRole("button", { name: "确认约定" }).click();
  await expect(seller.page.getByText("已确认见面").first()).toBeVisible({ timeout: 30_000 });

  // ── TEST-ONLY CLOCK ADVANCE：越过 15 分钟 grace ────────────────────────
  await advanceScheduledAt(meetup.id, new Date(Date.now() - 16 * MIN));

  // ── buyer：我已到达 → 报告对方未到场（确认 Dialog）──────────────────────
  await buyer.page.reload();
  await buyer.page.getByRole("button", { name: "我已到达" }).click();
  await expect(buyer.page.getByText(/你已到达，等待对方到场/)).toBeVisible({ timeout: 30_000 });
  await expect(buyer.page.getByRole("button", { name: "报告对方未到场" })).toBeVisible();

  await buyer.page.getByRole("button", { name: "报告对方未到场" }).click();
  const dialog = buyer.page.getByRole("dialog", { name: "报告对方未到场" });
  // 冻结产品语义：allegation ≠ 判责
  await expect(dialog.getByText(/系统会创建订单纠纷并进入平台处理流程/)).toBeVisible();
  await expect(
    dialog.getByText(/这只是你方提交的事实主张，不代表平台已经认定对方违约或判定责任/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "提交未到场报告" }).click();

  // ── UI 终态：已报告未到场 + 订单已进入纠纷处理 ──────────────────────────
  await expect(buyer.page.getByText("已报告未到场").first()).toBeVisible({ timeout: 30_000 });
  await expect(buyer.page.getByText(/订单已进入纠纷处理/).first()).toBeVisible();
  await expect(buyer.page.getByText(/不代表已作出责任判定/)).toBeVisible();

  // ── DB 不变量：no-show → dispute 原子链 ────────────────────────────────
  const buyerRow = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.buyer.email } });
  const sellerRow = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.seller.email } });

  const finalMeetup = await db.orderMeetup.findUniqueOrThrow({ where: { id: meetup.id } });
  expect(finalMeetup.status).toBe("NO_SHOW_REPORTED");
  expect(finalMeetup.noShowReportedById).toBe(buyerRow.id);
  expect(finalMeetup.noShowTargetId).toBe(sellerRow.id);
  expect(finalMeetup.triggeredDisputeId).not.toBeNull();

  const dispute = await db.orderDispute.findUniqueOrThrow({
    where: { id: finalMeetup.triggeredDisputeId! },
  });
  expect(dispute.status).toBe("OPEN");
  expect(dispute.initiatorId).toBe(buyerRow.id);

  const finalOrder = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(finalOrder.status).toBe("IN_DISPUTE");

  const holds = await db.dataHold.findMany({
    where: { sourceType: "ORDER_DISPUTE", sourceId: dispute.id, status: "ACTIVE" },
  });
  expect(holds).toHaveLength(2);

  // 无自动判责：本测试窗口内不产生 RiskFlag / EnforcementAction / 风控降级
  //（共享账号可能被其他并行 spec 的历史动作命中，故按 createdAt 时间窗断言）
  const riskFlags = await db.riskFlag.count({
    where: {
      userId: { in: [buyerRow.id, sellerRow.id] },
      createdAt: { gte: testStart },
    },
  });
  expect(riskFlags).toBe(0);
  const enforcements = await db.enforcementAction.count({
    where: { targetId: { in: [buyerRow.id, sellerRow.id] }, createdAt: { gte: testStart } },
  });
  expect(enforcements).toBe(0);

  // 订单中心入口在 IN_DISPUTE 后仍可见（可回看历史）
  await expect(
    buyer.page.getByRole("link", { name: "返回订单中心" }),
  ).toBeVisible();

  await buyer.context.close();
  await seller.context.close();
});

test("8D-02 E2E-03：第三方直接访问 meetup 页 → 404 且零信息泄漏", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p8d02c");
  const { db, order } = await createProductFixture(tag);
  await db.meetupPoint.create({
    data: {
      campusId: (await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } })).id,
      name: `E2E8D02机密点 ${tag}`,
      locationText: "E2E 机密见面地点文本",
      isActive: true,
    },
  });

  const outsiderContext = await browser.newContext({
    storageState: storageStatePath("outsider"),
  });
  const outsiderPage = await outsiderContext.newPage();
  await outsiderPage.goto(`/my/orders/${order.id}/meetup`);

  // 现有产品模式（与 phase7d/7e/listing-moderation spec 一致）：notFound
  // 渲染统一 404 页面。Next 流式 SSR 下响应头先于 notFound() 发出，HTTP
  // 状态不作为断言（仓库既有 unauthorized spec 同样断言页面而非状态码）。
  // 关键产品属性：不泄露存在性 / 地点 / 时间 / 到场 / dispute。
  await expect(outsiderPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  const bodyText = await outsiderPage.locator("body").innerText();
  expect(bodyText).not.toContain("E2E 机密见面地点文本");
  expect(bodyText).not.toContain(`E2E8D02 商品 ${tag}`);
  expect(bodyText).not.toContain(order.orderNo);

  await outsiderContext.close();
});

test("8D-02 Mobile 390x844：核心表单可操作、无横向溢出", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p8d02m");
  const { order } = await createProductFixture(tag);

  const context = await browser.newContext({
    storageState: storageStatePath("buyer"),
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto(`/my/orders/${order.id}/meetup`);
  await expect(page.getByRole("heading", { name: "见面约定", exact: true })).toBeVisible();

  // datetime / select / custom location 可输入（可见且无溢出）
  await expect(page.getByLabel("约定时间")).toBeVisible();
  await page.getByLabel("约定时间").fill(formatMarketplaceDateTimeLocalInput(new Date(Date.now() + 60 * MIN)));
  await page.getByRole("radio", { name: "自定义地点" }).click();
  const customBox = page.getByRole("textbox", { name: "自定义见面地点" });
  await expect(customBox).toBeVisible();
  await customBox.fill("E2E 移动端地点");
  // 状态信息不依赖 hover：直接可见
  //（桌面/移动双表单各渲染一份校验提示，套件 .first() 约定）
  await expect(page.getByText(/请选择一个未来的时间/).first()).toBeVisible();

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);

  await context.close();
});

test("8D-02 E2E-TIME-01：America/Los_Angeles 浏览器提交 campus-local 14:30 → canonical instant", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p8d02t");
  const { db, order } = await createProductFixture(tag);

  // 期望的 campus wall-clock：canonical 上海时区"明天"的 14:30
  //（+24h 后的 Shanghai 日期恒为"今天+1"，且 14:30 恒在未来、满足 min）
  const shanghaiDate = formatMarketplaceDateTimeLocalInput(
    new Date(Date.now() + 24 * 60 * 60 * 1000),
  ).slice(0, 10);
  const campusLocalInput = `${shanghaiDate}T14:30`;
  // Asia/Shanghai = UTC+08:00（无夏令时）：14:30 campus wall-clock 的
  // 唯一绝对 instant
  const expectedInstant = `${shanghaiDate}T06:30:00.000Z`;

  const context = await browser.newContext({
    storageState: storageStatePath("buyer"),
    // 跨时区负例关键：浏览器机器时区 = America/Los_Angeles（UTC-7/-8）。
    // 若实现把 datetime-local 交给 server local timezone 或浏览器时区
    // 解释，本测试在旧实现上必然失败。
    timezoneId: "America/Los_Angeles",
  });
  const page = await context.newPage();
  await page.goto(`/my/orders/${order.id}/meetup`);
  await expect(page.getByRole("heading", { name: "见面约定", exact: true })).toBeVisible();

  await page.getByRole("radio", { name: "自定义地点" }).click();
  await page.getByRole("textbox", { name: "自定义见面地点" }).fill("E2E 跨时区地点");
  await page.getByLabel("约定时间").fill(campusLocalInput);
  await page.getByRole("button", { name: "发起见面约定" }).click();
  await expect(page.getByText("待对方确认").first()).toBeVisible({ timeout: 30_000 });

  // DB 不变量：scheduledAt = Asia/Shanghai 14:30 的绝对 instant
  //（不是 LA 14:30 = 21:30/22:30Z，也不是 server-local 14:30 = 14:30Z）
  await expect
    .poll(
      async () =>
        (await db.orderMeetup.findFirstOrThrow({ where: { orderId: order.id } })).scheduledAt.toISOString(),
      { timeout: 15_000 },
    )
    .toBe(expectedInstant);

  // 重新打开页面：仍显示用户选择的 campus-local 14:30
  await page.reload();
  // 桌面+移动各渲染一份（与套件其它 spec 同一 .first() 双渲染约定）
  await expect(page.getByText(/约定时间：.*14:30/).first()).toBeVisible();

  await context.close();
});
