import { expect, test } from "@playwright/test";
import { hashSync } from "bcryptjs";
import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";
import { loginViaUI } from "./helpers/auth";
import { e2eDb } from "./helpers/db";
import { uniqueTag } from "./helpers/e2e";
import { expectHeadingSettled } from "./helpers/hydration-settlement";

test.describe.configure({ retries: 0 });

test("10J-E2E01：analytics.read 多校区与 7/30 天精确隔离，非授权用户 404", async ({ browser }) => {
  test.setTimeout(120_000);
  const db = e2eDb();
  const tag = uniqueTag("p10j");
  const [a, b, permission] = await Promise.all([
    db.campus.create({ data: { name: "统计甲-" + tag, slug: "p10j-a-" + tag, schoolName: "E2E-A" } }),
    db.campus.create({ data: { name: "统计乙-" + tag, slug: "p10j-b-" + tag, schoolName: "E2E-B" } }),
    db.permission.findUniqueOrThrow({ where: { key: "analytics.read" }, select: { id: true } }),
  ]);
  // Never mutate the shared e2e-buyer account: concurrent security.spec tests
  // rely on it having NO governance capabilities. Own a separate account.
  const password = (process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e") + "Analyst#2026";
  const analyst = await db.user.create({
    data: {
      name: "E2E独立校区分析员", email: "p10j-analyst-" + tag + "@e2e.test",
      passwordHash: hashSync(password, 10), schoolName: a.schoolName,
      campusId: a.id, role: "STUDENT", verificationStatus: "VERIFIED",
    },
  });
  await createTestFixtureAcceptance(db, analyst.id);
  const role = await db.role.create({
    data: { key: "ANALYST_" + tag, name: "E2E 校区数据分析员", scope: "CAMPUS" },
  });
  await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  await db.campusMembership.create({
    data: { userId: analyst.id, campusId: a.id, status: "ACTIVE" },
  });
  await db.userRoleAssignment.create({
    data: { userId: analyst.id, roleId: role.id, campusId: a.id, scopeKey: "CAMPUS:" + a.id },
  });

  async function fixture(campusId: string, offsetDays: number, token: string, bookedValue?: string) {
    const occurredAt = new Date(Date.now() - offsetDays * 86_400_000);
    const value = bookedValue ?? "1";
    const isAmount = bookedValue !== undefined;
    const eventType = isAmount ? "LIQUIDITY_TRANSACTION_VALUE_RECORDED" : "LIQUIDITY_LISTING_CREATED";
    const metricKey = isAmount ? "COMPLETED_TRANSACTION_VALUE" : "NEW_LISTING_COUNT";
    const dimensionKey = isAmount ? "TRANSACTION_TYPE:PRODUCT" : "LISTING_TYPE:PRODUCT";
    const event = await db.domainEvent.create({
      data: {
        eventType, schemaVersion: 1, aggregateType: isAmount ? "TRANSACTION" : "LISTING",
        aggregateId: token, campusId, occurrenceKey: "PHASE10J:" + token,
        occurredAt, sourceType: "E2E_FIXTURE",
        payload: isAmount
          ? { transactionId: token, transactionType: "PRODUCT", bookedValue: value }
          : { listingId: token, listingType: "PRODUCT" },
      },
    });
    await db.projectionReceipt.create({ data: {
      projectionKey: "ANALYTICS_METRIC_CONTRIBUTIONS", projectionVersion: 3, eventId: event.id,
    } });
    await db.metricContribution.create({ data: {
      projectionKey: "ANALYTICS_METRIC_CONTRIBUTIONS", projectionVersion: 3, eventId: event.id,
      metricKey, metricVersion: 1, campusId, occurredAt, dimensionKey, value,
    } });
  }
  await fixture(a.id, 2, tag + "-a-recent");
  await fixture(a.id, 19, tag + "-a-older");
  await fixture(b.id, 2, tag + "-b-recent");
  await fixture(a.id, 2, tag + "-a-amount", "19.95");

  const admin = await browser.newContext({ storageState: "tests/e2e/.auth/admin.json" });
  const scoped = await browser.newContext();
  const page = await admin.newPage();
  const restricted = await scoped.newPage();
  const cardTotal = () => page.getByRole("article").filter({ hasText: "新增供给（条）" }).locator("p").nth(1);
  try {
    await page.goto("/governance/analytics?" + new URLSearchParams({ campusId: a.id, days: "7" }).toString());
    await expectHeadingSettled(page, "校园交易分析");
    await expect(cardTotal()).toHaveText("1");
    await expect(page.getByRole("article").filter({ hasText: "完成交易记账对价（元）" }).locator("p").nth(1)).toHaveText("19.95");
    await expect(page.getByRole("region", { name: "暂未提供的指标" })).toContainText("搜索零结果率");

    await page.goto("/governance/analytics?" + new URLSearchParams({ campusId: a.id, days: "30" }).toString());
    await expectHeadingSettled(page, "校园交易分析");
    await expect(cardTotal()).toHaveText("2");

    await page.goto("/governance/analytics?" + new URLSearchParams({ campusId: b.id, days: "7" }).toString());
    await expectHeadingSettled(page, "校园交易分析");
    await expect(cardTotal()).toHaveText("1");
    await expect(page.getByRole("article").filter({ hasText: "完成交易记账对价（元）" }).locator("p").nth(1)).toHaveText("0.00");

    await loginViaUI(restricted, analyst.email, password, analyst.name);
    await restricted.goto("/governance/analytics?" + new URLSearchParams({ campusId: a.id, days: "7" }).toString());
    await expectHeadingSettled(restricted, "校园交易分析");
    await expect(restricted.getByRole("link", { name: "审计日志" })).toHaveCount(0);
    // Next.js streamed notFound may return HTTP 200 after headers flush.
    // Assert the actual denied UI and absence of analytics content instead.
    await restricted.goto("/governance/analytics?" + new URLSearchParams({ campusId: b.id }).toString());
    await expect(restricted.getByRole("heading", { name: "页面不存在" })).toBeVisible();
    await expect(restricted.getByRole("heading", { name: "校园交易分析" })).toHaveCount(0);
    await restricted.goto("/governance/analytics?campusId=" + a.id + "&campusId=" + b.id);
    await expect(restricted.getByRole("heading", { name: "页面不存在" })).toBeVisible();
    await expect(restricted.getByRole("heading", { name: "校园交易分析" })).toHaveCount(0);
  } finally {
    await Promise.all([admin.close(), scoped.close()]);
    // Seed-owned E2E DB reset handles cleanups; do not delete projection history.
  }
});
