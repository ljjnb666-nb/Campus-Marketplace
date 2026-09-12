import { test, expect } from "@playwright/test";
import { hashSync } from "bcryptjs";
import { uniqueTag, E2E_ACCOUNTS } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";
import { loginViaUI } from "./helpers/auth";
import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";

/**
 * GOLDEN FLOW — Phase 7A 申诉审核治理面：
 * appellant（被停用）提交的 SUBMITTED Appeal → campus reviewer（CAMPUS_APPEAL_REVIEWER，
 * 经 canonical 系统角色）进入 /governance/appeals → 队列仅见授权行 → 详情 →
 * 开始审核（IN_REVIEW，无 ownership 语义）→ UPHELD终局 → DB terminal 状态 + 审计隔离。
 *
 *隔离断言：campus reviewer 不可入 legacy /admin（requireAdmin 零修改）；
 *未授权用户 /governance/appeals → 404（无存在性 oracle）；PLATFORM_ADMIN 双面可达。
 *ROLE_ASSIGN 授权矩阵由 tests/integration/phase7a-appeal-review-surface.test.ts 覆盖。
 */

const TEST_PASSWORD_PREFIX = process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e";

test("申诉审核治理面：campus reviewer 队列 → 详情 → 开始审核 → 维持处罚", async ({ browser }) => {
  const tag = uniqueTag("gf-p7a");
  const reviewerEmail = `p7a-reviewer-${tag}@e2e.test`;
  const appellantEmail = `p7a-appellant-${tag}@e2e.test`;
  const statement = `E2E申诉材料 ${tag}：请复核该处罚`;
  const decisionNote = `E2E 审核备注 ${tag}`;

  // ---------- DB fixture：campus reviewer（canonical 系统角色）+ appellant ----------
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const adminUser = await db.user.findUniqueOrThrow({
    where: { email: E2E_ACCOUNTS.admin.email },
  });
  const reviewerRole = await db.role.findUniqueOrThrow({
    where: { key: "CAMPUS_APPEAL_REVIEWER" },
  });

  const reviewer = await db.user.create({
    data: {
      email: reviewerEmail,
      name: "E2E审核员",
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

  const appellant = await db.user.create({
    data: {
      email: appellantEmail,
      name: "E2E申诉人",
      passwordHash: hashSync(`${TEST_PASSWORD_PREFIX}Appellant#2026`, 10),
      schoolName: campus.schoolName,
      campusId: campus.id,
      status: "SUSPENDED",
      verificationStatus: "VERIFIED",
    },
  });
  await db.campusMembership.create({
    data: { userId: appellant.id, campusId: campus.id, status: "SUSPENDED" },
  });

  // canonical MEMBERSHIP_SUSPEND 形状（campus 精确对：campusId=c ∧ scopeKey=CAMPUS:c）
  // ——campus reviewer（CAMPUS_APPEAL_REVIEWER@main-campus）的授权 scope
  const enforcementAction = await db.enforcementAction.create({
    data: {
      type: "MEMBERSHIP_SUSPEND",
      actorId: adminUser.id,
      targetId: appellant.id,
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
      statement,
    },
  });

  // ---------- campus reviewer：队列 → 详情 ----------
  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  await loginViaUI(reviewerPage, reviewerEmail, `${TEST_PASSWORD_PREFIX}Reviewer#2026`, "E2E审核员");

  // legacy /admin 隔离：requireAdmin 零修改 → campus reviewer 被弹回首页
  await reviewerPage.goto("/admin");
  await reviewerPage.waitForURL((url) => url.pathname === "/");
  await expect(reviewerPage.getByRole("heading", { name: "管理后台" })).toHaveCount(0);

  // 队列：仅授权行可见（canonical scope 过滤后呈现）
  await reviewerPage.goto("/governance/appeals");
  await expect(reviewerPage.getByRole("heading", { name: "申诉审核" })).toBeVisible();
  const queueRow = reviewerPage.locator("article", { hasText: "E2E申诉人" }).first();
  await expect(queueRow).toBeVisible();
  await expect(queueRow).toContainText("成员身份停用");
  await expect(queueRow).toContainText("待审核");

  // 详情：statement 为机密审核材料，仅详情呈现
  await queueRow.getByRole("link", { name: "查看详情" }).click();
  await expect(reviewerPage.getByRole("heading", { name: "申诉详情" })).toBeVisible();
  await expect(reviewerPage.getByText(statement)).toBeVisible();
  await expect(reviewerPage.getByRole("heading", { name: "审核操作" })).toBeVisible();

  // W1：SUBMITTED 仅「开始审核」
  await reviewerPage.getByRole("button", { name: "开始审核" }).click();
  await expect(reviewerPage.getByRole("button", { name: "维持处罚" })).toBeVisible({
    timeout: 15_000,
  });

  // campus reviewer 无恢复权：canGrant=false → 「通过申诉」不可用（A-15 UI 提示）
  await expect(reviewerPage.getByRole("button", { name: "通过申诉" })).toBeDisabled();

  const afterBegin = await db.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
  expect(afterBegin.status).toBe("IN_REVIEW");
  // begin review 不建立 ownership
  expect(afterBegin.reviewedById).toBeNull();
  expect(afterBegin.reviewedAt).toBeNull();

  // ---------- 终局决定：UPHELD ----------
  await reviewerPage.locator("textarea[name=\"decisionNote\"]").fill(decisionNote);
  await reviewerPage.getByRole("button", { name: "维持处罚" }).click();

  // DB terminal 状态：reviewedById = 实际决策者
  await expect
    .poll(async () => (await db.appeal.findUniqueOrThrow({ where: { id: appeal.id } })).status)
    .toBe("UPHELD");

  // action 成功 → revalidatePath 后页面进入 terminal 呈现（处理结果区）
  await expect(reviewerPage.getByText("处理结果：原处罚维持不变")).toBeVisible({
    timeout: 15_000,
  });

  const terminal = await db.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
  expect(terminal.reviewedById).toBe(reviewer.id);
  expect(terminal.reviewedAt).toBeTruthy();
  expect(terminal.decisionNote).toBe(decisionNote);
  expect(terminal.decisionReasonCode).toBe("MERIT_VIOLATION_CONFIRMED");

  // 零 operational restoration：appellant 保持 SUSPENDED
  const appellantAfter = await db.user.findUniqueOrThrow({
    where: { id: appellant.id },
    select: { status: true },
  });
  expect(appellantAfter.status).toBe("SUSPENDED");

  // A-18：decisionNote 绝不进入 AdminAudit
  const audits = await db.adminLog.findMany({
    where: { targetType: "APPEAL", targetId: appeal.id },
  });
  expect(audits.length).toBeGreaterThan(0);
  for (const audit of audits) {
    expect(audit.detail).toBeNull();
    expect(JSON.stringify(audit.metadata ?? {})).not.toContain(decisionNote);
  }
  await reviewerContext.close();

  // ---------- PLATFORM_ADMIN 双面可达（legacy /admin 不受 7A 影响） ----------
  const adminContext = await browser.newContext({
    storageState: undefined,
  });
  const adminPage = await adminContext.newPage();
  await loginViaUI(
    adminPage,
    E2E_ACCOUNTS.admin.email,
    E2E_ACCOUNTS.admin.password,
    E2E_ACCOUNTS.admin.name,
  );
  await adminPage.goto("/governance/appeals");
  await expect(adminPage.getByRole("heading", { name: "申诉审核" })).toBeVisible();
  await adminPage.goto("/admin");
  await expect(adminPage.getByRole("heading", { name: "管理后台" })).toBeVisible();
  await adminContext.close();

  // ---------- 未授权用户：/governance/appeals → 用户可见 404（无存在性 oracle） ----------
  // Next.js streaming 下 404 页可能以 200 状态交付，以用户可见的 404 页面为准
  //（与 security.spec.ts / rental-flow.spec.ts 同一约定）。
  const buyerContext = await browser.newContext();
  const buyerPage = await buyerContext.newPage();
  await loginViaUI(
    buyerPage,
    E2E_ACCOUNTS.buyer.email,
    E2E_ACCOUNTS.buyer.password,
    E2E_ACCOUNTS.buyer.name,
  );
  await buyerPage.goto(`/governance/appeals/${appeal.id}`);
  await expect(buyerPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await buyerPage.goto("/governance/appeals");
  await expect(buyerPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await buyerContext.close();
});
