import { test, expect } from "@playwright/test";
import { hashSync } from "bcryptjs";
import { uniqueTag, E2E_ACCOUNTS } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";
import { loginViaUI } from "./helpers/auth";
import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";

/**
 * GOLDEN FLOW — Phase 7D 审计与执法可见性（只读）。
 *
 * 7D-E2E01：PLATFORM_ADMIN → /governance/audit → 行/筛选可用 → metadata
 *           安全（仅 label/value）→ 内部 note/email 不出现 → null campus
 *           显示「无校区归属记录」（绝不「全局操作」）。
 * 7D-E2E02：PLATFORM_ADMIN → /governance/enforcement → 队列因果序（seq DESC）
 *           → target 详情（bounded 因果历史 + 当前 RiskState summary）→
 *           note/sourceId 不出现。
 * 7D-E2E03：CAMPUS_CONTENT_MODERATOR → Audit/Enforcement 导航缺席 → 直连 404。
 * 7D-E2E04：CAMPUS_APPEAL_REVIEWER → 同上（sibling 隔离对两个 campus 角色一致）。
 *
 * 授权矩阵/分页/最小化细节由 tests/integration/phase7d-*.test.ts 覆盖。
 */

const TEST_PASSWORD_PREFIX = process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e";

test("7D-E2E01：审计队列只读可见 + metadata 安全 + null campus 呈现", async ({ browser }) => {
  const tag = uniqueTag("gf-p7d-audit");
  const db = e2eDb();
  const admin = await db.user.findUniqueOrThrow({
    where: { email: E2E_ACCOUNTS.admin.email },
    select: { id: true },
  });

  // fixture：null-campus 审计行（含内部 detail 与安全 metadata）
  await db.adminLog.create({
    data: {
      adminId: admin.id,
      action: `PHASE7D_E2E_${tag}`,
      targetType: "USER",
      targetId: admin.id,
      detail: "SECRET-E2E-7D-INTERNAL-NOTE",
      campusId: null,
      metadata: { reasonCode: "FRAUD_CONFIRMED" },
    },
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUI(page, E2E_ACCOUNTS.admin.email, E2E_ACCOUNTS.admin.password, E2E_ACCOUNTS.admin.name);

  await page.goto("/governance/audit");
  await expect(page.getByRole("heading", { name: "审计日志" })).toBeVisible();

  // governance 导航按 capability 呈现（PLATFORM_ADMIN 五链接齐备）
  const nav = page.getByRole("navigation", { name: "治理控制台" });
  await expect(nav.getByRole("link", { name: "审计日志" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "执法记录" })).toBeVisible();

  // fixture 行可见：action 码 + null campus 呈现「无校区归属记录」
  await page.getByLabel("审计筛选").locator('input[name="action"]').fill(`PHASE7D_E2E_${tag}`);
  await page.getByLabel("审计筛选").getByRole("button", { name: "应用筛选" }).click();
  await expect(page.getByText(`PHASE7D_E2E_${tag}`)).toBeVisible();
  await expect(page.getByText("无校区归属记录")).toBeVisible();
  await expect(page.getByText("全局操作")).toHaveCount(0);

  // metadata 仅以 label/value 结构化条目呈现；内部 detail 绝不出现
  await expect(page.getByText(/原因码：/)).toBeVisible();
  await expect(page.getByText("FRAUD_CONFIRMED")).toBeVisible();
  await expect(page.getByText("SECRET-E2E-7D-INTERNAL-NOTE")).toHaveCount(0);

  await context.close();
});

test("7D-E2E02：执法队列因果序 → 目标详情（历史 + 当前限制状态，note/sourceId 不暴露）", async ({ browser }) => {
  const tag = uniqueTag("gf-p7d-ea");
  const db = e2eDb();
  const admin = await db.user.findUniqueOrThrow({
    where: { email: E2E_ACCOUNTS.admin.email },
    select: { id: true },
  });
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  // fixture：actor + target（ACTIVE membership）+ 两条 EA（seq 由 DB sequence 递增）
  // + createdAt 刻意与 seq 反序 + 一条 RESTRICTED RiskState
  const password = `${TEST_PASSWORD_PREFIX}Target#2026`;
  const target = await db.user.create({
    data: {
      email: `p7d-target-${tag}@e2e.test`,
      name: "P7D执法目标",
      passwordHash: hashSync(password, 10),
      schoolName: campus.schoolName,
      campusId: campus.id,
      role: "STUDENT",
      verificationStatus: "VERIFIED",
    },
  });
  await db.campusMembership.create({
    data: { userId: target.id, campusId: campus.id, status: "ACTIVE" },
  });
  await createTestFixtureAcceptance(db, target.id);

  await db.enforcementAction.create({
    data: {
      type: "ACCOUNT_SUSPEND",
      actorId: admin.id,
      targetId: target.id,
      campusId: null,
      scopeKey: "GLOBAL",
      reasonCode: "FRAUD_CONFIRMED",
      note: "SECRET-E2E-7D-EA-NOTE",
      sourceType: "REPORT",
      sourceId: "SECRET-E2E-7D-SOURCE",
      resultState: "USER:SUSPENDED",
      previousState: "USER:ACTIVE",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  await db.enforcementAction.create({
    data: {
      type: "MARKETPLACE_RESTRICT",
      actorId: admin.id,
      targetId: target.id,
      campusId: null,
      scopeKey: "GLOBAL",
      reasonCode: "POLICY_VIOLATION",
      resultState: "RISK_STATE:RESTRICTED",
      previousState: "RISK_STATE:NORMAL",
      createdAt: new Date("2027-01-01T00:00:00.000Z"),
    },
  });
  await db.riskState.create({
    data: {
      userId: target.id,
      campusId: null,
      scopeKey: "GLOBAL",
      state: "RESTRICTED",
      reasonCode: "FRAUD_CONFIRMED",
      updatedById: admin.id,
    },
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUI(page, E2E_ACCOUNTS.admin.email, E2E_ACCOUNTS.admin.password, E2E_ACCOUNTS.admin.name);

  await page.goto("/governance/enforcement");
  await expect(page.getByRole("heading", { name: "执法记录" })).toBeVisible();

  // targetId 筛选隔离本 fixture
  await page
    .getByLabel("执法记录筛选")
    .locator('input[name="targetId"]')
    .fill(target.id);
  await page.getByLabel("执法记录筛选").getByRole("button", { name: "应用筛选" }).click();

  // 队列两行按 seq DESC（先出现的 seq 更大；seq 以 # 前缀呈现，≥1e9 为 10 位数字）
  const seqTexts = await page.getByText(/#\d{10,}/).allTextContents();
  expect(seqTexts.length).toBe(2);
  const firstSeq = BigInt(seqTexts[0].match(/#(\d{10,})/)![1]);
  const secondSeq = BigInt(seqTexts[1].match(/#(\d{10,})/)![1]);
  expect(firstSeq > secondSeq).toBe(true);

  // note/sourceId 永不出现
  await expect(page.getByText("SECRET-E2E-7D-EA-NOTE")).toHaveCount(0);
  await expect(page.getByText("SECRET-E2E-7D-SOURCE")).toHaveCount(0);

  // 目标详情：anchor → 身份 → bounded 历史 + 当前限制状态
  await page.getByRole("link", { name: "查看目标执法历史" }).first().click();
  await expect(page.getByRole("heading", { name: /目标执法历史：P7D执法目标/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "当前限制状态" })).toBeVisible();
  await expect(page.getByText("受限").first()).toBeVisible();
  await expect(page.getByText("集市限制")).toBeVisible();
  await expect(page.getByText("账号停用")).toBeVisible();
  await expect(page.getByText("SECRET-E2E-7D-EA-NOTE")).toHaveCount(0);
  await expect(page.getByText("SECRET-E2E-7D-SOURCE")).toHaveCount(0);

  await context.close();
});

async function createCampusRoleUser(tag: string, roleKey: string, name: string) {
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey }, select: { id: true } });
  const password = `${TEST_PASSWORD_PREFIX}Role#2026`;
  const user = await db.user.create({
    data: {
      email: `p7d-${roleKey.toLowerCase()}-${tag}@e2e.test`,
      name,
      passwordHash: hashSync(password, 10),
      schoolName: campus.schoolName,
      campusId: campus.id,
      role: "STUDENT",
      verificationStatus: "VERIFIED",
    },
  });
  await db.campusMembership.create({
    data: { userId: user.id, campusId: campus.id, status: "ACTIVE" },
  });
  await createTestFixtureAcceptance(db, user.id);
  await db.userRoleAssignment.create({
    data: { userId: user.id, roleId: role.id, campusId: campus.id, scopeKey: `CAMPUS:${campus.id}` },
  });
  return { email: user.email, password, name };
}

async function expectSiblingIsolation(
  browser: import("@playwright/test").Browser,
  account: { email: string; password: string; name: string },
  landingPath: string,
  landingHeading: string,
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUI(page, account.email, account.password, account.name);

  // 落地到有权限的 sibling（moderator → listings；reviewer → appeals），
  // 导航上绝不出现 Audit/Enforcement 链接
  await page.goto(landingPath);
  await expect(page.getByRole("heading", { name: landingHeading })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "治理控制台" });
  await expect(nav.getByRole("link", { name: "审计日志" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "执法记录" })).toHaveCount(0);

  // 直连 → 页面自守 404
  await page.goto("/governance/audit");
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await page.goto("/governance/enforcement");
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();

  await context.close();
}

test("7D-E2E03：CAMPUS_CONTENT_MODERATOR → Audit/Enforcement 导航缺席 + 直连 404", async ({ browser }) => {
  const account = await createCampusRoleUser(
    uniqueTag("gf-p7d-mod"),
    "CAMPUS_CONTENT_MODERATOR",
    "P7D内容审核员",
  );
  await expectSiblingIsolation(browser, account, "/governance/listings", "列表治理");
});

test("7D-E2E04：CAMPUS_APPEAL_REVIEWER → Audit/Enforcement 导航缺席 + 直连 404", async ({ browser }) => {
  const account = await createCampusRoleUser(
    uniqueTag("gf-p7d-rev"),
    "CAMPUS_APPEAL_REVIEWER",
    "P7D申诉审核员",
  );
  await expectSiblingIsolation(browser, account, "/governance/appeals", "申诉审核");
});
