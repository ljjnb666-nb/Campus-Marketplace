import { expect, test, type Page } from "@playwright/test";
import { hashSync } from "bcryptjs";

import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";
import { e2eDb } from "./helpers/db";
import { loginViaUI } from "./helpers/auth";
import { uniqueTag } from "./helpers/e2e";

/**
 * Phase 8C-02 General OrderDispute surfaces E2E（golden flow，retry=0）。
 *
 * 原则：Browser drives action, DB verifies invariant（e2eDb = 被测同库真实
 * PrismaClient）；server action 为真实链路（/my/orders 卡片 → 真实
 * initiateGeneralOrderDispute → canonical initiateOrderDisputeTx）。
 *
 * 覆盖（指令 §70-§73，单一 critical path，PRODUCT）：
 *  - §70 buyer /my/orders → 发起纠纷（>=5 字 reason）→ 提交 → UI 刷新 →
 *    状态 = 纠纷处理中 → dispute 按钮消失；DB：Order IN_DISPUTE + OPEN dispute
 *  - §71 reviewer /governance/disputes → 见 商品订单纠纷 徽标 → 详情
 *    (?kind=ORDER) → 见 reason → claim → resolve RESTORE_PREVIOUS →
 *    terminal visible；DB：Order 恢复 + holds 双释放
 *  - §72 queue 页不出现 reason 原文 / adminNote / email
 *  - §73 ORDER 详情显示「暂不支持附件证据」；无 Rental PrivateAssetViewer 入口
 */

const TEST_PASSWORD_PREFIX = process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e";

test("8C-02 买家发起普通订单纠纷 → reviewer 统一队列处理（真实 action + DB）", async ({ browser }) => {
  test.setTimeout(180_000);
  const tag = uniqueTag("p8c02");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  const seller = await db.user.findFirstOrThrow({ where: { email: "e2e-seller@e2e.test" } });
  const buyer = await db.user.findFirstOrThrow({ where: { email: "e2e-buyer@e2e.test" } });

  // ── 夹具：PRODUCT 订单（ACCEPTED = 可 dispute 状态）────────────────────
  const category = await db.productCategory.create({
    data: { name: `E2E8C02类目 ${tag}`, slug: `e2e-p8c02-${tag}` },
  });
  const product = await db.product.create({
    data: {
      title: `E2E8C02 商品 ${tag}`,
      description: "Phase 8C-02 E2E 纠纷链路夹具商品",
      price: 66,
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
      orderNo: `E2EP8C02-${tag}`,
      type: "PRODUCT",
      status: "ACCEPTED",
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: product.id,
      amount: "66.00",
      meetingLocation: "E2E 东门",
    },
  });

  const reasonText = `E2E8C02 商品与描述不符，要求平台处理 ${tag}`;

  // ── §70 buyer 经 /my/orders 真实 server action 发起纠纷 ────────────────
  const buyerContext = await browser.newContext({ storageState: "tests/e2e/.auth/buyer.json" });
  const buyerPage = await buyerContext.newPage();
  await buyerPage.goto("/my/orders");

  const orderCard = buyerPage.locator("article", { hasText: `E2E8C02 商品 ${tag}` }).first();
  await expect(orderCard.getByRole("button", { name: "发起申诉" })).toBeVisible();
  await orderCard.getByRole("button", { name: "发起申诉" }).click();

  const dialog = buyerPage.locator("div.fixed.inset-0", { hasText: "发起订单维权申诉" }).first();
  await dialog.locator('textarea[name="reason"]').fill(reasonText);
  await dialog.getByRole("button", { name: "提交申诉" }).click();

  // 提交成功 → dialog 关闭 → window.location.reload() → 卡片刷新
  await expect(orderCard.getByText("纠纷处理中").first()).toBeVisible({ timeout: 30_000 });
  // dispute 按钮消失（IN_DISPUTE 不可再发起）
  await expect(orderCard.getByRole("button", { name: "发起申诉" })).toHaveCount(0);

  // DB 不变量：Order IN_DISPUTE + OrderDispute OPEN
  await expect
    .poll(async () => (await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, {
      timeout: 15_000,
    })
    .toBe("IN_DISPUTE");
  const dispute = await db.orderDispute.findFirstOrThrow({ where: { orderId: order.id } });
  expect(dispute.status).toBe("OPEN");
  expect(dispute.initiatorId).toBe(buyer.id);
  expect(dispute.campusId).toBe(campus.id);
  expect(dispute.scopeKey).toBe(`CAMPUS:${campus.id}`);
  expect(dispute.openedFromOrderStatus).toBe("ACCEPTED");
  expect(dispute.evidencePhotos).toEqual([]);

  // ── §71/§72 campus reviewer：统一队列 → ORDER 徽标 → 详情 → claim → resolve ──
  const reviewerEmail = `p8c02-reviewer-${tag}@e2e.test`;
  const reviewerPassword = `${TEST_PASSWORD_PREFIX}User#2026`;
  const reviewer = await db.user.create({
    data: {
      email: reviewerEmail,
      name: `E2E8C02纠纷审核员 ${tag}`,
      passwordHash: hashSync(reviewerPassword, 10),
      schoolName: "E2E 大学",
      campusId: campus.id,
      verificationStatus: "UNVERIFIED",
    },
  });
  await db.campusMembership.create({
    data: { userId: reviewer.id, campusId: campus.id, status: "ACTIVE" },
  });
  await createTestFixtureAcceptance(db, reviewer.id);
  const reviewerRole = await db.role.findFirstOrThrow({ where: { key: "CAMPUS_DISPUTE_REVIEWER" } });
  await db.userRoleAssignment.create({
    data: { userId: reviewer.id, roleId: reviewerRole.id, campusId: campus.id, scopeKey: `CAMPUS:${campus.id}` },
  });

  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  await loginViaUI(reviewerPage, reviewerEmail, reviewerPassword, `E2E8C02纠纷审核员 ${tag}`);

  await reviewerPage.goto("/governance/disputes?limit=50");
  await expect(reviewerPage.getByRole("heading", { name: "纠纷处理" })).toBeVisible();
  // Phase 2 已知双渲染坑：软导航瞬间同元素短暂成对出现 → 一律 .first()
  await expect(reviewerPage.getByText(/交易纠纷运营队列/).first()).toBeVisible();

  // §72：queue 行不含 reason 原文 / email
  const queueBody = await reviewerPage.locator("body").innerText();
  expect(queueBody).not.toContain(reasonText);
  expect(queueBody).not.toContain(buyer.email);

  // 该纠纷的行：ORDER 徽标 + 显式 kind 链接
  const disputeRow = reviewerPage.locator("article", { hasText: `订单 ${order.orderNo}` }).first();
  await expect(disputeRow.getByText("商品订单纠纷")).toBeVisible();
  const detailLink = disputeRow.locator(`a[href="/governance/disputes/${dispute.id}?kind=ORDER"]`);
  await expect(detailLink).toBeVisible();
  await detailLink.click();

  // 详情：类型徽标 + reason + §73 证据区占位（无 Rental PrivateAssetViewer）
  await expect(reviewerPage.getByText("纠纷类型：普通订单 · 二手商品")).toBeVisible();
  await expect(reviewerPage.getByText(reasonText)).toBeVisible();
  await expect(reviewerPage.getByText("当前普通订单纠纷暂不支持附件证据")).toBeVisible();
  await expect(reviewerPage.getByRole("button", { name: /查看证据/ })).toHaveCount(0);

  // claim → IN_REVIEW（selfAssigned 后出现 释放领用 + 终局表单）
  await reviewerPage.getByRole("form", { name: "领用纠纷" }).getByRole("button", { name: "领用处理" }).click();
  await expect(reviewerPage.getByText("已领用该纠纷")).toBeVisible({ timeout: 20_000 });

  // resolve RESTORE_PREVIOUS（adminNote 仅进详情，不进队列）
  const adminNoteText = `E2E8C02 内部处理备注 ${tag}`;
  const resolveForm = reviewerPage.getByRole("form", { name: "解决纠纷" });
  await resolveForm.locator('select[name="resolutionCode"]').selectOption("MUTUAL_AGREEMENT");
  await resolveForm.locator('select[name="resolutionAction"]').selectOption("RESTORE_PREVIOUS");
  await resolveForm.locator('textarea[name="adminNote"]').fill(adminNoteText);
  // 提交前「处理结果」是表单标签；异步刷新期间可能与终局标题共存。
  // 因此不能用全页 getByText("处理结果") 断言提交已经完成。
  await expect(resolveForm.getByRole("combobox", { name: "处理结果" })).toBeVisible();
  await resolveForm.getByRole("button", { name: "标记已解决" }).click();

  // 先观察旧表单卸载，再精确锁定 resolved-only 的 h2 标题所在 section。
  // 不使用 .first()、sleep 或全页宽泛文本匹配掩盖状态竞争。
  await expect(resolveForm).toHaveCount(0, { timeout: 20_000 });
  const resolvedSection = reviewerPage.locator("section", {
    has: reviewerPage.getByRole("heading", { name: "处理结果", level: 2, exact: true }),
  });
  await expect(resolvedSection).toHaveCount(1);
  await expect(
    resolvedSection.getByRole("heading", { name: "处理结果", level: 2, exact: true }),
  ).toBeVisible();
  await expect(resolvedSection.getByText(/双方协商一致/)).toBeVisible({ timeout: 20_000 });

  // DB 不变量：dispute RESOLVED + Order 恢复 ACCEPTED + 双方 holds RELEASED
  await expect
    .poll(async () => (await db.orderDispute.findUniqueOrThrow({ where: { id: dispute.id } })).status, {
      timeout: 15_000,
    })
    .toBe("RESOLVED");
  const finalOrder = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(finalOrder.status).toBe("ACCEPTED"); // RESTORE_PREVIOUS → openedFrom
  const holds = await db.dataHold.findMany({
    where: { sourceType: "ORDER_DISPUTE", sourceId: dispute.id },
  });
  expect(holds).toHaveLength(2);
  expect(holds.every((h) => h.status === "RELEASED")).toBe(true);

  // §72：终局后回到队列——adminNote / reason 仍不出现
  await reviewerPage.goto("/governance/disputes?limit=50");
  const queueBodyAfter = await reviewerPage.locator("body").innerText();
  expect(queueBodyAfter).not.toContain(reasonText);
  expect(queueBodyAfter).not.toContain(adminNoteText);
  expect(queueBodyAfter).not.toContain(buyer.email);

  await reviewerContext.close();
  await buyerContext.close();
});
