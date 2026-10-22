import { expect, test } from "@playwright/test";
import { hashSync } from "bcryptjs";

import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";
import { loginViaUI } from "./helpers/auth";
import { e2eDb } from "./helpers/db";
import { uniqueTag } from "./helpers/e2e";

/**
 * R3D02C07D04: a real Next.js Server Action (not an imported domain test),
 * with production Prisma6 withTransaction + E2E PostgreSQL and a reviewer JWT.
 * The corrupt historical origin is test-only data; no production writes.
 *
 * First RESTORE_PREVIOUS must fail atomically, then CLOSE_ORDER must succeed:
 * exactly one terminal status log, one AdminAudit, two source hold releases
 * and two canonical notifications, leaving an unrelated legal hold ACTIVE.
 */
test("租赁纠纷历史来源非法：真实管理员 RESTORE 拒绝零写入，改 CLOSE 后只完成一次终局", async ({ browser }) => {
  test.setTimeout(180_000);
  const db = e2eDb();
  const tag = uniqueTag("r3d02c07d04");
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const category = await db.rentalCategory.findFirstOrThrow({ where: { isActive: true } });

  const makeUser = async (suffix: string) => {
    const user = await db.user.create({
      data: {
        email: "r3d02c07d04-" + suffix + "-" + tag + "@e2e.test",
        name: "隔离租赁当事人" + suffix,
        passwordHash: hashSync("R3D02C07D04#" + tag, 10),
        schoolName: campus.schoolName,
        campusId: campus.id,
        verificationStatus: "VERIFIED",
      },
    });
    const membership = await db.campusMembership.upsert({
      where: { userId_campusId: { userId: user.id, campusId: campus.id } },
      create: { userId: user.id, campusId: campus.id, status: "ACTIVE" },
      update: {},
    });
    expect(membership.status).toBe("ACTIVE");
    return user;
  };

  const owner = await makeUser("owner");
  const renter = await makeUser("renter");
  const reviewer = await makeUser("reviewer");
  await createTestFixtureAcceptance(db, reviewer.id);
  const role = await db.role.findFirstOrThrow({
    where: { key: "CAMPUS_DISPUTE_REVIEWER" },
  });
  await db.userRoleAssignment.create({
    data: {
      userId: reviewer.id,
      roleId: role.id,
      campusId: campus.id,
      scopeKey: "CAMPUS:" + campus.id,
    },
  });

  const listing = await db.rentalListing.create({
    data: {
      ownerId: owner.id,
      categoryId: category.id,
      campusId: campus.id,
      title: "D04 真实管理员终局 " + tag,
      description: "真实 Prisma6 + Next.js 租赁纠纷终局隔离场景",
      condition: "NORMAL_USED",
      price: 100,
      pricingUnit: "PER_DAY",
      depositAmount: 50,
      minimumDuration: 1,
      maximumDuration: 30,
      pickupLocation: "E2E 前门",
      returnLocation: "E2E 前门",
      status: "AVAILABLE",
    },
  });
  const now = new Date();
  const order = await db.rentalOrder.create({
    data: {
      orderNumber: "R3D02C07D04-" + tag,
      rentalListingId: listing.id,
      ownerId: owner.id,
      renterId: renter.id,
      startTime: now,
      endTime: new Date(now.getTime() + 86400000),
      quantity: 1,
      unitPriceSnapshot: 100,
      pricingUnitSnapshot: "PER_DAY",
      rentalDuration: 1,
      rentalAmount: 100,
      depositAmount: 50,
      finalAmount: 150,
      paymentStatus: "OFFLINE_PENDING",
      depositStatus: "PENDING_PAYMENT",
      status: "IN_DISPUTE",
      pickupLocationSnapshot: "E2E 前门",
      returnLocationSnapshot: "E2E 前门",
    },
  });
  const dispute = await db.rentalDispute.create({
    data: {
      orderId: order.id,
      initiatorId: renter.id,
      reason: "D04 争议理由 " + tag,
      evidencePhotos: [],
      status: "OPEN",
      campusId: campus.id,
      scopeKey: "CAMPUS:" + campus.id,
      // A corrupt legacy snapshot: not a legal origin for a new dispute.
      openedFromOrderStatus: "IN_DISPUTE",
      dueAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    },
  });
  const sourceHolds = await Promise.all([owner.id, renter.id].map(subjectId =>
    db.dataHold.create({
      data: {
        type: "DISPUTE",
        subjectId,
        reasonCode: "ACTIVE_RENTAL_DISPUTE",
        sourceType: "RENTAL_DISPUTE",
        sourceId: dispute.id,
      },
    }),
  ));
  const unrelated = await db.dataHold.create({
    data: {
      type: "LEGAL",
      subjectId: owner.id,
      reasonCode: "D04_UNRELATED_LEGAL_HOLD",
    },
  });
  expect(sourceHolds).toHaveLength(2);
  const assertNoTerminalSideEffects = async () => {
    const [row, latestOrder, holds, auditCount, logCount, noticeCount] = await Promise.all([
      db.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } }),
      db.rentalOrder.findUniqueOrThrow({ where: { id: order.id } }),
      db.dataHold.findMany({ where: { sourceType: "RENTAL_DISPUTE", sourceId: dispute.id } }),
      db.adminLog.count({ where: { targetType: "RENTAL_DISPUTE", targetId: dispute.id } }),
      db.rentalOrderStatusLog.count({ where: { orderId: order.id } }),
      db.notification.count({ where: { kind: "RENTAL_DISPUTE_RESOLVED", userId: { in: [owner.id, renter.id] } } }),
    ]);
    expect(row.status).toBe("OPEN");
    expect(row.resolvedAt).toBeNull();
    expect(latestOrder.status).toBe("IN_DISPUTE");
    expect(latestOrder.rentalAmount.toString()).toBe("100");
    expect(latestOrder.finalAmount.toString()).toBe("150");
    expect(holds).toHaveLength(2);
    expect(holds.every(hold => hold.status === "ACTIVE" && hold.releasedAt === null)).toBe(true);
    expect(auditCount).toBe(0);
    expect(logCount).toBe(0);
    expect(noticeCount).toBe(0);
  };
  await assertNoTerminalSideEffects();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const password = "R3D02C07D04#" + tag;
  await loginViaUI(page, reviewer.email, password, reviewer.name ?? "");
  await page.goto("/governance/disputes/" + dispute.id + "?kind=RENTAL");
  await expect(page.getByRole("heading", { name: "纠纷详情" })).toBeVisible();
  await expect(page.getByText("D04 争议理由 " + tag)).toBeVisible();

  const form = page.getByRole("form", { name: "解决纠纷" });
  await expect(form).toBeVisible();
  await form.locator('select[name="resolutionCode"]').selectOption("MUTUAL_AGREEMENT");
  await form.locator('select[name="resolutionAction"]').selectOption("RESTORE_PREVIOUS");
  await form.locator('textarea[name="adminNote"]').fill("D04 仅允许管理员读取 " + tag);
  await form.getByRole("button", { name: "标记已解决" }).click();
  await expect(form.getByRole("alert")).toContainText("无法确定订单纠纷前状态", { timeout: 20_000 });
  await assertNoTerminalSideEffects();
  expect((await db.dataHold.findUniqueOrThrow({ where: { id: unrelated.id } })).status).toBe("ACTIVE");
  console.log("R3D02C07D04_RESTORE_DENIED_ZERO_WRITES_REAL_NEXT_PRISMA6_PG");

  // Same authorized reviewer and same case: a legal CLOSE_ORDER may finish.
  await form.locator('select[name="resolutionAction"]').selectOption("CLOSE_ORDER");
  await form.getByRole("button", { name: "标记已解决" }).click();
  await expect.poll(
    async () => (await db.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } })).status,
    { timeout: 20_000 },
  ).toBe("RESOLVED");
  const [result, finalOrder, holds, audit, statusLogs, notifications] = await Promise.all([
    db.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } }),
    db.rentalOrder.findUniqueOrThrow({ where: { id: order.id } }),
    db.dataHold.findMany({ where: { sourceType: "RENTAL_DISPUTE", sourceId: dispute.id } }),
    db.adminLog.findMany({ where: { targetType: "RENTAL_DISPUTE", targetId: dispute.id, action: "DISPUTE_RESOLVED" } }),
    db.rentalOrderStatusLog.findMany({ where: { orderId: order.id } }),
    db.notification.findMany({ where: { kind: "RENTAL_DISPUTE_RESOLVED", userId: { in: [owner.id, renter.id] } } }),
  ]);
  expect(result.resolutionAction).toBe("CLOSE_ORDER");
  expect(result.resolutionCode).toBe("MUTUAL_AGREEMENT");
  expect(result.resolvedById).toBe(reviewer.id);
  expect(finalOrder.status).toBe("CLOSED");
  expect(finalOrder.rentalAmount.toString()).toBe("100");
  expect(finalOrder.finalAmount.toString()).toBe("150");
  expect(holds).toHaveLength(2);
  expect(holds.every(hold => hold.status === "RELEASED" && hold.releasedById === reviewer.id)).toBe(true);
  expect((await db.dataHold.findUniqueOrThrow({ where: { id: unrelated.id } })).status).toBe("ACTIVE");
  expect(audit).toHaveLength(1);
  expect(audit[0].adminId).toBe(reviewer.id);
  expect(statusLogs).toHaveLength(1);
  expect(statusLogs[0]).toMatchObject({ fromStatus: "IN_DISPUTE", toStatus: "CLOSED", operatorId: reviewer.id });
  expect(notifications).toHaveLength(2);
  expect(new Set(notifications.map(n => n.userId))).toEqual(new Set([owner.id, renter.id]));
  expect(notifications.every(n => n.schemaVersion === 1)).toBe(true);

  // The original UI disappears in terminal status; a second terminal
  // action must not be available to issue another browser-side mutation.
  await expect(form).toHaveCount(0, { timeout: 20_000 });
  await page.reload();
  await expect(page.getByRole("form", { name: "解决纠纷" })).toHaveCount(0);
  expect(await db.adminLog.count({
    where: { targetType: "RENTAL_DISPUTE", targetId: dispute.id, action: "DISPUTE_RESOLVED" },
  })).toBe(1);
  console.log("R3D02C07D04_CLOSE_ONCE_AUDIT_HOLDS_LOG_NOTICES_REAL_NEXT_PRISMA6_PG");
  await ctx.close();
});
