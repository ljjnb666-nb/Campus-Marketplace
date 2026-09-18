import { test, expect } from "@playwright/test";
import { hashSync } from "bcryptjs";

import { uniqueTag, E2E_ACCOUNTS, storageStatePath } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";
import { loginViaUI } from "./helpers/auth";
import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";

/**
 * GOLDEN FLOWS — Phase 7E Report & Moderation Case Operations（retry=0）：
 *
 * 7E-E2E01 PLATFORM_ADMIN → /governance/reports 队列 → 领用 → IN_REVIEW →
 *          RESOLVED → case closed（DB 权威断言）
 * 7E-E2E02 reopen RESOLVED → IN_REVIEW → dueAt 重置 → case 回到 ACTIVE
 * 7E-E2E03 CAMPUS_REPORT_REVIEWER A → 见 campus A 举报；不可见 campus B / UNSCOPED
 *          （详情 404 反 oracle）+ 精确 capability 派生导航
 * 7E-E2E04 rental 举报：创建（真实弹窗链路）→ 队列 → 审核（7E rental repair 全链）
 * 7E-E2E05 legacy /admin/reports → canonical /governance/reports redirect
 *
 * Browser drives action, DB verifies invariant（helpers/db 的 e2eDb 连真实库）。
 */

const TEST_PASSWORD_PREFIX = process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e";

/** 直建带 scope 快照 + 1:1 case 的举报（跨校区隔离 fixture 用）。 */
async function createScopedReportFixture(input: {
  reporterId: string;
  campusId: string | null;
  scopeKey: string;
  targetType: "PRODUCT" | "USER";
  productId?: string;
  targetUserId?: string;
  reason?: "FAKE_INFO" | "SCAM_RISK";
}) {
  const db = e2eDb();
  const report = await db.report.create({
    data: {
      reporterId: input.reporterId,
      targetType: input.targetType,
      reason: input.reason ?? "FAKE_INFO",
      detail: "7E 隔离 fixture",
      campusId: input.campusId,
      scopeKey: input.scopeKey,
      productId: input.productId,
      targetUserId: input.targetUserId,
    },
  });
  await db.moderationCase.create({
    data: {
      reportId: report.id,
      campusId: input.campusId,
      scopeKey: input.scopeKey,
      openedAt: report.createdAt,
      dueAt: new Date(report.createdAt.getTime() + 48 * 60 * 60 * 1000),
      lastActivityAt: report.createdAt,
    },
  });
  return report;
}

test("7E-E2E01 管理员队列 → 领用 → IN_REVIEW → RESOLVED → case closed", async ({ browser }) => {
  const tag = uniqueTag("p7e-01");
  const title = `E2E7E商品 ${tag}`;
  const db = e2eDb();

  // ---------- 卖家发布商品 → 买家举报（真实弹窗 → server action 单事务） ----------
  const sellerContext = await browser.newContext({ storageState: storageStatePath("seller") });
  const seller = await sellerContext.newPage();
  await seller.goto("/products/new");
  await seller.locator('input[name="title"]').first().fill(title);
  await seller.locator('select[name="categoryId"]').first().selectOption({ label: "生活用品" });
  await seller.locator('input[name="price"]').first().fill("19.9");
  await seller.locator('input[name="locationText"]').first().fill("E2E 宿舍楼下");
  await seller.locator('textarea[name="description"]').first().fill(`E2E 7E 流程 ${tag}`);
  await seller.getByRole("button", { name: "确认发布商品" }).first().click();
  await seller.waitForURL(/\/products\/(?!new)[^/]+$/, { timeout: 30_000 });
  const productId = new URL(seller.url()).pathname.split("/").pop() ?? "";
  await sellerContext.close();

  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyer = await buyerContext.newPage();
  await buyer.goto(`/products/${productId}`);
  await buyer.getByRole("button", { name: "举报商品" }).click();
  await buyer.locator('select[name="reason"]').selectOption("SCAM_RISK");
  await buyer.locator('textarea[name="detail"]').fill(`E2E 7E 详情 ${tag}`);
  await buyer.getByRole("button", { name: "提交举报" }).click();
  await expect(buyer.getByText("举报已成功提交")).toBeVisible({ timeout: 15_000 });
  await buyerContext.close();

  const report = await db.report.findFirstOrThrow({
    where: { productId },
    orderBy: { createdAt: "desc" },
  });
  expect(report.status).toBe("OPEN");
  // 7E：scope 快照 + 1:1 case 随创建事务落库
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  expect(report.campusId).toBe(campus.id);
  expect(report.scopeKey).toBe(`CAMPUS:${campus.id}`);
  const initialCase = await db.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
  expect(initialCase.closedAt).toBeNull();
  expect(initialCase.dueAt.getTime() - initialCase.openedAt.getTime()).toBe(48 * 60 * 60 * 1000);

  // ---------- 管理员：治理队列 → 详情 → 领用 → IN_REVIEW → RESOLVED ----------
  const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
  const admin = await adminContext.newPage();
  await admin.goto("/governance/reports?limit=50");
  await expect(admin.getByRole("heading", { name: "举报处理" })).toBeVisible();

  const reportCard = admin.locator("article", { hasText: title }).first();
  await expect(reportCard).toBeVisible();
  await reportCard.getByRole("link", { name: "查看详情" }).click();
  await expect(admin.getByRole("heading", { name: "举报详情" })).toBeVisible();

  // 领用 case（self claim）
  await admin.getByRole("form", { name: "领用 case" }).getByRole("button", { name: "领用 case" }).click();
  await expect
    .poll(async () =>
      (await db.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } })).assignedToId,
    )
    .toBeTruthy();

  // 标记处理中（form submit 走 server action；成功后 revalidate 刷新详情）
  await admin.getByRole("button", { name: "标记处理中" }).click();
  await expect
    .poll(async () => (await db.report.findUniqueOrThrow({ where: { id: report.id } })).status)
    .toBe("IN_REVIEW");
  const inReviewCase = await db.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
  expect(inReviewCase.closedAt).toBeNull();

  // 重新加载详情后填备注并完成处理
  await admin.goto(`/governance/reports/${report.id}`);
  await admin.getByRole("heading", { name: "举报详情" }).waitFor();
  await admin.locator('textarea[name="handledNote"]').first().fill(`E2E 7E 处理备注 ${tag}`);
  await admin.getByRole("button", { name: "处理完成" }).click();
  await expect
    .poll(async () => (await db.report.findUniqueOrThrow({ where: { id: report.id } })).status)
    .toBe("RESOLVED");

  // DB 终态：RESOLVED + case CLOSED + 同步时钟
  const resolvedCase = await db.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
  expect(resolvedCase.closedAt).not.toBeNull();

  const notification = await db.notification.findFirst({
    where: { userId: report.reporterId, type: "REPORT", title: "举报已处理" },
    orderBy: { createdAt: "desc" },
  });
  expect(notification).not.toBeNull();
  await adminContext.close();
});

test("7E-E2E02 reopen RESOLVED → IN_REVIEW → dueAt 重置 → case ACTIVE", async ({ browser }) => {
  const tag = uniqueTag("p7e-02");
  const db = e2eDb();
  const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
  const admin = await adminContext.newPage();

  // fixture：已 RESOLVED 的商品举报 + CLOSED case
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const seller = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.seller.email } });
  const buyer = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.buyer.email } });
  const product = await db.product.create({
    data: {
      title: `E2E7Ereopen ${tag}`,
      description: "7E reopen 流程",
      price: "12",
      status: "ACTIVE",
      condition: "NORMAL_USED",
      locationText: "E2E 北门",
      sellerId: seller.id,
      campusId: campus.id,
      categoryId: (await db.productCategory.findFirstOrThrow({ where: { slug: "books" } })).id,
    },
  });
  const report = await createScopedReportFixture({
    reporterId: buyer.id,
    campusId: campus.id,
    scopeKey: `CAMPUS:${campus.id}`,
    targetType: "PRODUCT",
    productId: product.id,
  });
  await db.report.update({
    where: { id: report.id },
    data: { status: "RESOLVED", handledAt: new Date(), handledById: buyer.id, handledNote: "E2E 预置终局" },
  });
  const openedAt = new Date(Date.now() - 72 * 60 * 60 * 1000);
  await db.moderationCase.update({
    where: { reportId: report.id },
    data: { closedAt: new Date(), openedAt, dueAt: new Date(openedAt.getTime() + 48 * 60 * 60 * 1000) },
  });

  // 详情：CLOSED 徽标 → 重新标记处理中（reopen）
  await admin.goto(`/governance/reports/${report.id}`);
  await expect(admin.getByRole("heading", { name: "举报详情" })).toBeVisible();
  await expect(admin.getByText("CLOSED")).toBeVisible();
  await admin.getByRole("button", { name: "标记处理中" }).click();

  // DB 权威：status 回 IN_REVIEW；case 回 ACTIVE；openedAt/dueAt 以 reopen 时刻重置
  await expect
    .poll(async () => (await db.report.findUniqueOrThrow({ where: { id: report.id } })).status)
    .toBe("IN_REVIEW");
  const reopenedCase = await db.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
  expect(reopenedCase.closedAt).toBeNull();
  expect(reopenedCase.openedAt.getTime()).toBeGreaterThan(openedAt.getTime());
  expect(reopenedCase.dueAt.getTime() - reopenedCase.openedAt.getTime()).toBe(48 * 60 * 60 * 1000);
  await adminContext.close();
});

test("7E-E2E03 CAMPUS_REPORT_REVIEWER：见本校区，不可见跨校区/UNSCOPED（详情 404 反 oracle）", async ({ browser }) => {
  const tag = uniqueTag("p7e-03");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  // campus B + 跨校商品举报 + UNSCOPED 用户举报（DB fixture）
  const campusB = await db.campus.create({
    data: { name: `E2E校区B ${tag}`, slug: `e2e-7e-b-${tag}`, schoolName: "E2E 大学", isActive: true },
  });
  const seller = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.seller.email } });
  const buyer = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.buyer.email } });
  const productB = await db.product.create({
    data: {
      title: `E2E7E跨校 ${tag}`,
      description: "7E 跨校区隔离",
      price: "20",
      status: "ACTIVE",
      condition: "NORMAL_USED",
      locationText: "E2E 校区B",
      sellerId: seller.id,
      campusId: campusB.id,
      categoryId: (await db.productCategory.findFirstOrThrow({ where: { slug: "books" } })).id,
    },
  });
  const reportB = await createScopedReportFixture({
    reporterId: buyer.id,
    campusId: campusB.id,
    scopeKey: `CAMPUS:${campusB.id}`,
    targetType: "PRODUCT",
    productId: productB.id,
  });
  const reportUnscoped = await createScopedReportFixture({
    reporterId: buyer.id,
    campusId: null,
    scopeKey: "UNSCOPED",
    targetType: "USER",
    targetUserId: seller.id,
  });
  const reportA = await createScopedReportFixture({
    reporterId: buyer.id,
    campusId: campus.id,
    scopeKey: `CAMPUS:${campus.id}`,
    targetType: "USER",
    targetUserId: seller.id,
  });

  // 校区 A 举报审核员（ACTIVE membership + CAMPUS_REPORT_REVIEWER@main）
  const reviewerEmail = `p7e-reviewer-${tag}@e2e.test`;
  const reviewer = await db.user.create({
    data: {
      email: reviewerEmail,
      name: `E2E举报审核员 ${tag}`,
      passwordHash: hashSync(`${TEST_PASSWORD_PREFIX}Reviewer#2026`, 10),
      schoolName: campus.schoolName,
      campusId: campus.id,
      verificationStatus: "VERIFIED",
    },
  });
  await db.campusMembership.create({
    data: { userId: reviewer.id, campusId: campus.id, status: "ACTIVE" },
  });
  // consent gate：新用户必须先有全部政策接受记录，否则登录后被引导 /legal/accept
  await createTestFixtureAcceptance(db, reviewer.id);
  const role = await db.role.findFirstOrThrow({ where: { key: "CAMPUS_REPORT_REVIEWER" } });
  await db.userRoleAssignment.create({
    data: { userId: reviewer.id, roleId: role.id, campusId: campus.id, scopeKey: `CAMPUS:${campus.id}` },
  });

  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  await loginViaUI(reviewerPage, reviewerEmail, `${TEST_PASSWORD_PREFIX}Reviewer#2026`, `E2E举报审核员 ${tag}`);

  // 精确 capability 派生导航：reviewer 侧栏含「举报处理」
  await reviewerPage.goto("/governance/reports?limit=50");
  await expect(reviewerPage.getByRole("heading", { name: "举报处理" })).toBeVisible();
  await expect(reviewerPage.getByRole("link", { name: "举报处理" })).toBeVisible();

  // campus A 举报可见（详情链接 href 精确绑定 reportId；hydration 双挂载期间
  // 元素瞬态重复——first() 收敛，7B 同款约定）；campus B / UNSCOPED 不可见
  await expect(
    reviewerPage.locator(`a[href="/governance/reports/${reportA.id}"]`).first(),
  ).toBeVisible();
  await expect(
    reviewerPage.locator(`a[href="/governance/reports/${reportB.id}"]`),
  ).toHaveCount(0);
  await expect(
    reviewerPage.locator(`a[href="/governance/reports/${reportUnscoped.id}"]`),
  ).toHaveCount(0);

  // 跨校区/UNSCOPED 详情 → 404 UI（与 missing 同形，无存在性 oracle）。
  // 7A 已知坑：流式 SSR 下 notFound 以 200 交付 404 UI——断言可见标题而非状态码
  await reviewerPage.goto(`/governance/reports/${reportB.id}`);
  await expect(reviewerPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await reviewerPage.goto(`/governance/reports/${reportUnscoped.id}`);
  await expect(reviewerPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await reviewerPage.goto(`/governance/reports/p7e-ghost-report`);
  await expect(reviewerPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();

  // 本校区详情可达
  const own = await reviewerPage.goto(`/governance/reports/${reportA.id}`);
  expect(own?.status()).toBe(200);
  await expect(reviewerPage.getByRole("heading", { name: "举报详情" })).toBeVisible();

  await reviewerContext.close();
});

test("7E-E2E04 rental 举报：创建 → 队列 → 审核（rental repair 全链）", async ({ browser }) => {
  const tag = uniqueTag("p7e-04");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const seller = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.seller.email } });
  const buyer = await db.user.findFirstOrThrow({ where: { email: E2E_ACCOUNTS.buyer.email } });

  // 租赁物品 fixture（经 DB，聚焦举报链路本身）
  const rental = await db.rentalListing.create({
    data: {
      title: `E2E7E租赁 ${tag}`,
      description: "7E rental repair 全链",
      price: "30",
      pricingUnit: "PER_DAY",
      depositAmount: "50",
      condition: "NORMAL_USED",
      status: "AVAILABLE",
      ownerId: seller.id,
      campusId: campus.id,
      categoryId: (await db.rentalCategory.findFirstOrThrow({ where: { isActive: true } })).id,
      totalQuantity: 1,
      availableQuantity: 1,
      minimumDuration: 1,
      maximumDuration: 30,
      pickupLocation: "北门",
      returnLocation: "北门",
    },
  });

  // 买家举报租赁（真实弹窗表单 → server action）
  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyerPage = await buyerContext.newPage();
  await buyerPage.goto(`/rentals/${rental.id}`);
  await buyerPage.getByRole("button", { name: "举报此物品" }).click();
  await buyerPage.locator('select[name="reason"]').selectOption("SCAM_RISK");
  await buyerPage.locator('textarea[name="detail"]').fill(`E2E 租赁举报 ${tag}`);
  await buyerPage.getByRole("button", { name: "提交举报" }).click();
  await expect(buyerPage.getByText("举报已成功提交")).toBeVisible({ timeout: 15_000 });
  await buyerContext.close();

  const report = await db.report.findFirstOrThrow({
    where: { rentalListingId: rental.id, reporterId: buyer.id },
    orderBy: { createdAt: "desc" },
  });
  expect(report.targetType).toBe("RENTAL_LISTING");
  expect(report.campusId).toBe(campus.id);
  expect(report.scopeKey).toBe(`CAMPUS:${campus.id}`);
  const kase = await db.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
  expect(kase.closedAt).toBeNull();
  // RiskFlag projection 收敛（owner 归属 + campus 对齐）
  const flag = await db.riskFlag.findFirstOrThrow({
    where: { kind: "REPORT_SUBMITTED", sourceType: "REPORT", sourceId: report.id },
  });
  expect(flag.userId).toBe(seller.id);
  expect(flag.campusId).toBe(campus.id);

  // 管理员：队列出现（safeTargetLabel=租赁：title）→ 详情 → 处理完成
  const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
  const admin = await adminContext.newPage();
  await admin.goto("/governance/reports?limit=50");
  const card = admin.locator("article", { hasText: `租赁：E2E7E租赁 ${tag}` }).first();
  await expect(card).toBeVisible();
  await card.getByRole("link", { name: "查看详情" }).click();
  await admin.getByRole("button", { name: "处理完成" }).click();
  await expect
    .poll(async () => (await db.report.findUniqueOrThrow({ where: { id: report.id } })).status)
    .toBe("RESOLVED");
  await expect
    .poll(async () => (await db.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } })).closedAt)
    .not.toBeNull();
  await adminContext.close();
});

test("7E-E2E05 legacy /admin/reports → canonical redirect", async ({ browser }) => {
  const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
  const admin = await adminContext.newPage();
  await admin.goto("/admin/reports");
  await expect(admin).toHaveURL(/\/governance\/reports$/);
  await expect(admin.getByRole("heading", { name: "举报处理" })).toBeVisible();
  await adminContext.close();
});
