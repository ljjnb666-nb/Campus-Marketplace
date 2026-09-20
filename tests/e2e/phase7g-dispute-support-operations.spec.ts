import { expect, test, type Page } from "@playwright/test";
import { hashSync } from "bcryptjs";

import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";
import { e2eDb } from "./helpers/db";
import { loginViaUI } from "./helpers/auth";
import { uniqueTag } from "./helpers/e2e";

/**
 * Phase 7G Dispute & Support Operations E2E（golden flows，retry=0）。
 *
 * 原则：Browser drives action, DB verifies invariant（e2eDb = 被测同库真实
 * PrismaClient）。治理 reviewer / support agent 会话 = 运行时 provision
 * （7F 同款：create user + ACTIVE membership + role assignment → loginViaUI）。
 *
 * 覆盖：
 *  - 7G-E2E01：renter 经 UI 发起纠纷 → 订单 IN_DISPUTE → campus reviewer
 *    见纠纷队列与详情
 *  - 7G-E2E02：reviewer claim → resolve RESTORE_PREVIOUS → 订单恢复 →
 *    dispute terminal → source-linked holds 双释放
 *  - 7G-E2E03：dispute evidence 精确绑定——本校区 reviewer 经 asset API 可读，
 *    跨校区 reviewer 403
 *  - 7G-E2E04：CAMPUS 工单全链（用户创建 → agent 领用/解决 → requester 见
 *    resolutionMessage、永不见 internalNote）
 *  - 7G-E2E05：UNSCOPED 工单——campus agent 不可见（详情 404 反 oracle），
 *    GLOBAL operator 可见可处理
 *  - 7G-E2E06：active 工单阻断注销合同（PrivacyRequest → BLOCKED +
 *    ACTIVE_SUPPORT_TICKET）
 *  - 7G-E2E07：appeal overdue 渲染（审核已超时徽标，只读）
 */

const TEST_PASSWORD_PREFIX = process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e";

async function createE2EUser(input: {
  name: string;
  email: string;
  campusId?: string;
  password?: string;
}) {
  const db = e2eDb();
  const password = input.password ?? `${TEST_PASSWORD_PREFIX}User#2026`;
  const user = await db.user.create({
    data: {
      email: input.email,
      name: input.name,
      passwordHash: hashSync(password, 10),
      schoolName: "E2E 大学",
      campusId: input.campusId ?? (await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } })).id,
      verificationStatus: "UNVERIFIED",
    },
  });
  if (input.campusId) {
    await db.campusMembership.create({
      data: { userId: user.id, campusId: input.campusId, status: "ACTIVE" },
    });
  }
  await createTestFixtureAcceptance(db, user.id);
  return { user, password };
}

async function assignRole(userId: string, roleKey: string, campusId?: string) {
  const db = e2eDb();
  const role = await db.role.findFirstOrThrow({ where: { key: roleKey } });
  await db.userRoleAssignment.create({
    data: {
      userId,
      roleId: role.id,
      campusId: campusId ?? null,
      scopeKey: campusId ? `CAMPUS:${campusId}` : "GLOBAL",
    },
  });
}

/** 租赁夹具：listing + IN_RENTAL 订单 + 状态日志（7G 纠纷链起点）。 */
async function createRentalFixture(input: {
  ownerId: string;
  renterId: string;
  campusId: string;
  tag: string;
  index: number;
  status?: "IN_RENTAL" | "COMPLETED" | "IN_DISPUTE";
}) {
  const db = e2eDb();
  const category = await db.rentalCategory.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  const listing = await db.rentalListing.create({
    data: {
      ownerId: input.ownerId,
      categoryId: category.id,
      campusId: input.campusId,
      title: `E2E7G租赁 ${input.tag}-${input.index}`,
      description: "E2E 纠纷链路夹具物品",
      condition: "NORMAL_USED",
      price: 100,
      pricingUnit: "PER_DAY",
      depositAmount: 50,
      minimumDuration: 1,
      maximumDuration: 30,
      pickupLocation: "E2E 门口",
      returnLocation: "E2E 门口",
      status: "AVAILABLE",
    },
  });
  const now = new Date();
  const order = await db.rentalOrder.create({
    data: {
      orderNumber: `E2E7G-${input.tag}-${input.index}`,
      rentalListingId: listing.id,
      ownerId: input.ownerId,
      renterId: input.renterId,
      startTime: now,
      endTime: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      quantity: 1,
      unitPriceSnapshot: 100,
      pricingUnitSnapshot: "PER_DAY",
      rentalDuration: 1,
      rentalAmount: 100,
      depositAmount: 50,
      finalAmount: 150,
      paymentStatus: "OFFLINE_PENDING",
      depositStatus: "PENDING_PAYMENT",
      status: input.status ?? "IN_RENTAL",
      pickupLocationSnapshot: "E2E 门口",
      returnLocationSnapshot: "E2E 门口",
    },
  });
  await db.rentalOrderStatusLog.create({
    data: {
      orderId: order.id,
      fromStatus: "PENDING_PICKUP",
      toStatus: "IN_RENTAL",
      operatorId: input.renterId,
      note: "e2e fixture",
    },
  });
  return { listing, order };
}

/** 直接 DB seed 一条 dispute（供 evidence / 队列过滤等治理侧断言使用）。 */
async function seedDispute(input: {
  orderId: string;
  initiatorId: string;
  campusId: string;
  status?: "OPEN" | "IN_REVIEW";
  evidencePhotos?: string[];
  reason?: string;
}) {
  const db = e2eDb();
  const now = new Date();
  return db.rentalDispute.create({
    data: {
      orderId: input.orderId,
      initiatorId: input.initiatorId,
      reason: input.reason ?? `E2E7G 纠纷描述 ${uniqueTag("seed")}`,
      evidencePhotos: input.evidencePhotos ?? [],
      status: input.status ?? "OPEN",
      campusId: input.campusId,
      scopeKey: `CAMPUS:${input.campusId}`,
      openedFromOrderStatus: "IN_RENTAL",
      dueAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      createdAt: now,
    },
  });
}

async function loginNewContext(browser: import("@playwright/test").Browser, email: string, password: string, name: string): Promise<{ context: import("@playwright/test").BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUI(page, email, password, name);
  return { context, page };
}

test("7G-E2E01 租客发起纠纷 → 订单 IN_DISPUTE → campus reviewer 见队列与详情", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p7g-01");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  const owner = await db.user.findFirstOrThrow({ where: { email: "e2e-seller@e2e.test" } });
  const renter = await db.user.findFirstOrThrow({ where: { email: "e2e-buyer@e2e.test" } });
  const { order } = await createRentalFixture({
    ownerId: owner.id,
    renterId: renter.id,
    campusId: campus.id,
    tag,
    index: 1,
  });

  // renter（共享 buyer storageState）经 UI 发起纠纷
  const renterContext = await browser.newContext({ storageState: "tests/e2e/.auth/buyer.json" });
  const renterPage = await renterContext.newPage();
  await renterPage.goto(`/rental-orders/${order.id}/dispute`);
  await expect(renterPage.getByRole("heading", { name: "发起纠纷" })).toBeVisible();
  await renterPage
    .locator('textarea[name="reason"]')
    .first()
    .fill(`E2E7G 归还物品与描述不符 ${tag}`);
  await renterPage.getByRole("button", { name: "提交纠纷申请" }).click();
  // RentalActionForm 成功后 redirect 到订单详情页（"action 后 revalidate 换掉
  // 反馈区"同款：先等重定向，DB 不变量随后断言）
  await expect(renterPage.getByText("申诉/纠纷处理中")).toBeVisible({ timeout: 20_000 });

  // DB 不变量：order IN_DISPUTE + dispute 快照 + SLA dueAt
  await expect
    .poll(async () => (await db.rentalOrder.findUniqueOrThrow({ where: { id: order.id } })).status, {
      timeout: 15_000,
    })
    .toBe("IN_DISPUTE");
  const dispute = await db.rentalDispute.findFirstOrThrow({ where: { orderId: order.id } });
  expect(dispute.status).toBe("OPEN");
  expect(dispute.campusId).toBe(campus.id);
  expect(dispute.scopeKey).toBe(`CAMPUS:${campus.id}`);
  expect(dispute.openedFromOrderStatus).toBe("IN_RENTAL");
  expect(dispute.dueAt.getTime() - dispute.createdAt.getTime()).toBeGreaterThanOrEqual(
    47.9 * 60 * 60 * 1000,
  );

  // campus dispute reviewer：队列可见 + 详情可达
  const reviewerEmail = `p7g-reviewer-${tag}@e2e.test`;
  const { user: reviewer, password: reviewerPassword } = await createE2EUser({
    name: `E2E7G纠纷审核员 ${tag}`,
    email: reviewerEmail,
    campusId: campus.id,
  });
  await assignRole(reviewer.id, "CAMPUS_DISPUTE_REVIEWER", campus.id);

  const { context: reviewerContext, page: reviewerPage } = await loginNewContext(
    browser,
    reviewerEmail,
    reviewerPassword,
    `E2E7G纠纷审核员 ${tag}`,
  );
  await reviewerPage.goto("/governance/disputes?limit=50");
  await expect(reviewerPage.getByRole("heading", { name: "纠纷处理" })).toBeVisible();
  // Phase 2 已知双渲染坑：软导航瞬间同元素短暂成对出现 → 一律 .first()
  const detailLink = reviewerPage
    .locator(`a[href="/governance/disputes/${dispute.id}"]`)
    .first();
  await expect(detailLink).toBeVisible();

  await detailLink.click();
  await expect(reviewerPage.getByText(`E2E7G 归还物品与描述不符 ${tag}`)).toBeVisible();
  await expect(reviewerPage.getByRole("form", { name: "领用纠纷" })).toBeVisible();

  await reviewerContext.close();
  await renterContext.close();
});

test("7G-E2E02 reviewer claim → resolve RESTORE_PREVIOUS → 订单恢复 + holds 释放", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p7g-02");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  const owner = await db.user.findFirstOrThrow({ where: { email: "e2e-seller@e2e.test" } });
  const renter = await db.user.findFirstOrThrow({ where: { email: "e2e-buyer@e2e.test" } });
  const { order } = await createRentalFixture({
    ownerId: owner.id,
    renterId: renter.id,
    campusId: campus.id,
    tag,
    index: 2,
  });
  const dispute = await seedDispute({
    orderId: order.id,
    initiatorId: renter.id,
    campusId: campus.id,
    reason: `E2E7G 需要恢复的纠纷 ${tag}`,
  });
  await db.rentalOrder.update({ where: { id: order.id }, data: { status: "IN_DISPUTE" } });

  // 发起时创建 source-linked holds（与 initiateDisputeTx 合同一致）
  for (const subjectId of [owner.id, renter.id]) {
    await db.dataHold.create({
      data: {
        type: "DISPUTE",
        subjectId,
        reasonCode: "ACTIVE_RENTAL_DISPUTE",
        sourceType: "RENTAL_DISPUTE",
        sourceId: dispute.id,
      },
    });
  }

  const reviewerEmail = `p7g-resolver-${tag}@e2e.test`;
  const { user: reviewer, password: reviewerPassword } = await createE2EUser({
    name: `E2E7G处理员 ${tag}`,
    email: reviewerEmail,
    campusId: campus.id,
  });
  await assignRole(reviewer.id, "CAMPUS_DISPUTE_REVIEWER", campus.id);

  const { context, page } = await loginNewContext(
    browser,
    reviewerEmail,
    reviewerPassword,
    `E2E7G处理员 ${tag}`,
  );
  await page.goto(`/governance/disputes/${dispute.id}`);
  await expect(page.getByText(`E2E7G 需要恢复的纠纷 ${tag}`).first()).toBeVisible();

  // claim（领用处理）。revalidate 会换掉反馈区（7A 已知坑）——先 poll DB
  await page.getByRole("form", { name: "领用纠纷" }).getByRole("button", { name: "领用处理" }).click();
  await expect
    .poll(async () => {
      const row = await db.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } });
      return `${row.status}:${row.assignedToId ?? "none"}`;
    }, { timeout: 15_000 })
    .toBe(`IN_REVIEW:${reviewer.id}`);

  // resolve：默认 resolutionCode=MUTUAL_AGREEMENT；action 选 RESTORE_PREVIOUS
  const resolveForm = page.getByRole("form", { name: "解决纠纷" });
  await resolveForm.locator('select[name="resolutionAction"]').selectOption("RESTORE_PREVIOUS");
  await resolveForm.getByRole("button", { name: "标记已解决" }).click();
  // 终局断言以 DB 为权威（revalidate 换掉反馈区）

  // DB 不变量：dispute terminal + 订单恢复 + holds 双释放 + 审计
  await expect
    .poll(async () => (await db.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } })).status, {
      timeout: 15_000,
    })
    .toBe("RESOLVED");
  const resolved = await db.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } });
  expect(resolved.resolutionCode).toBe("MUTUAL_AGREEMENT");
  expect(resolved.resolutionAction).toBe("RESTORE_PREVIOUS");
  expect(resolved.assignedToId).toBe(reviewer.id);
  expect((await db.rentalOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("IN_RENTAL");

  await expect
    .poll(
      async () =>
        db.dataHold.count({
          where: { sourceType: "RENTAL_DISPUTE", sourceId: dispute.id, status: "ACTIVE" },
        }),
      { timeout: 15_000 },
    )
    .toBe(0);
  const audits = await db.adminLog.findMany({
    where: { action: "DISPUTE_RESOLVED", targetType: "RENTAL_DISPUTE", targetId: dispute.id },
  });
  expect(audits).toHaveLength(1);

  await context.close();
});

test("7G-E2E03 dispute evidence：本校区可读 / 跨校区 403（精确绑定）", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p7g-03");
  const db = e2eDb();
  const campusA = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const campusB = await db.campus.create({
    data: { name: `E2E7G校区B ${tag}`, slug: `e2e-7g-b-${tag}`, schoolName: "E2E 大学", isActive: true },
  });

  const owner = await db.user.findFirstOrThrow({ where: { email: "e2e-seller@e2e.test" } });
  const renter = await db.user.findFirstOrThrow({ where: { email: "e2e-buyer@e2e.test" } });
  const { order } = await createRentalFixture({
    ownerId: owner.id,
    renterId: renter.id,
    campusId: campusA.id,
    tag,
    index: 3,
  });
  const dispute = await seedDispute({
    orderId: order.id,
    initiatorId: renter.id,
    campusId: campusA.id,
  });

  // 绑定证据 REPORT asset + 未绑定 REPORT asset（damage-claim 类）
  const evidence = await db.uploadedAsset.create({
    data: {
      ownerId: owner.id,
      category: "REPORT",
      access: "PRIVATE",
      bucket: "campus-private",
      objectKey: `e2e/7g/${tag}/evidence.webp`,
      mimeType: "image/webp",
      sizeBytes: 512,
      status: "ATTACHED",
      rentalOrderId: order.id,
      attachedAt: new Date(),
    },
  });
  await db.rentalDispute.update({
    where: { id: dispute.id },
    data: { evidencePhotos: { push: `asset:${evidence.id}` } },
  });
  const unreferenced = await db.uploadedAsset.create({
    data: {
      ownerId: owner.id,
      category: "REPORT",
      access: "PRIVATE",
      bucket: "campus-private",
      objectKey: `e2e/7g/${tag}/damage.webp`,
      mimeType: "image/webp",
      sizeBytes: 512,
      status: "ATTACHED",
      rentalOrderId: order.id,
      attachedAt: new Date(),
    },
  });

  const reviewerAEmail = `p7g-ev-a-${tag}@e2e.test`;
  const { user: reviewerA, password: reviewerAPassword } = await createE2EUser({
    name: `E2E7G证据审核A ${tag}`,
    email: reviewerAEmail,
    campusId: campusA.id,
  });
  await assignRole(reviewerA.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);

  const reviewerBEmail = `p7g-ev-b-${tag}@e2e.test`;
  const { user: reviewerB, password: reviewerBPassword } = await createE2EUser({
    name: `E2E7G证据审核B ${tag}`,
    email: reviewerBEmail,
    campusId: campusB.id,
  });
  await assignRole(reviewerB.id, "CAMPUS_DISPUTE_REVIEWER", campusB.id);

  // 本校区 reviewer：access API 200（同源代理 URL，不泄露存储细节）
  const { context: ctxA, page: pageA } = await loginNewContext(
    browser,
    reviewerAEmail,
    reviewerAPassword,
    `E2E7G证据审核A ${tag}`,
  );
  const accessA = await pageA.request.get(`/api/assets/${evidence.id}/access`);
  expect(accessA.status()).toBe(200);
  const bodyA = (await accessA.json()) as { url?: string };
  expect(bodyA.url).toContain(`/api/assets/${evidence.id}/content`);
  expect(JSON.stringify(bodyA)).not.toContain("bucket");
  expect(JSON.stringify(bodyA)).not.toContain("campus-private");

  // 本校区 reviewer：未绑定 REPORT（damage-claim 类）→ dispute.evidence.read 恒拒
  const accessUnreferenced = await pageA.request.get(`/api/assets/${unreferenced.id}/access`);
  expect(accessUnreferenced.status()).toBe(403);

  // 跨校区 reviewer：403（exact binding fail closed）
  const { context: ctxB, page: pageB } = await loginNewContext(
    browser,
    reviewerBEmail,
    reviewerBPassword,
    `E2E7G证据审核B ${tag}`,
  );
  const accessB = await pageB.request.get(`/api/assets/${evidence.id}/access`);
  expect(accessB.status()).toBe(403);

  await ctxA.close();
  await ctxB.close();
});

test("7G-E2E04 CAMPUS 工单全链：创建 → agent 领用/解决 → requester 见 message 永不见 internalNote", async ({ browser }) => {
  test.setTimeout(150_000);
  const tag = uniqueTag("p7g-04");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  const requesterEmail = `p7g-ticket-${tag}@e2e.test`;
  const { user: requester, password: requesterPassword } = await createE2EUser({
    name: `E2E7G工单用户 ${tag}`,
    email: requesterEmail,
    campusId: campus.id,
  });

  // 用户创建 CAMPUS 工单（真实 UI）
  const { context: userCtx, page: userPage } = await loginNewContext(
    browser,
    requesterEmail,
    requesterPassword,
    `E2E7G工单用户 ${tag}`,
  );
  await userPage.goto("/support");
  await userPage.locator('select[name="category"]').selectOption("MARKETPLACE");
  await userPage.locator('select[name="campusId"]').selectOption({ label: campus.name });
  await userPage.locator('input[name="subject"]').fill(`E2E7G 交易问题求助 ${tag}`);
  await userPage
    .locator('textarea[name="description"]')
    .fill(`E2E7G 需要校区支持人员协助处理一笔交易争议，描述内容 ${tag}。`);
  await userPage.getByRole("button", { name: "提交工单" }).click();
  await expect
    .poll(
      async () =>
        db.supportTicket.count({
          where: { requesterId: requester.id, subject: `E2E7G 交易问题求助 ${tag}` },
        }),
      { timeout: 15_000 },
    )
    .toBe(1);

  const ticket = await db.supportTicket.findFirstOrThrow({
    where: { requesterId: requester.id, subject: `E2E7G 交易问题求助 ${tag}` },
  });
  expect(ticket.status).toBe("OPEN");
  expect(ticket.scopeKey).toBe(`CAMPUS:${campus.id}`);
  expect(ticket.campusId).toBe(campus.id);
  const dueAtHours = (ticket.dueAt.getTime() - ticket.createdAt.getTime()) / (60 * 60 * 1000);
  expect(Math.abs(dueAtHours - 72)).toBeLessThan(0.1);

  // campus support agent：队列可见 → 领用 → 解决
  const agentEmail = `p7g-agent-${tag}@e2e.test`;
  const { user: agent, password: agentPassword } = await createE2EUser({
    name: `E2E7G支持专员 ${tag}`,
    email: agentEmail,
    campusId: campus.id,
  });
  await assignRole(agent.id, "CAMPUS_SUPPORT_AGENT", campus.id);

  const { context: agentCtx, page: agentPage } = await loginNewContext(
    browser,
    agentEmail,
    agentPassword,
    `E2E7G支持专员 ${tag}`,
  );
  await agentPage.goto("/governance/support?limit=50");
  await expect(agentPage.getByRole("heading", { name: "支持工单" })).toBeVisible();
  await agentPage.locator(`a[href="/governance/support/${ticket.id}"]`).first().click();
  await expect(agentPage.getByText(`E2E7G 交易问题求助 ${tag}`).first()).toBeVisible();

  await agentPage
    .getByRole("form", { name: "领用工单" })
    .getByRole("button", { name: "领用处理" })
    .click();
  // revalidate 换掉反馈区 → poll DB（领用状态权威）
  await expect
    .poll(async () => {
      const row = await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
      return `${row.status}:${row.assignedToId ?? "none"}`;
    }, { timeout: 15_000 })
    .toBe(`IN_PROGRESS:${agent.id}`);

  const resolveForm = agentPage.getByRole("form", { name: "解决工单" });
  await resolveForm.locator('select[name="resolutionCode"]').selectOption("USER_GUIDED");
  await resolveForm.locator('textarea[name="resolutionMessage"]').fill("请按指引完成退货流程");
  await resolveForm.locator('textarea[name="internalNote"]').fill(`E2E7G 内部备注机密内容 ${tag}`);
  await resolveForm.getByRole("button", { name: "标记已解决" }).click();
  await expect
    .poll(async () => (await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status, {
      timeout: 15_000,
    })
    .toBe("RESOLVED");

  // requester：见 resolutionMessage，永不见 internalNote
  await userPage.goto(`/support/${ticket.id}`);
  await expect(userPage.getByText("请按指引完成退货流程")).toBeVisible();
  expect(await userPage.content()).not.toContain(`E2E7G 内部备注机密内容 ${tag}`);

  // 审计合同
  const audits = await db.adminLog.findMany({
    where: { targetType: "SUPPORT_TICKET", targetId: ticket.id },
  });
  expect(audits.map((a) => a.action)).toContain("SUPPORT_TICKET_CLAIMED");
  expect(audits.map((a) => a.action)).toContain("SUPPORT_TICKET_RESOLVED");

  await agentCtx.close();
  await userCtx.close();
});

test("7G-E2E05 UNSCOPED 工单：campus agent 不可见（404 反 oracle），GLOBAL operator 可见", async ({ browser }) => {
  test.setTimeout(150_000);
  const tag = uniqueTag("p7g-05");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  const requester = await db.user.findFirstOrThrow({ where: { email: "e2e-buyer@e2e.test" } });
  const ticket = await db.supportTicket.create({
    data: {
      requesterId: requester.id,
      campusId: null,
      scopeKey: "UNSCOPED",
      category: "OTHER",
      status: "OPEN",
      subject: `E2E7G 平台级工单 ${tag}`,
      description: "E2E7G UNSCOPED 工单描述，仅平台级专员可见。",
      dueAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    },
  });

  const agentEmail = `p7g-unscoped-agent-${tag}@e2e.test`;
  const { user: agent, password: agentPassword } = await createE2EUser({
    name: `E2E7G校区专员 ${tag}`,
    email: agentEmail,
    campusId: campus.id,
  });
  await assignRole(agent.id, "CAMPUS_SUPPORT_AGENT", campus.id);

  const { context: agentCtx, page: agentPage } = await loginNewContext(
    browser,
    agentEmail,
    agentPassword,
    `E2E7G校区专员 ${tag}`,
  );
  await agentPage.goto("/governance/support?limit=50");
  await expect(agentPage.getByRole("heading", { name: "支持工单" })).toBeVisible();
  await expect(agentPage.locator(`a[href="/governance/support/${ticket.id}"]`).first()).toHaveCount(0);

  // 详情直击 → 404 反 oracle（SSR 流式 404 UI 以可见标题断言）
  await agentPage.goto(`/governance/support/${ticket.id}`);
  await expect(agentPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await agentCtx.close();

  // GLOBAL operator（admin 种子账号 = PLATFORM_ADMIN 全量含 support.manage）
  const adminCtx = await browser.newContext({ storageState: "tests/e2e/.auth/admin.json" });
  const adminPage = await adminCtx.newPage();
  await adminPage.goto("/governance/support?limit=50");
  await expect(adminPage.getByRole("heading", { name: "支持工单" })).toBeVisible();
  await expect(
    adminPage.locator(`a[href="/governance/support/${ticket.id}"]`).first(),
  ).toBeVisible();

  await adminPage.goto(`/governance/support/${ticket.id}`);
  await expect(
    adminPage.getByText("E2E7G UNSCOPED 工单描述，仅平台级专员可见。").first(),
  ).toBeVisible();
  await adminCtx.close();
});

test("7G-E2E06 active 支持工单阻断注销（PrivacyRequest → BLOCKED + ACTIVE_SUPPORT_TICKET）", async ({ browser }) => {
  test.setTimeout(150_000);
  const tag = uniqueTag("p7g-06");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  const requesterEmail = `p7g-erase-${tag}@e2e.test`;
  const { user: requester, password: requesterPassword } = await createE2EUser({
    name: `E2E7G注销用户 ${tag}`,
    email: requesterEmail,
    campusId: campus.id,
  });

  // active 工单（真实 UI 创建）
  const { context: userCtx, page: userPage } = await loginNewContext(
    browser,
    requesterEmail,
    requesterPassword,
    `E2E7G注销用户 ${tag}`,
  );
  await userPage.goto("/support");
  await userPage.locator('select[name="category"]').selectOption("ACCOUNT");
  await userPage.locator('input[name="subject"]').fill(`E2E7G 注销前工单 ${tag}`);
  await userPage.locator('textarea[name="description"]').fill(`E2E7G 阻断注销的 active 工单描述 ${tag}。`);
  await userPage.getByRole("button", { name: "提交工单" }).click();
  await expect
    .poll(
      async () =>
        db.supportTicket.count({
          where: { requesterId: requester.id, subject: `E2E7G 注销前工单 ${tag}` },
        }),
      { timeout: 15_000 },
    )
    .toBe(1);

  // 用户申请注销（typed confirmation：输入"注销账号"）→ 被工单阻断
  await userPage.goto("/my/privacy");
  await expect(userPage.getByText(/注销后你的账号将无法登录/)).toBeVisible();
  await userPage.locator('input[name="confirmation"]').fill("注销账号");
  await userPage.getByRole("button", { name: "申请注销账号" }).click();
  await expect(userPage.getByTestId("deletion-result")).toBeVisible({ timeout: 20_000 });

  // DB 不变量：PrivacyRequest BLOCKED + reasonCode ACTIVE_SUPPORT_TICKET
  await expect
    .poll(
      async () => {
        const request = await db.privacyRequest.findFirstOrThrow({
          where: { userId: requester.id, type: "ACCOUNT_DELETION" },
          orderBy: { requestedAt: "desc" },
        });
        return request.status === "BLOCKED" ? request.reasonCode : request.status;
      },
      { timeout: 20_000 },
    )
    .toBe("ACTIVE_SUPPORT_TICKET");

  // 账号未被擦除
  const after = await db.user.findUniqueOrThrow({ where: { id: requester.id } });
  expect(after.erasedAt).toBeNull();

  await userCtx.close();
});

test("7G-E2E07 appeal overdue 渲染（审核已超时徽标；只读零自动决定）", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p7g-07");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  const admin = await db.user.findFirstOrThrow({ where: { email: "e2e-admin@e2e.test" } });
  const targetEmail = `p7g-appeal-target-${tag}@e2e.test`;
  const { user: target } = await createE2EUser({
    name: `E2E7G申诉目标 ${tag}`,
    email: targetEmail,
    campusId: campus.id,
  });

  // DB 直接 seed punitive EA（与 6C 集成夹具同形）；enforcementSeq 走
  // DB sequence 自增（显式 MAX+1 会与其他并行 spec 的 app 写竞态撞 unique）
  const enforcementAction = await db.enforcementAction.create({
    data: {
      type: "MEMBERSHIP_SUSPEND",
      actorId: admin.id,
      targetId: target.id,
      campusId: campus.id,
      scopeKey: `CAMPUS:${campus.id}`,
      reasonCode: "POLICY_VIOLATION",
      previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
      resultState: "CAMPUS_MEMBERSHIP:SUSPENDED",
    },
  });
  const appeal = await db.appeal.create({
    data: {
      enforcementActionId: enforcementAction.id,
      status: "SUBMITTED",
      statement: `E2E7G 申诉陈述 ${tag}`,
      // 超时夹具：reviewDueAt 显式置于过去（SLA-A02 只读渲染）
      reviewDueAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    },
  });

  const adminCtx = await browser.newContext({ storageState: "tests/e2e/.auth/admin.json" });
  const adminPage = await adminCtx.newPage();
  await adminPage.goto("/governance/appeals?limit=50");
  await expect(adminPage.getByRole("heading", { name: "申诉审核" })).toBeVisible();
  // CI retries 会为本 spec 累积多个 overdue fixture → 徽标存在性用 .first()
  await expect(adminPage.getByText("审核已超时").first()).toBeVisible();

  // 只读零自动决定：申诉保持 SUBMITTED、无 reviewedBy
  await expect
    .poll(async () => (await db.appeal.findUniqueOrThrow({ where: { id: appeal.id } })).status, {
      timeout: 10_000,
    })
    .toBe("SUBMITTED");
  const after = await db.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
  expect(after.reviewedById).toBeNull();

  await adminCtx.close();
});

