import { test, expect } from "@playwright/test";
import { hashSync } from "bcryptjs";
import { uniqueTag, E2E_ACCOUNTS } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";
import { loginViaUI } from "./helpers/auth";
import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";

/**
 * GOLDEN FLOW — Phase 7C Listing Moderation Operations Surface：
 *  7C-E2E01: campus content moderator（CAMPUS_CONTENT_MODERATOR）→ /governance/listings
 *            → 浏览检视定位商品 → takedown → 匿名访客 detail/list 不可见
 *            → owner 仍可见（治理处理中安全标识）→ 治理 detail 检视现势内容
 *            → restore → 公开恢复。
 *  7C-E2E02: campus A moderator 对 campus B 目标 → 404（跨校区防 oracle）。
 *  7C-E2E03: appeal-reviewer-only → /governance/listings → 404（sibling 自守）。
 *  7C-E2E04: PLATFORM_ADMIN → /admin/products → redirect /governance/listings → 治理可用。
 *
 * 隔离断言：moderation note 仅治理侧可见（owner 面无 reason/note）；
 * 审计 LISTING_TAKEDOWN/LISTING_RESTORED 机器 metadata（无 note）。
 */

const TEST_PASSWORD_PREFIX = process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e";

test("7C-E2E01/02：内容审核员 takedown → owner 安全可见 → restore；跨校区 404", async ({ browser }) => {
  const tag = uniqueTag("gf-p7c");
  const moderatorEmail = `p7c-moderator-${tag}@e2e.test`;
  const otherModeratorEmail = `p7c-othermod-${tag}@e2e.test`;
  const ownerEmail = `p7c-owner-${tag}@e2e.test`;
  const productTitle = `E2E治理商品 ${tag}`;

  // ---------- DB fixture：moderator（campus A）+ other moderator（campus B）+ owner+product ----------
  const db = e2eDb();
  const campusA = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const moderatorRole = await db.role.findUniqueOrThrow({
    where: { key: "CAMPUS_CONTENT_MODERATOR" },
  });
  const category = await db.productCategory.findFirstOrThrow();

  const campusB = await db.campus.create({
    data: {
      name: `E2E第二校区 ${tag}`,
      slug: `e2e-7c-b-${tag}`,
      schoolName: campusA.schoolName,
    },
  });

  async function createModerator(email: string, name: string, campusId: string) {
    const user = await db.user.create({
      data: {
        email,
        name,
        passwordHash: hashSync(`${TEST_PASSWORD_PREFIX}Moderator#2026`, 10),
        schoolName: campusA.schoolName,
        campusId,
        verificationStatus: "VERIFIED",
      },
    });
    await db.campusMembership.create({
      data: { userId: user.id, campusId, status: "ACTIVE" },
    });
    await db.userRoleAssignment.create({
      data: {
        userId: user.id,
        roleId: moderatorRole.id,
        campusId,
        scopeKey: `CAMPUS:${campusId}`,
      },
    });
    await createTestFixtureAcceptance(db, user.id);
    return user;
  }

  const moderator = await createModerator(moderatorEmail, "E2E内容审核员", campusA.id);
  const otherModerator = await createModerator(otherModeratorEmail, "E2E其他校区审核员", campusB.id);

  const owner = await db.user.create({
    data: {
      email: ownerEmail,
      name: "E2E被治理卖家",
      passwordHash: hashSync(`${TEST_PASSWORD_PREFIX}Owner#2026`, 10),
      schoolName: campusA.schoolName,
      campusId: campusA.id,
      verificationStatus: "VERIFIED",
    },
  });
  await db.campusMembership.create({
    data: { userId: owner.id, campusId: campusA.id, status: "ACTIVE" },
  });
  await createTestFixtureAcceptance(db, owner.id);

  const product = await db.product.create({
    data: {
      title: productTitle,
      description: "E2E 7C 治理流程测试商品描述",
      price: "66",
      status: "ACTIVE",
      condition: "NORMAL_USED",
      locationText: "东门",
      sellerId: owner.id,
      campusId: campusA.id,
      categoryId: category.id,
    },
  });

  const moderatorPassword = `${TEST_PASSWORD_PREFIX}Moderator#2026`;
  const ownerPassword = `${TEST_PASSWORD_PREFIX}Owner#2026`;

  // ---------- campus A moderator：浏览检视 → takedown ----------
  const moderatorContext = await browser.newContext();
  const moderatorPage = await moderatorContext.newPage();
  await loginViaUI(moderatorPage, moderatorEmail, moderatorPassword, "E2E内容审核员");

  await moderatorPage.goto("/governance/listings?tab=browse&type=PRODUCT");
  await expect(moderatorPage.getByRole("heading", { name: "内容治理" })).toBeVisible();
  const queueRow = moderatorPage.locator("article", { hasText: productTitle }).first();
  await expect(queueRow).toBeVisible();

  await queueRow.locator('select[name="reasonCode"]').selectOption("PROHIBITED_ITEM");
  await queueRow.locator('textarea[name="note"]').fill(`E2E 内部备注 ${tag}`);
  await queueRow.getByRole("button", { name: /强制下架/ }).click();

  await expect
    .poll(async () =>
      db.listingModeration.count({ where: { productId: product.id, resolvedAt: null } }),
    )
    .toBe(1);

  const moderationRow = await db.listingModeration.findFirstOrThrow({
    where: { productId: product.id, resolvedAt: null },
  });
  expect(moderationRow.observedStatus).toBe("ACTIVE");
  expect(moderationRow.campusId).toBe(campusA.id);

  // takedown 审计：机器 metadata（listingType/moderationId），note 不入审计
  const audit = await db.adminLog.findFirstOrThrow({
    where: { action: "LISTING_TAKEDOWN", targetId: product.id },
  });
  expect(audit.metadata).toMatchObject({ listingType: "PRODUCT", moderationId: moderationRow.id });
  expect(JSON.stringify(audit.metadata ?? {})).not.toContain(`E2E 内部备注 ${tag}`);

  // ---------- 匿名访客：detail 404 ----------
  const anonymousContext = await browser.newContext({ storageState: undefined });
  const anonymousPage = await anonymousContext.newPage();
  await anonymousPage.goto(`/products/${product.id}`);
  await expect(anonymousPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();

  // ---------- owner：治理处理中安全标识（无 reason/note 泄露） ----------
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await loginViaUI(ownerPage, ownerEmail, ownerPassword, "E2E被治理卖家");

  // FR-04：确定性断言——先锁定 URL 与页面唯一标题（页面稳定条件），
  // 再在 main landmark 内断言治理状态节点 count=1 + 可见。禁 .first()/sleep。
  await ownerPage.goto("/my/products");
  await expect(ownerPage).toHaveURL(/\/my\/products$/);
  await expect(
    ownerPage.getByRole("heading", { name: "我的发布" }),
  ).toBeVisible();
  await expect(ownerPage.getByTestId("moderation-pending-badge")).toHaveCount(1);
  await expect(ownerPage.getByTestId("moderation-pending-badge")).toBeVisible();

  await ownerPage.goto(`/products/${product.id}`);
  await expect(ownerPage).toHaveURL(new RegExp(`/products/${product.id}$`));
  await expect(ownerPage.getByRole("heading", { name: productTitle })).toBeVisible();
  const ownerMain = ownerPage.getByRole("main");
  await expect(ownerMain.getByTestId("moderation-hidden-banner")).toHaveCount(1);
  await expect(ownerMain.getByTestId("moderation-hidden-banner")).toBeVisible();
  await expect(ownerMain.getByText(`E2E 内部备注 ${tag}`)).toHaveCount(0);

  // ---------- moderator：治理 detail 检视现势内容 → restore ----------
  await moderatorPage.goto(`/governance/listings/product/${product.id}`);
  await expect(moderatorPage.getByRole("heading", { name: productTitle })).toBeVisible();
  await moderatorPage.getByRole("button", { name: "恢复公开展示" }).click();

  await expect
    .poll(async () =>
      db.listingModeration.count({ where: { productId: product.id, resolvedAt: null } }),
    )
    .toBe(0);

  const restoredAudit = await db.adminLog.findFirstOrThrow({
    where: { action: "LISTING_RESTORED", targetId: product.id },
  });
  expect(restoredAudit.metadata).toMatchObject({ moderationId: moderationRow.id });

  await anonymousPage.goto(`/products/${product.id}`);
  await expect(anonymousPage.getByRole("heading", { name: productTitle })).toBeVisible();

  await moderatorContext.close();
  await ownerContext.close();
  await anonymousContext.close();

  // ---------- 7C-E2E02：campus B moderator 对 campus A 目标 → 404 ----------
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await loginViaUI(otherPage, otherModeratorEmail, moderatorPassword, "E2E其他校区审核员");
  await otherPage.goto(`/governance/listings/product/${product.id}`);
  await expect(otherPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await otherPage.goto("/governance/listings?tab=browse&type=PRODUCT");
  await expect(otherPage.locator("article", { hasText: productTitle })).toHaveCount(0);
  await otherContext.close();

  // 清理（takedown 行有 Restrict FK，先删治理行）
  await db.listingModeration.deleteMany({ where: { productId: product.id } });
  await db.product.delete({ where: { id: product.id } });
  await db.userRoleAssignment.deleteMany({
    where: { userId: { in: [moderator.id, otherModerator.id] } },
  });
  await db.user.deleteMany({ where: { id: { in: [moderator.id, otherModerator.id, owner.id] } } });
  await db.campus.delete({ where: { id: campusB.id } });
});

test("7C-E2E03/04：appeal-reviewer-only 404；PLATFORM_ADMIN legacy redirect + 治理可用", async ({ browser }) => {
  const tag = uniqueTag("gf-p7c-gate");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const reviewerRole = await db.role.findUniqueOrThrow({
    where: { key: "CAMPUS_APPEAL_REVIEWER" },
  });
  const reviewerEmail = `p7c-revieweronly-${tag}@e2e.test`;

  const reviewer = await db.user.create({
    data: {
      email: reviewerEmail,
      name: "E2E申诉审核员",
      passwordHash: hashSync(`${TEST_PASSWORD_PREFIX}Reviewer#2026`, 10),
      schoolName: campus.schoolName,
      campusId: campus.id,
      verificationStatus: "VERIFIED",
    },
  });
  await db.campusMembership.create({
    data: { userId: reviewer.id, campusId: campus.id, status: "ACTIVE" },
  });
  await db.userRoleAssignment.create({
    data: {
      userId: reviewer.id,
      roleId: reviewerRole.id,
      campusId: campus.id,
      scopeKey: `CAMPUS:${campus.id}`,
    },
  });
  await createTestFixtureAcceptance(db, reviewer.id);

  // ---------- 7C-E2E03：appeal-reviewer-only → /governance/listings → 404 ----------
  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  await loginViaUI(reviewerPage, reviewerEmail, `${TEST_PASSWORD_PREFIX}Reviewer#2026`, "E2E申诉审核员");
  await reviewerPage.goto("/governance/listings");
  await expect(reviewerPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  // root gate union 不误伤 sibling：appeals 面仍可达
  await reviewerPage.goto("/governance/appeals");
  await expect(reviewerPage.getByRole("heading", { name: "申诉审核" })).toBeVisible();
  await reviewerContext.close();

  // ---------- 7C-E2E04：PLATFORM_ADMIN legacy redirect + 治理面可用 ----------
  const adminContext = await browser.newContext({ storageState: undefined });
  const adminPage = await adminContext.newPage();
  await loginViaUI(
    adminPage,
    E2E_ACCOUNTS.admin.email,
    E2E_ACCOUNTS.admin.password,
    E2E_ACCOUNTS.admin.name,
  );
  await adminPage.goto("/admin/products");
  await adminPage.waitForURL((url) => url.pathname === "/governance/listings");
  await expect(adminPage.getByRole("heading", { name: "内容治理" })).toBeVisible();
  await adminContext.close();

  await db.userRoleAssignment.deleteMany({ where: { userId: reviewer.id } });
  await db.user.delete({ where: { id: reviewer.id } });
});
