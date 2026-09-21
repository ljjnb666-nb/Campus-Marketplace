import { expect, test, type Page } from "@playwright/test";
import { hashSync } from "bcryptjs";

import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";
import { e2eDb } from "./helpers/db";
import { loginViaUI } from "./helpers/auth";
import { uniqueTag } from "./helpers/e2e";

/**
 * Phase 7H Operations Overview & Campus Administration E2E（golden flows，retry=0）。
 *
 * 原则：Browser drives action, DB verifies invariant。治理会话 = 运行时
 * provision（7F/7G 同款）；PLATFORM_ADMIN 会话 = e2e-setup 预置 admin
 * storageState（ensureRbacFoundation 自然获得 operations.overview）。
 *
 * 覆盖：
 *  - 7H-E2E01：campus report reviewer → /governance 仅见授权队列 summary 与
 *    导航；跨校区计数缺失（anti-oracle）
 *  - 7H-E2E02：multi-capability reviewer → 授权卡片并集；未授权 sibling 缺席
 *  - 7H-E2E03：PLATFORM_ADMIN → /governance → 校区管理 + 系统状态链接可见
 *  - 7H-E2E04：campus create → metadata update → slug 不可变 → deactivate →
 *    activate（UI 全链）
 *  - 7H-E2E05：认证策略 create draft → update → publish → current 可见 →
 *    published 编辑拒绝（发布即不可变）
 *  - 7H-E2E06：/governance/system → release + 安全依赖状态 → 无 secret 形态内容
 *  - 7H-E2E07：/admin → redirect /governance
 */

test.describe.configure({ retries: 0 });

const TEST_PASSWORD_PREFIX = process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e";
const ADMIN_STORAGE_STATE = "tests/e2e/.auth/admin.json";

async function createE2EUser(input: {
  name: string;
  email: string;
  campusId?: string;
}) {
  const db = e2eDb();
  const password = `${TEST_PASSWORD_PREFIX}User#2026`;
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

async function loginNewContext(
  browser: import("@playwright/test").Browser,
  email: string,
  password: string,
  name: string,
): Promise<{ context: import("@playwright/test").BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUI(page, email, password, name);
  return { context, page };
}

test("7H-E2E01 campus report reviewer → /governance 仅见授权 summary；跨校区计数缺席", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p7h-01");
  const db = e2eDb();
  const campusA = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const campusB = await db.campus.create({
    data: {
      name: `E2E7H-B-${tag}`,
      slug: `e2e7h-b-${tag}`,
      schoolName: "E2E 大学",
      isActive: true,
    },
  });

  const reporter = await createE2EUser({
    name: `7H报告员-${tag}`,
    email: `p7h-reporter-${tag}@e2e.test`,
    campusId: campusA.id,
  });
  const reportB = await db.report.create({
    data: {
      reporterId: reporter.user.id,
      targetType: "USER",
      reason: "FAKE_INFO",
      detail: "E2E7H campus B 举报",
      status: "OPEN",
      campusId: campusB.id,
      scopeKey: `CAMPUS:${campusB.id}`,
      targetUserId: reporter.user.id,
    },
  });
  await db.moderationCase.create({
    data: {
      reportId: reportB.id,
      campusId: campusB.id,
      scopeKey: `CAMPUS:${campusB.id}`,
      openedAt: new Date(),
      dueAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      lastActivityAt: new Date(),
    },
  });

  // 并发确定性：reviewer 与 case 均落在专属 campusB（并行 spec 不会触碰），
  // dashboard 计数恰为 1——若 scope 泄漏到 main-campus 或跨校区则为更大值
  await db.campusMembership.create({
    data: { userId: reporter.user.id, campusId: campusB.id, status: "ACTIVE" },
  });
  await assignRole(reporter.user.id, "CAMPUS_REPORT_REVIEWER", campusB.id);
  const { context, page } = await loginNewContext(
    browser,
    reporter.user.email,
    `${TEST_PASSWORD_PREFIX}User#2026`,
    `7H报告员-${tag}`,
  );

  await page.goto("/governance");
  // 落地页可见：举报处理 summary 卡片（专属 campusB 恰 1）
  await expect(page.getByRole("heading", { name: "治理总览" })).toBeVisible();
  const reportCard = page.getByRole("heading", { name: "举报处理" });
  await expect(reportCard).toBeVisible();
  // 跨校区计数缺席：activeCount 恰 1（scope 泄漏到 main-campus 则显著大于 1）
  const activeCount = page.getByText("待办总数").locator("xpath=preceding-sibling::p[1]");
  await expect(activeCount).toHaveText("1");
  // 导航仅授权 sibling
  await expect(page.getByRole("link", { name: "举报处理" })).toBeVisible();
  await expect(page.getByRole("link", { name: "支持工单" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "系统状态" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "校区管理" })).toHaveCount(0);

  // summary → queue 链路
  await page.getByRole("link", { name: "查看队列" }).first().click();
  await expect(page.getByRole("heading", { name: "举报处理", level: 1 })).toBeVisible();

  await context.close();
  await db.campus.delete({ where: { id: campusB.id } }).catch(() => undefined);
});

test("7H-E2E02 multi-capability reviewer → 授权卡片并集；未授权 sibling 缺席", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p7h-02");
  const db = e2eDb();
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });

  const multi = await createE2EUser({
    name: `7H多面手-${tag}`,
    email: `p7h-multi-${tag}@e2e.test`,
    campusId: campus.id,
  });
  await assignRole(multi.user.id, "CAMPUS_REPORT_REVIEWER", campus.id);
  await assignRole(multi.user.id, "CAMPUS_SUPPORT_AGENT", campus.id);

  const { context, page } = await loginNewContext(
    browser,
    multi.user.email,
    `${TEST_PASSWORD_PREFIX}User#2026`,
    `7H多面手-${tag}`,
  );

  await page.goto("/governance");
  await expect(page.getByRole("heading", { name: "治理总览" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "举报处理" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "支持工单" })).toBeVisible();
  // 未授权域：零卡片、零快捷入口
  await expect(page.getByRole("heading", { name: "纠纷处理" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "用户管理" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "审计日志" })).toHaveCount(0);

  await context.close();
});

test("7H-E2E03 PLATFORM_ADMIN → /governance → 校区管理 + 系统状态链接可见", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  const page = await context.newPage();

  await page.goto("/governance");
  await expect(page.getByRole("heading", { name: "治理总览" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "治理控制台" });
  await expect(nav.getByRole("link", { name: "总览" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "校区管理" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "系统状态" })).toBeVisible();
  // queue summary 快捷入口（PLATFORM_ADMIN 全 capability）
  await expect(nav.getByRole("link", { name: "用户管理" })).toBeVisible();

  await context.close();
});

test("7H-E2E04 campus create → metadata update → slug 不可变 → deactivate → activate", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p7h-04");
  const context = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  const page = await context.newPage();

  // limit=50：E2E09 并行批量创建的校区可能把本测试的卡片挤出默认 25 行首页
  await page.goto("/governance/campuses?limit=50");
  await expect(page.getByRole("heading", { name: "校区管理" })).toBeVisible();

  await page.getByLabel("校区名称").fill(`E2E7H校区-${tag}`);
  await page.getByLabel("校区标识符（slug，创建后不可修改）").fill(`e2e7h-${tag}`);
  await page.getByLabel("学校名称").fill("E2E 大学");
  await page.getByLabel("所在区域（可选）").fill("海淀区");
  await page.getByRole("button", { name: "创建校区" }).click();
  await expect(page.getByText(`校区已创建：E2E7H校区-${tag}`)).toBeVisible();

  await page.goto("/governance/campuses?limit=50");
  // 并发确定性：以唯一 slug 定位本测试创建的卡片，再点其详情链接
  const createdCard = page.locator("article", { hasText: `e2e7h-${tag}` });
  await createdCard.getByRole("link", { name: "管理详情" }).click();

  // 详情：slug 展示且结构性无修改入口
  await expect(page.getByTestId("campus-slug")).toHaveText(`e2e7h-${tag}`);
  const slugValue = await page.getByTestId("campus-slug").textContent();

  await page.getByLabel("校区名称").fill(`E2E7H校区改名-${tag}`);
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("校区信息已更新")).toBeVisible();
  await expect(page.getByTestId("campus-slug")).toHaveText(slugValue!);

  await page.getByRole("button", { name: "停用校区" }).click();
  await expect(page.getByText("已停用", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "启用校区" })).toBeVisible();

  await page.getByRole("button", { name: "启用校区" }).click();
  await expect(page.getByText("启用中", { exact: true })).toBeVisible();

  await context.close();
});

test("7H-E2E05 认证策略 draft → update → publish → current 可见 → published 编辑拒绝", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p7h-05");
  const db = e2eDb();
  const context = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  const page = await context.newPage();
  const campus = await db.campus.create({
    data: {
      name: `E2E7H策略校区-${tag}`,
      slug: `e2e7h-policy-${tag}`,
      schoolName: "E2E 大学",
      isActive: true,
    },
  });

  await page.goto(`/governance/campuses/${campus.id}`);
  await expect(page.getByRole("heading", { name: `E2E7H策略校区-${tag}` })).toBeVisible();

  await page.getByLabel("策略标题").fill("E2E7H 认证规则");
  await page.getByLabel("认证说明（发布后不可修改）").fill("初版说明：上传学生证");
  await page.getByRole("button", { name: "创建草稿" }).click();
  await expect(page.getByText("认证策略草稿 v1 已创建")).toBeVisible();

  await page.getByLabel("认证说明（保存将重算内容指纹）").fill("更新版说明：上传学生证与校园卡");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText("草稿已更新")).toBeVisible();

  await page.getByRole("button", { name: "发布", exact: true }).click();
  // 成功反馈随 revalidate 卸载（草稿表单被已发布视图替换）——断言终态而非瞬态 toast：
  // current 语义可见：已发布徽标 + 不可修改提示 + 无草稿编辑表单
  await expect(page.getByText("已发布", { exact: true })).toBeVisible();
  await expect(page.getByText("已发布策略内容不可修改（发布即不可变）")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存草稿" })).toHaveCount(0);

  await context.close();
});

test("7H-E2E06 /governance/system → release + 安全依赖状态 → 无 secret 形态内容", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  const page = await context.newPage();

  await page.goto("/governance/system");
  await expect(page.getByRole("heading", { name: "系统状态" })).toBeVisible();
  await expect(page.getByTestId("release-sha")).toHaveText(/.+/);
  await expect(page.getByText("数据库")).toBeVisible();
  await expect(page.getByText("Redis")).toBeVisible();
  await expect(page.getByText("对象存储")).toBeVisible();
  await expect(page.getByText("就绪").or(page.getByText("降级")).or(page.getByText("未就绪")).first()).toBeVisible();

  const body = await page.locator("body").textContent();
  expect(body).not.toContain("postgres://");
  expect(body).not.toContain("redis://");
  expect(body).not.toContain("METRICS_BEARER_TOKEN");
  expect(body).not.toContain("NEXTAUTH_SECRET");
  expect(body).not.toContain("Error:");

  await context.close();
});

test("7H-E2E08 浏览器时区 Asia/Shanghai：本地 09:00 → DB 绝对 instant 01:00Z（零 timezone drift）", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p7h-08");
  const db = e2eDb();
  const campus = await db.campus.create({
    data: {
      name: `E2E7H时区校区-${tag}`,
      slug: `e2e7h-tz-${tag}`,
      schoolName: "E2E 大学",
      isActive: true,
    },
  });

  // 独立浏览器时区：Asia/Shanghai（不依赖 CI server timezone）
  const context = await browser.newContext({
    storageState: ADMIN_STORAGE_STATE,
    timezoneId: "Asia/Shanghai",
  });
  const page = await context.newPage();

  await page.goto(`/governance/campuses/${campus.id}`);
  await page.getByLabel("策略标题").fill("E2E7H 时区规则");
  await page.getByLabel("认证说明（发布后不可修改）").fill("时区合同验证说明");
  // Playwright datetime-local fill 只接受分钟精度；秒/毫秒合同由
  // jsdom 单测（fireEvent + ms 值）与 hidden-initial 保持语义承担
  await page.getByLabel(/生效时间/).fill("2026-12-01T09:00");
  await page.getByRole("button", { name: "创建草稿" }).click();
  await expect(page.getByText("认证策略草稿 v1 已创建")).toBeVisible();

  const policy = await db.campusVerificationPolicy.findFirstOrThrow({
    where: { campusId: campus.id },
    orderBy: { version: "desc" },
  });
  // Asia/Shanghai 的 09:00 本地 == UTC 01:00（同一绝对 instant）
  expect(policy.effectiveAt.toISOString()).toBe("2026-12-01T01:00:00.000Z");

  await context.close();
});

test("7H-E2E09 campus 列表分页：26+ campuses → 下一页 → 后续校区详情可达", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag("p7h-09");
  const db = e2eDb();
  const markerSlug = `e2e7h-page-marker-${tag}`;

  // 直接 fixture 建 30 个校区（无需 UI 点击 30 次）
  for (let index = 0; index < 30; index += 1) {
    await db.campus.create({
      data: {
        name: `E2E7H分页-${tag}-${index}`,
        slug: `e2e7h-page-${tag}-${index}`,
        schoolName: "E2E 大学",
        isActive: true,
      },
    });
  }
  await db.campus.create({
    data: {
      name: `E2E7H分页标记-${tag}`,
      slug: markerSlug,
      schoolName: "E2E 大学",
      isActive: true,
    },
  });

  const context = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  const page = await context.newPage();

  await page.goto("/governance/campuses?limit=25");
  await expect(page.getByRole("heading", { name: "校区管理" })).toBeVisible();
  // PAGE：第一页恰 25 张卡片 + 下一页
  await expect(page.locator("article")).toHaveCount(25);
  const next = page.getByRole("link", { name: "下一页" });
  await expect(next).toBeVisible();

  // 第二页：包含本测试的标记校区（createdSet 无重复无跳过的精确遍历由集成 PAGE-01..05 承担）
  await next.click();
  await expect(page).toHaveURL(/cursor=/);
  const markerCard = page.locator("article", { hasText: markerSlug });
  await expect(markerCard).toBeVisible();
  await markerCard.getByRole("link", { name: "管理详情" }).click();

  await expect(page.getByTestId("campus-slug")).toHaveText(markerSlug);

  await context.close();
});

test("7H-E2E07 /admin → redirects to /governance", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  const page = await context.newPage();

  await page.goto("/admin");
  await page.waitForURL((url) => url.pathname === "/governance", { timeout: 15_000 });
  await expect(page).toHaveURL(/\/governance$/);

  await context.close();
});
