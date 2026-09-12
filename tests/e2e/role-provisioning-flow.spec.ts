import { test, expect } from "@playwright/test";
import { hashSync } from "bcryptjs";
import { uniqueTag, E2E_ACCOUNTS } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";
import { loginViaUI } from "./helpers/auth";
import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";

/**
 * GOLDEN FLOW — Phase 7B 治理角色供给面：
 * GLOBAL 角色管理者（PLATFORM_ADMIN）→ /governance/roles → 选校区 → exact-email
 * 查找候选（displayName）→ 授予 CAMPUS_APPEAL_REVIEWER → assignment 出现 →
 * 被授予者可入 /governance/appeals → 管理者按 assignmentId 撤回 → 被授予者 404。
 *
 * 隔离断言：未授权/匿名 /governance/roles → 保护行为（无存在性 oracle）；
 * appeal-reviewer-only /governance/roles → 404（页面自守）。
 * 授权矩阵/并发/P1 由 tests/integration/phase7b-role-provisioning.test.ts 覆盖。
 */

const TEST_PASSWORD_PREFIX = process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e";

test("角色管理治理面：查找 → 授予 → 被授予者可达 appeals → 撤回 → 404", async ({ browser }) => {
  const tag = uniqueTag("gf-p7b");
  const candidateEmail = `p7b-reviewer-${tag}@e2e.test`;
  const candidatePassword = `${TEST_PASSWORD_PREFIX}Candidate#2026`;
  const candidateName = "E2E角色目标";

  // ---------- DB fixture：候选用户（ACTIVE membership，零角色）----------
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  const candidate = await db.user.create({
    data: {
      email: candidateEmail,
      name: candidateName,
      passwordHash: hashSync(candidatePassword, 10),
      schoolName: campus.schoolName,
      campusId: campus.id,
      verificationStatus: "VERIFIED",
    },
  });
  await db.campusMembership.create({
    data: { userId: candidate.id, campusId: campus.id, status: "ACTIVE" },
  });
  await createTestFixtureAcceptance(db, candidate.id);

  // ---------- GLOBAL 角色管理者：查找 → 授予 ----------
  const managerContext = await browser.newContext();
  const managerPage = await managerContext.newPage();
  await loginViaUI(
    managerPage,
    E2E_ACCOUNTS.admin.email,
    E2E_ACCOUNTS.admin.password,
    E2E_ACCOUNTS.admin.name,
  );

  await managerPage.goto("/governance/roles");
  await expect(managerPage.getByRole("heading", { name: "角色管理" })).toBeVisible();

  // 等待客户端 hydration 收敛（瞬态双挂载期间 labeled form 内 select 数 >1），
  // 之后所有表单交互才可安全定位（确定性等待，非 sleep）
  await managerPage.waitForFunction(
    () =>
      document.querySelectorAll(
        'form[aria-label="查找候选用户"] select[name="campusId"]',
      ).length === 1,
  );

  // 第一步：exact-email 查找候选 → displayName 呈现
  const lookupForm = managerPage.locator("form[aria-label=\"查找候选用户\"]");
  await lookupForm.locator("select[name=\"campusId\"]").selectOption({ label: campus.name });
  await lookupForm.locator("input[name=\"email\"]").fill(candidateEmail);
  await lookupForm.getByRole("button", { name: "查找用户" }).click();
  await expect(lookupForm.getByText(`找到用户：${candidateName}`)).toBeVisible({
    timeout: 15_000,
  });

  // 第二步：确认授予 → assignment 出现在列表（含授予人 display name）
  const grantForm = managerPage.locator("form[aria-label=\"确认授予角色\"]");
  await grantForm.locator("select[name=\"campusId\"]").selectOption({ label: campus.name });
  await grantForm.locator("input[name=\"email\"]").fill(candidateEmail);
  await grantForm.getByRole("button", { name: "确认授予" }).click();
  await expect(grantForm.getByText("已授予校区申诉审核员角色")).toBeVisible({
    timeout: 15_000,
  });

  const assignmentRow = managerPage.locator("article", { hasText: candidateName }).first();
  await expect(assignmentRow).toBeVisible();
  await expect(assignmentRow).toContainText("校区申诉审核员");
  await expect(assignmentRow).toContainText(campus.name);
  await expect(assignmentRow).toContainText(E2E_ACCOUNTS.admin.name);

  const assignment = await db.userRoleAssignment.findFirstOrThrow({
    where: { userId: candidate.id, role: { key: "CAMPUS_APPEAL_REVIEWER" } },
  });

  // ---------- 被授予者：/governance/appeals 可达 ----------
  const candidateContext = await browser.newContext();
  const candidatePage = await candidateContext.newPage();
  await loginViaUI(candidatePage, candidateEmail, candidatePassword, candidateName);
  await candidatePage.goto("/governance/appeals");
  await expect(candidatePage.getByRole("heading", { name: "申诉审核" })).toBeVisible();

  // ---------- 管理者按 assignmentId 撤回 ----------
  await assignmentRow.getByRole("button", { name: "撤回" }).click();

  // revalidatePath 会替换列表 DOM（行内反馈随旧树消失）——先 poll DB 权威，
  // 再断言 revalidate 后列表更新（7A 同款约定）
  await expect
    .poll(async () =>
      db.userRoleAssignment.count({ where: { id: assignment.id } }),
    )
    .toBe(0);

  const revokeAudits = await db.adminLog.findMany({
    where: { action: "ROLE_REVOKED", targetId: candidate.id },
  });
  expect(revokeAudits).toHaveLength(1);

  await expect(
    managerPage.locator("article", { hasText: candidateName }),
  ).toHaveCount(0, { timeout: 15_000 });

  // ---------- 被授予者再访问：/governance/appeals → 用户可见 404 ----------
  await candidatePage.goto("/governance/appeals");
  await expect(candidatePage.getByRole("heading", { name: "页面不存在" })).toBeVisible();

  await candidateContext.close();

  // ---------- 匿名：保护行为（requireUser 重定向，绝不见管理面） ----------
  const anonContext = await browser.newContext({ storageState: undefined });
  const anonPage = await anonContext.newPage();
  await anonPage.goto("/governance/roles");
  await expect(anonPage.getByRole("heading", { name: "角色管理" })).toHaveCount(0);
  await anonContext.close();

  // ---------- 未授权（buyer）：/governance/roles → 用户可见 404 ----------
  const buyerContext = await browser.newContext();
  const buyerPage = await buyerContext.newPage();
  await loginViaUI(
    buyerPage,
    E2E_ACCOUNTS.buyer.email,
    E2E_ACCOUNTS.buyer.password,
    E2E_ACCOUNTS.buyer.name,
  );
  await buyerPage.goto("/governance/roles");
  await expect(buyerPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await buyerContext.close();

  await managerContext.close();
});

test("E2E03：appeal-reviewer-only 访问 /governance/roles → 404（页面自守）", async ({ browser }) => {
  const tag = uniqueTag("gf-p7b-x");
  const reviewerEmail = `p7b-appeal-only-${tag}@e2e.test`;
  const reviewerPassword = `${TEST_PASSWORD_PREFIX}AppealOnly#2026`;

  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const reviewerRole = await db.role.findUniqueOrThrow({
    where: { key: "CAMPUS_APPEAL_REVIEWER" },
  });

  const reviewer = await db.user.create({
    data: {
      email: reviewerEmail,
      name: "E2E仅申诉审核员",
      passwordHash: hashSync(reviewerPassword, 10),
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

  // reviewer-only 对 appeals 面可达（root gate union 不误伤），对 roles 面 404
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUI(page, reviewerEmail, reviewerPassword, "E2E仅申诉审核员");

  await page.goto("/governance/appeals");
  await expect(page.getByRole("heading", { name: "申诉审核" })).toBeVisible();

  await page.goto("/governance/roles");
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();

  await context.close();
});
