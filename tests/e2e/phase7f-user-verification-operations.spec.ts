import { test, expect } from "@playwright/test";
import { hashSync } from "bcryptjs";

import { uniqueTag, E2E_ACCOUNTS, storageStatePath } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";
import { loginViaUI } from "./helpers/auth";
import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";

/**
 * GOLDEN FLOWS — Phase 7F User & Campus Verification Operations（retry=0）：
 *
 * 7F-E2E01 PLATFORM_ADMIN → /governance/users → 停用 → 账号 SUSPENDED +
 *          执法记录可见（/governance/enforcement/targets）→ 恢复 ACTIVE
 * 7F-E2E02 CAMPUS_VERIFICATION_REVIEWER A → 认证队列见 A；不可见 B
 *          （详情 404 反 oracle）
 * 7F-E2E03 认证详情 → evidence 短授权访问（evidence.read）→ 通过认证
 * 7F-E2E04 VERIFIED → 吊销（REVOKED）
 * 7F-E2E05 legacy /admin/users → /governance/users redirect
 * 7F-E2E06 legacy /admin/verifications → /governance/verifications redirect
 *
 * Browser drives action, DB verifies invariant（helpers/db 的 e2eDb 连真实库）。
 */

const TEST_PASSWORD_PREFIX = process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e";

/** 直建 PENDING 认证（含 48h SLA + 可选 VERIFICATION 证据资产）。 */
async function createVerificationFixture(input: {
  userId: string;
  membershipId: string;
  withEvidenceAsset?: boolean;
  submittedAt?: Date;
}) {
  const db = e2eDb();
  const submittedAt = input.submittedAt ?? new Date();
  const verification = await db.userVerification.create({
    data: {
      userId: input.userId,
      membershipId: input.membershipId,
      schoolName: "E2E 大学",
      campusName: "主校区",
      studentIdLast4: "4321",
      studentCardImage: "legacy",
      status: "PENDING",
      submittedAt,
      reviewDueAt: new Date(submittedAt.getTime() + 48 * 60 * 60 * 1000),
    },
  });

  if (input.withEvidenceAsset) {
    const asset = await db.uploadedAsset.create({
      data: {
        ownerId: input.userId,
        category: "VERIFICATION",
        access: "PRIVATE",
        bucket: "campus-private",
        objectKey: `e2e/${verification.id}.webp`,
        mimeType: "image/webp",
        sizeBytes: 1024,
        status: "ATTACHED",
        verificationId: verification.id,
        attachedAt: new Date(),
      },
    });
    await db.userVerification.update({
      where: { id: verification.id },
      data: { studentCardImage: `asset:${asset.id}` },
    });
  }

  return verification;
}

/** 建用户 + ACTIVE membership（campus 可选）+ consent。 */
async function createE2EUser(input: {
  name: string;
  email: string;
  campusId: string;
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
      campusId: input.campusId,
      verificationStatus: "UNVERIFIED",
    },
  });
  await db.campusMembership.create({
    data: { userId: user.id, campusId: input.campusId, status: "ACTIVE" },
  });
  await createTestFixtureAcceptance(db, user.id);
  return { user, password };
}

test("7F-E2E01 管理员：用户队列 → 停用 → 执法记录可见 → 恢复", async ({ browser }) => {
  const tag = uniqueTag("p7f-01");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  // 独立目标用户（不碰共享账号，避免并行 spec 干扰）
  const { user: target } = await createE2EUser({
    name: `E2E7F用户 ${tag}`,
    email: `p7f-target-${tag}@e2e.test`,
    campusId: campus.id,
  });

  const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
  const admin = await adminContext.newPage();

  // 队列可见（createdAt DESC——最新 fixture 在首页）
  await admin.goto("/governance/users?limit=50");
  await expect(admin.getByRole("heading", { name: "用户管理" })).toBeVisible();
  const queueCard = admin.locator("article", { hasText: `E2E7F用户 ${tag}` }).first();
  await expect(queueCard).toBeVisible();
  await queueCard.getByRole("link", { name: "查看详情" }).click();
  await expect(admin.getByRole("heading", { name: `E2E7F用户 ${tag}` })).toBeVisible();
  // UP06：详情邮箱脱敏
  await expect(admin.getByText(/\*\*\*@e2e\.test/).first()).toBeVisible();
  await expect(admin.getByText("p7f-target-" + tag + "@e2e.test")).toHaveCount(0);

  // 停用（canonical suspendAccount）
  await admin.getByRole("button", { name: "停用账号" }).click();
  await expect
    .poll(async () => (await db.user.findUniqueOrThrow({ where: { id: target.id } })).status)
    .toBe("SUSPENDED");
  const enforcement = await db.enforcementAction.findFirstOrThrow({
    where: { targetId: target.id, type: "ACCOUNT_SUSPEND" },
  });
  expect(enforcement.actorId).toBeTruthy();

  // 执法记录可见（canonical 读面，详情页链接直达）
  await admin.goto(`/governance/enforcement/targets/${target.id}`);
  await expect(
    admin.getByRole("heading", { name: `目标执法历史：E2E7F用户 ${tag}` }),
  ).toBeVisible();
  await expect(admin.getByRole("heading", { name: "执法历史（因果序）" })).toBeVisible();
  await expect(admin.getByText("账号停用").first()).toBeVisible();

  // 恢复（canonical reinstateAccount）
  await admin.goto(`/governance/users/${target.id}`);
  await admin.getByRole("button", { name: "恢复账号" }).click();
  await expect
    .poll(async () => (await db.user.findUniqueOrThrow({ where: { id: target.id } })).status)
    .toBe("ACTIVE");
  const reinstate = await db.enforcementAction.findFirstOrThrow({
    where: { targetId: target.id, type: "ACCOUNT_REINSTATE" },
  });
  expect(reinstate.resultState).toContain("ACTIVE");

  await adminContext.close();
});

test("7F-E2E02 校区认证审核员：见本校区，不可见跨校区（详情 404 反 oracle）", async ({ browser }) => {
  const tag = uniqueTag("p7f-02");
  const db = e2eDb();
  const campusA = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const campusB = await db.campus.create({
    data: { name: `E2E7F校区B ${tag}`, slug: `e2e-7f-b-${tag}`, schoolName: "E2E 大学", isActive: true },
  });

  // 独立学生 A（不复用共享 outsider——UserVerification.userId 唯一约束下
  // 多轮运行/并行 spec 都安全）
  const { user: studentA } = await createE2EUser({
    name: `E2E7F本区学生 ${tag}`,
    email: `p7f-a-${tag}@e2e.test`,
    campusId: campusA.id,
  });
  const membershipA = await db.campusMembership.findFirstOrThrow({
    where: { userId: studentA.id, campusId: campusA.id },
  });
  const verificationA = await createVerificationFixture({
    userId: studentA.id,
    membershipId: membershipA.id,
  });

  const studentB = await db.user.create({
    data: {
      email: `p7f-b-${tag}@e2e.test`,
      name: `E2E7F跨校学生 ${tag}`,
      passwordHash: hashSync(`${TEST_PASSWORD_PREFIX}User#2026`, 10),
      schoolName: "E2E 大学",
      campusId: campusB.id,
      verificationStatus: "PENDING",
    },
  });
  const membershipB = await db.campusMembership.create({
    data: { userId: studentB.id, campusId: campusB.id, status: "ACTIVE" },
  });
  const verificationB = await createVerificationFixture({
    userId: studentB.id,
    membershipId: membershipB.id,
  });

  // 校区 A 认证审核员（ACTIVE membership + CAMPUS_VERIFICATION_REVIEWER@A）
  const reviewerEmail = `p7f-reviewer-${tag}@e2e.test`;
  const { password: reviewerPassword } = await createE2EUser({
    name: `E2E认证审核员 ${tag}`,
    email: reviewerEmail,
    campusId: campusA.id,
    password: `${TEST_PASSWORD_PREFIX}Reviewer#2026`,
  });
  const reviewerUser = await db.user.findUniqueOrThrow({ where: { email: reviewerEmail } });
  const role = await db.role.findFirstOrThrow({ where: { key: "CAMPUS_VERIFICATION_REVIEWER" } });
  await db.userRoleAssignment.create({
    data: {
      userId: reviewerUser.id,
      roleId: role.id,
      campusId: campusA.id,
      scopeKey: `CAMPUS:${campusA.id}`,
    },
  });

  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  await loginViaUI(reviewerPage, reviewerEmail, reviewerPassword, `E2E认证审核员 ${tag}`);

  // 精确 capability 派生导航 + 队列仅见 campus A
  await reviewerPage.goto("/governance/verifications?limit=50");
  await expect(reviewerPage.getByRole("heading", { name: "认证审核" })).toBeVisible();
  await expect(reviewerPage.getByRole("link", { name: "认证审核" })).toBeVisible();
  await expect(
    reviewerPage.locator(`a[href="/governance/verifications/${verificationA.id}"]`).first(),
  ).toBeVisible();
  await expect(
    reviewerPage.locator(`a[href="/governance/verifications/${verificationB.id}"]`),
  ).toHaveCount(0);

  // 跨校区详情 → 404 UI（与 missing 同形，无存在性 oracle；流式 SSR 下
  // notFound 以 200 交付 404 UI——断言可见标题而非状态码）
  await reviewerPage.goto(`/governance/verifications/${verificationB.id}`);
  await expect(reviewerPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await reviewerPage.goto("/governance/verifications/p7f-ghost-verification");
  await expect(reviewerPage.getByRole("heading", { name: "页面不存在" })).toBeVisible();

  // 本校区详情可达（SLA 字段呈现）
  const own = await reviewerPage.goto(`/governance/verifications/${verificationA.id}`);
  expect(own?.status()).toBe(200);
  await expect(reviewerPage.getByRole("heading", { name: "认证详情" })).toBeVisible();
  // hydration 双挂载期间元素瞬态重复——first() 收敛（7B 同款约定）
  await expect(reviewerPage.getByText(/审核时限/).first()).toBeVisible();

  await reviewerContext.close();
});

test("7F-E2E03 认证详情 → evidence 短授权访问 → 通过认证", async ({ browser }) => {
  const tag = uniqueTag("p7f-03");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  // 学生提交认证（真实 UI 表单）
  const studentEmail = `p7f-student-${tag}@e2e.test`;
  const { password: studentPassword } = await createE2EUser({
    name: `E2E7F认证学生 ${tag}`,
    email: studentEmail,
    campusId: campus.id,
  });
  const studentContext = await browser.newContext();
  const student = await studentContext.newPage();
  await loginViaUI(student, studentEmail, studentPassword, `E2E7F认证学生 ${tag}`);
  await student.goto("/verification");
  await student.locator('input[name="studentIdLast4"]').first().fill("7788");
  await student
    .locator('input[name="studentCardImageFile"]')
    .first()
    .setInputFiles("tests/e2e/fixtures/images/verification.jpg");
  await student.getByRole("button", { name: "提交认证" }).first().click();
  await expect
    .poll(async () =>
      (
        await e2eDb().userVerification.findFirst({ where: { user: { email: studentEmail } } })
      )?.status,
    )
    .toBe("PENDING");
  const verification = await db.userVerification.findFirstOrThrow({
    where: { user: { email: studentEmail } },
  });
  // SLA01（真实链路）：reviewDueAt = submittedAt + 48h
  expect(
    verification.reviewDueAt.getTime() - verification.submittedAt.getTime(),
  ).toBe(48 * 60 * 60 * 1000);
  const assetRef = verification.studentCardImage;
  expect(assetRef.startsWith("asset:")).toBe(true);
  await studentContext.close();

  // 校区认证审核员：详情 → evidence 短授权访问（verification.evidence.read@A）
  const reviewerEmail = `p7f-ev-reviewer-${tag}@e2e.test`;
  const { password: reviewerPassword } = await createE2EUser({
    name: `E2E7F证据审核员 ${tag}`,
    email: reviewerEmail,
    campusId: campus.id,
    password: `${TEST_PASSWORD_PREFIX}Reviewer#2026`,
  });
  const reviewerUser = await db.user.findUniqueOrThrow({ where: { email: reviewerEmail } });
  const role = await db.role.findFirstOrThrow({ where: { key: "CAMPUS_VERIFICATION_REVIEWER" } });
  await db.userRoleAssignment.create({
    data: {
      userId: reviewerUser.id,
      roleId: role.id,
      campusId: campus.id,
      scopeKey: `CAMPUS:${campus.id}`,
    },
  });

  const reviewerContext = await browser.newContext();
  const reviewer = await reviewerContext.newPage();
  await loginViaUI(reviewer, reviewerEmail, reviewerPassword, `E2E7F证据审核员 ${tag}`);

  const assetId = assetRef.slice("asset:".length);
  const access = await reviewer.request.get(`/api/assets/${encodeURIComponent(assetId)}/access`);
  expect(access.status()).toBe(200);
  const accessBody = (await access.json()) as { url: string; access: string };
  expect(accessBody.access).toBe("PRIVATE");
  const content = await reviewer.request.get(accessBody.url);
  expect(content.status()).toBe(200);
  // E06（真实链路）：permission 路径读取认证材料 → 敏感访问审计
  await expect
    .poll(async () =>
      e2eDb().adminLog.count({
        where: { action: "VERIFICATION_ASSET_ACCESSED", targetId: assetId },
      }),
    )
    .toBeGreaterThan(0);

  // 详情 → 通过认证
  await reviewer.goto(`/governance/verifications/${verification.id}`);
  await expect(reviewer.getByRole("heading", { name: "认证详情" })).toBeVisible();
  // hydration 双挂载期间元素瞬态重复——first() 收敛（7B 同款约定）
  await reviewer.getByPlaceholder("补充审核说明").first().fill(`E2E 7F 通过 ${tag}`);
  await reviewer.getByRole("button", { name: "通过认证" }).first().click();
  await expect
    .poll(async () =>
      (
        await e2eDb().userVerification.findUniqueOrThrow({ where: { id: verification.id } })
      ).status,
    )
    .toBe("VERIFIED");
  const decisionAudit = await db.adminLog.findFirst({
    where: { action: "APPROVE_VERIFICATION", targetId: verification.id },
  });
  expect(decisionAudit?.adminId).toBe(reviewerUser.id);

  await reviewerContext.close();
});

test("7F-E2E04 已认证 → 吊销（VERIFIED → REVOKED）", async ({ browser }) => {
  const tag = uniqueTag("p7f-04");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  const { user: student } = await createE2EUser({
    name: `E2E7F吊销学生 ${tag}`,
    email: `p7f-revoke-${tag}@e2e.test`,
    campusId: campus.id,
  });
  const membership = await db.campusMembership.findFirstOrThrow({
    where: { userId: student.id, campusId: campus.id },
  });
  const submittedAt = new Date();
  const verification = await db.userVerification.create({
    data: {
      userId: student.id,
      membershipId: membership.id,
      schoolName: "E2E 大学",
      campusName: "主校区",
      studentIdLast4: "6655",
      studentCardImage: "legacy",
      status: "VERIFIED",
      submittedAt,
      reviewDueAt: new Date(submittedAt.getTime() + 48 * 60 * 60 * 1000),
      reviewedAt: submittedAt,
    },
  });
  await db.user.update({
    where: { id: student.id },
    data: { verificationStatus: "VERIFIED" },
  });

  const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
  const admin = await adminContext.newPage();
  await admin.goto(`/governance/verifications/${verification.id}`);
  await expect(admin.getByRole("heading", { name: "认证详情" })).toBeVisible();
  await expect(admin.getByText(/该用户已认证：可吊销认证/).first()).toBeVisible();
  await admin.getByRole("button", { name: "吊销认证" }).first().click();
  await expect
    .poll(async () =>
      (
        await e2eDb().userVerification.findUniqueOrThrow({ where: { id: verification.id } })
      ).status,
    )
    .toBe("REVOKED");
  const revokeAudit = await db.adminLog.findFirst({
    where: { action: "REVOKE_VERIFICATION", targetId: verification.id },
  });
  expect(revokeAudit).toBeTruthy();
  const revokedUser = await db.user.findUniqueOrThrow({ where: { id: student.id } });
  expect(revokedUser.verificationStatus).toBe("REVOKED");
  await adminContext.close();
});

test("7F-E2E05 legacy /admin/users → /governance/users redirect", async ({ browser }) => {
  const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
  const admin = await adminContext.newPage();
  await admin.goto("/admin/users");
  await expect(admin).toHaveURL(/\/governance\/users$/);
  await expect(admin.getByRole("heading", { name: "用户管理" })).toBeVisible();
  await adminContext.close();
});

test("7F-E2E06 legacy /admin/verifications → /governance/verifications redirect", async ({ browser }) => {
  const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
  const admin = await adminContext.newPage();
  await admin.goto("/admin/verifications");
  await expect(admin).toHaveURL(/\/governance\/verifications$/);
  await expect(admin.getByRole("heading", { name: "认证审核" })).toBeVisible();
  await adminContext.close();
});
