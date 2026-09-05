import { test, expect } from "@playwright/test";
import { storageStatePath, uniqueTag, FIXTURE_IMAGES } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * GOLDEN FLOW — Phase 6A 认证生命周期 / RBAC / 敏感资产审计：
 * 学生提交认证 → 未授权访问被拒 → 审核员 permission 路径查看材料（产生审计）
 * → 批准 → DB 状态与审计行验证。
 * 跨校区 scope 拒绝的真实 PG 并发矩阵见 tests/integration/phase6-identity-rbac.test.ts。
 */

test("认证生命周期：提交 → 越权拒绝 → 审核员批准（含敏感访问审计）", async ({ browser }) => {
  const tag = uniqueTag("gf-verify");
  const outsiderEmail = "e2e-outsider@e2e.test";

  // ---------- 学生提交认证材料（复认证：VERIFIED → PENDING 合法流转） ----------
  const studentContext = await browser.newContext({ storageState: storageStatePath("outsider") });
  const student = await studentContext.newPage();
  await student.goto("/verification");
  await student.locator('input[name="studentIdLast4"]').first().fill("4321");
  await student
    .locator('input[name="studentCardImageFile"]')
    .first()
    .setInputFiles(FIXTURE_IMAGES.verification);
  await student.getByRole("button", { name: "提交认证" }).first().click();

  await expect
    .poll(async () =>
      (
        await e2eDb().userVerification.findFirst({
          where: { user: { email: outsiderEmail } },
        })
      )?.status,
    )
    .toBe("PENDING");

  const verification = await e2eDb().userVerification.findFirst({
    where: { user: { email: outsiderEmail } },
  });
  expect(verification).toBeTruthy();
  // Phase 6A：提交证据记录 policy 版本快照（e2e-setup 已发布 v1）
  expect(verification?.policyVersion).toBe(1);
  expect(verification?.policyHash).toBeTruthy();
  // Phase 6A：注册/补齐的 ACTIVE membership 存在
  const membership = await e2eDb().campusMembership.findFirst({
    where: { userId: verification!.userId },
  });
  expect(membership?.status).toBe("ACTIVE");

  const assetRef = verification!.studentCardImage;
  expect(assetRef.startsWith("asset:")).toBe(true);
  const assetId = assetRef.slice("asset:".length);
  await studentContext.close();

  // ---------- 未授权用户：敏感材料 403 + 审核后台不可入 ----------
  const buyerContext = await browser.newContext({ storageState: storageStatePath("buyer") });
  const buyerPage = await buyerContext.newPage();
  const forbidden = await buyerPage.request.get(`/api/assets/${assetId}/access`);
  expect(forbidden.status()).toBe(403);

  await buyerPage.goto("/admin/verifications");
  await expect(buyerPage).toHaveURL(/^(?!.*\/admin).*$/);
  await buyerContext.close();

  // ---------- 未登录：401 ----------
  const anonContext = await browser.newContext();
  const anonPage = await anonContext.newPage();
  const unauthenticated = await anonPage.request.get(`/api/assets/${assetId}/access`);
  expect(unauthenticated.status()).toBe(401);
  await anonContext.close();

  // ---------- 审核员（permission 路径）查看材料 → 敏感访问审计 ----------
  const adminContext = await browser.newContext({ storageState: storageStatePath("admin") });
  const adminPage = await adminContext.newPage();
  const access = await adminPage.request.get(`/api/assets/${assetId}/access`);
  expect(access.status()).toBe(200);
  const accessBody = (await access.json()) as { url: string; access: string };
  expect(accessBody.access).toBe("PRIVATE");
  expect(accessBody.url).toBe(`/api/assets/${encodeURIComponent(assetId)}/content`);

  const content = await adminPage.request.get(accessBody.url);
  expect(content.status()).toBe(200);

  await expect
    .poll(async () =>
      e2eDb().adminLog.count({
        where: { action: "VERIFICATION_ASSET_ACCESSED", targetId: assetId },
      }),
    )
    .toBeGreaterThan(0);

  // ---------- 审核批准：状态机推进 + 审计行 ----------
  await adminPage.goto("/admin/verifications");
  const reviewCard = adminPage.locator("article", { hasText: "E2E无关用户" }).first();
  await expect(reviewCard).toBeVisible();
  await reviewCard.getByPlaceholder("补充审核说明").fill(`E2E 通过 ${tag}`);
  await reviewCard.getByRole("button", { name: "通过认证" }).click();

  await expect
    .poll(async () =>
      (
        await e2eDb().userVerification.findFirst({
          where: { user: { email: outsiderEmail } },
        })
      )?.status,
    )
    .toBe("VERIFIED");

  const decisionAudit = await e2eDb().adminLog.findFirst({
    where: {
      action: "APPROVE_VERIFICATION",
      targetType: "USER_VERIFICATION",
      targetId: verification!.id,
    },
  });
  expect(decisionAudit).toBeTruthy();
  expect(decisionAudit?.campusId).toBe(membership?.campusId);
  expect(decisionAudit?.metadata).toMatchObject({ decision: "VERIFIED" });

  await adminContext.close();
});
