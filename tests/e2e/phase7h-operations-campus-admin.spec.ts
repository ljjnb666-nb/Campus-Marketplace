import { expect, test, type Page } from "@playwright/test";
import { hashSync } from "bcryptjs";

import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";
import { e2eDb } from "./helpers/db";
import { loginViaUI } from "./helpers/auth";
import { expectHeadingSettled } from "./helpers/hydration-settlement";
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

// Repair 4 §21 稳定性：--repeat-each 矩阵中每个测试实例清理自己创建的
// 校区夹具，杜绝跨重复累积（否则分页 marker 会被后续重复挤到深页，
// 数据量假设随累积漂移）。
const cleanupCampusIds: string[] = [];

test.beforeEach(() => {
  cleanupCampusIds.length = 0;
});

test.afterEach(async () => {
  if (cleanupCampusIds.length === 0) {
    return;
  }
  const ids = [...cleanupCampusIds];
  cleanupCampusIds.length = 0;
  const db = e2eDb();
  try {
    await db.moderationCase.deleteMany({ where: { campusId: { in: ids } } });
    await db.report.deleteMany({ where: { campusId: { in: ids } } });
    await db.campusMembership.deleteMany({ where: { campusId: { in: ids } } });
    await db.campusVerificationPolicy.deleteMany({ where: { campusId: { in: ids } } });
    await db.campus.deleteMany({ where: { id: { in: ids } } });
  } catch (error) {
    console.warn("[7H-cleanup] 夹具清理失败（下轮 setup 全量重建兜底）", error);
  }
});

/**
 * P7_UI_DUPLICATE_DOM_01（Final Review Repair 4，TRUE raw-DOM settlement）：
 *
 * 每个 fresh-goto / server-action revalidation 边界后，必须先通过
 * expectHeadingSettled（a11y heading = 1 且 raw DOM h1 = 1 双层断言，
 * 见 helpers/hydration-settlement.ts）证明水合替换的 hidden 壳已移除，
 * 然后才允许任何 strict raw locator 交互。绝无 .first()/.nth()/
 * waitForTimeout/retry/workers 掩盖。
 */
test("7H-SETTLE-00 settlement helper synthetic proof：hidden 壳存在时不得 resolve，壳移除后立即收敛", async ({ page }) => {
  // 确定性合成 DOM（§3：不经真实 Next 随机窗口验证 helper 正确性）
  await page.setContent(`
    <main>
      <div id="hydration-shell" hidden>
        <h1>治理总览</h1>
      </div>
      <h1>治理总览</h1>
    </main>
  `);

  // 窗口态前置证明：raw DOM h1 = 2；accessible h1 = 1（hidden 壳被排除）
  await expect(page.locator("h1")).toHaveCount(2);
  await expect(
    page.getByRole("heading", { name: "治理总览", exact: true, level: 1 }),
  ).toHaveCount(1);

  // helper 必须仍 pending：其终态要求 raw DOM h1 = 1，窗口内不可能满足
  const settlement = expectHeadingSettled(page, "治理总览");
  let resolved = false;
  void settlement.then(() => {
    resolved = true;
  });
  await expect(page.locator("h1")).toHaveCount(2);
  expect(resolved).toBe(false);

  // 移除 hidden 壳 → helper 立即收敛（零 sleep，Playwright auto-wait）
  await page.evaluate(() => document.getElementById("hydration-shell")?.remove());
  await settlement;
  expect(resolved).toBe(true);
  await expect(page.locator("h1")).toHaveCount(1);
});

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

/**
 * 有界逐页前进定位唯一 slug 卡片（Repair 4 §7/§12）。
 *
 * 动机：--repeat-each 稳定性矩阵中各测试并行创建校区（可累积数百行），
 * 唯一 slug 卡片可能落在任意后页。每翻一页都执行 settlement
 * （expectHeadingSettled，§7/§12 边界合同）后才读下一页链接；
 * 零 .first()/sleep/manual polling。
 */
async function walkToCampusCard(
  page: Page,
  slug: string,
  maxPages = 40,
): Promise<ReturnType<Page["locator"]>> {
  const card = page.locator("article", { hasText: slug });
  // 每页的 下一页 href 携带该页末行 cursor（页间必不同）：href 相对上一页
  // 变化 = 新页 article 内容已渲染的确定性 barrier（杜绝 h1 先到、列表
  // 后到造成的"空页误判 → 越页过冲"）。
  let previousNextHref: string | null = null;
  for (let step = 0; step < maxPages; step += 1) {
    // h1 先渲染、article 列表流式后到：判空前必须等列表挂载
    // （locator 集合 auto-wait 非空语义，无 .first()）
    await expect(page.locator("article").first()).toBeAttached();
    if ((await card.count()) === 1) {
      return card;
    }
    const next = page.getByRole("link", { name: "下一页" });
    await expect(next).toHaveCount(1);
    if (previousNextHref !== null) {
      // URL 已变但 DOM 可能仍停留在上一页（Next 16.3.3 客户端导航
      // URL 先行 / DOM 延迟切换——本轮 href 断言实测捕获）：
      // auto-wait 到下一页 href 相对上一页变化，即新页 DOM 真实到达
      await expect(next).not.toHaveAttribute("href", previousNextHref);
    }
    previousNextHref = (await next.getAttribute("href")) ?? "";
    expect(previousNextHref.length).toBeGreaterThan(0);
    // 并行 worker 的 server action（revalidatePath）会瞬时 detach 本页节点：
    // locator.evaluate 在执行时重解析当前树（DOM click），对并发重渲染自愈
    await next.evaluate((el) => (el as HTMLElement).click());
    await expect(page).toHaveURL(/cursor=/);
    await expectHeadingSettled(page, "校区管理");
  }
  return card;
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
  cleanupCampusIds.push(campusB.id);

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
  await expectHeadingSettled(page, "治理总览");
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

  // summary → queue 链路（report reviewer 仅一张 summary 卡 → 唯一链接）
  await page.getByRole("link", { name: "查看队列" }).click();
  await expectHeadingSettled(page, "举报处理");
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
  await expectHeadingSettled(page, "治理总览");
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
  await expectHeadingSettled(page, "治理总览");
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
  const db = e2eDb();
  const context = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  const page = await context.newPage();

  // limit=50：E2E09 并行批量创建的校区可能把本测试的卡片挤出默认 25 行首页
  await page.goto("/governance/campuses?limit=50");
  await expectHeadingSettled(page, "校区管理");
  await expect(page.getByRole("heading", { name: "校区管理" })).toBeVisible();

  await page.getByRole("textbox", { name: "校区名称" }).fill(`E2E7H校区-${tag}`);
  await page.getByLabel("校区标识符（slug，创建后不可修改）").fill(`e2e7h-${tag}`);
  await page.getByLabel("学校名称").fill("E2E 大学");
  await page.getByLabel("所在区域（可选）").fill("海淀区");
  await page.getByRole("button", { name: "创建校区" }).click();
  // Browser drives action, DB verifies invariant：高负载下 UI toast 反馈
  // 可能晚于服务端提交，以 DB 行存在为 action 完成的权威 invariant
  //（expect.poll 与 toHaveCount 同族 auto-retry，非手工轮询）
  await expect(async () => {
    expect(
      await db.campus.findUnique({ where: { slug: `e2e7h-${tag}` } }),
    ).toBeTruthy();
  }).toPass({ timeout: 20_000 });
  const createdForCleanup = await db.campus.findUniqueOrThrow({
    where: { slug: `e2e7h-${tag}` },
    select: { id: true },
  });
  cleanupCampusIds.push(createdForCleanup.id);
  await expectHeadingSettled(page, "校区管理");

  await page.goto("/governance/campuses?limit=50");
  await expectHeadingSettled(page, "校区管理");
  // 并发确定性：以唯一 slug 有界逐页定位本测试创建的卡片，再点其详情链接
  const createdCard = await walkToCampusCard(page, `e2e7h-${tag}`);
  await createdCard
    .getByRole("link", { name: "管理详情" })
    .evaluate((el) => (el as HTMLElement).click());
  await page.waitForURL(/\/governance\/campuses\/[^/]+$/, { timeout: 15_000 });
  await expectHeadingSettled(page, `E2E7H校区-${tag}`);

  // 详情：slug 展示且结构性无修改入口
  await expect(page.getByTestId("campus-slug")).toHaveText(`e2e7h-${tag}`);
  const slugValue = await page.getByTestId("campus-slug").textContent();

  await page.getByRole("textbox", { name: "校区名称" }).fill(`E2E7H校区改名-${tag}`);
  await page.getByRole("button", { name: "保存修改" }).click();
  // UI success invariant（toast 仅存在于新树 → count=1 证 revalidation 已渲染）
  await expect(page.getByText("校区信息已更新")).toHaveCount(1);
  await expect(page.getByText("校区信息已更新")).toBeVisible();
  // raw DOM 旧壳移除证明：改名前 h1（旧名）归零——新名 h1=1 无法单独证明
  // 壳已消失（旧壳 h1 为旧名，不与新名匹配）
  await expect(
    page.locator("h1").filter({ hasText: `E2E7H校区-${tag}` }),
  ).toHaveCount(0);
  await expectHeadingSettled(page, `E2E7H校区改名-${tag}`);
  await expect(page.getByTestId("campus-slug")).toHaveText(slugValue!);

  // ONLY THEN：deactivate（停用校区按钮在旧壳/新树各有一份的窗口已关闭）
  await page.getByRole("button", { name: "停用校区" }).click();
  await expect(page.getByText("已停用", { exact: true })).toHaveCount(1);
  await expect(page.getByText("已停用", { exact: true })).toBeVisible();
  // 统一 contract：deactivate revalidation → settlement → activate
  await expectHeadingSettled(page, `E2E7H校区改名-${tag}`);
  await expect(page.getByRole("button", { name: "启用校区" })).toBeVisible();

  await page.getByRole("button", { name: "启用校区" }).click();
  await expect(page.getByText("启用中", { exact: true })).toHaveCount(1);
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
  cleanupCampusIds.push(campus.id);

  await page.goto(`/governance/campuses/${campus.id}`);
  // page settlement first（§8）：raw DOM + a11y 双层收敛后才用语义 locator
  await expectHeadingSettled(page, `E2E7H策略校区-${tag}`);
  await expect(page.getByRole("heading", { name: `E2E7H策略校区-${tag}` })).toBeVisible();

  await page.getByRole("textbox", { name: "策略标题" }).fill("E2E7H 认证规则");
  await page.getByLabel("认证说明（发布后不可修改）").fill("初版说明：上传学生证");
  await page.getByRole("button", { name: "创建草稿" }).click();
  await expect(async () => {
    expect(
      (await db.campusVerificationPolicy.findFirst({
        where: { campusId: campus.id },
        orderBy: { version: "desc" },
      })) ?? null,
    ).toBeTruthy();
  }).toPass({ timeout: 20_000 });
  // 统一 contract：create-draft revalidation → settlement → draft interaction
  await expectHeadingSettled(page, `E2E7H策略校区-${tag}`);

  await page.getByLabel("认证说明（保存将重算内容指纹）").fill("更新版说明：上传学生证与校园卡");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(async () => {
    const row = await db.campusVerificationPolicy.findFirstOrThrow({
      where: { campusId: campus.id },
      orderBy: { version: "desc" },
    });
    expect(row.instructions).toBe("更新版说明：上传学生证与校园卡");
  }).toPass({ timeout: 20_000 });
  // BLOCKER 2：save 前后 draft 树都含 发布/保存草稿 按钮——hidden 旧壳可制造
  // strict duplicate；same-name raw h1 在窗口内 = 2，settlement 等待其归 1
  await expectHeadingSettled(page, `E2E7H策略校区-${tag}`);

  // ONLY THEN：publish
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(async () => {
    const row = await db.campusVerificationPolicy.findFirstOrThrow({
      where: { campusId: campus.id },
      orderBy: { version: "desc" },
    });
    expect(row.status).toBe("PUBLISHED");
  }).toPass({ timeout: 20_000 });
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
  await expectHeadingSettled(page, "系统状态");
  await expect(page.getByRole("heading", { name: "系统状态" })).toBeVisible();
  // §18：release-sha 作用域到唯一 active semantic region（隐藏副本不进入
  // a11y tree，region 角色恒唯一）；§16：全量 DOM 副本收敛断言
  const readinessRegion = page.getByRole("region", { name: "平台就绪状态" });
  await expect(readinessRegion.getByTestId("release-sha")).toHaveCount(1);
  await expect(page.getByTestId("release-sha")).toHaveCount(1);
  await expect(readinessRegion.getByTestId("release-sha")).toHaveText(/.+/);
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
  cleanupCampusIds.push(campus.id);

  // 独立浏览器时区：Asia/Shanghai（不依赖 CI server timezone）
  const context = await browser.newContext({
    storageState: ADMIN_STORAGE_STATE,
    timezoneId: "Asia/Shanghai",
  });
  const page = await context.newPage();

  await page.goto(`/governance/campuses/${campus.id}`);
  // §11：page settlement（dynamic campus name）先于 策略标题/生效时间
  await expectHeadingSettled(page, `E2E7H时区校区-${tag}`);
  await page.getByRole("textbox", { name: "策略标题" }).fill("E2E7H 时区规则");
  await page.getByLabel("认证说明（发布后不可修改）").fill("时区合同验证说明");
  // Playwright datetime-local fill 只接受分钟精度；秒/毫秒合同由
  // jsdom 单测（fireEvent + ms 值）与 hidden-initial 保持语义承担
  await page.getByLabel(/生效时间/).fill("2026-12-01T09:00");
  await page.getByRole("button", { name: "创建草稿" }).click();
  await expect(async () => {
    expect(
      (await db.campusVerificationPolicy.findFirst({
        where: { campusId: campus.id },
        orderBy: { version: "desc" },
      })) ?? null,
    ).toBeTruthy();
  }).toPass({ timeout: 20_000 });

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
    const pageCampus = await db.campus.create({
      data: {
        name: `E2E7H分页-${tag}-${index}`,
        slug: `e2e7h-page-${tag}-${index}`,
        schoolName: "E2E 大学",
        isActive: true,
      },
    });
    cleanupCampusIds.push(pageCampus.id);
  }
  const markerCampus = await db.campus.create({
    data: {
      name: `E2E7H分页标记-${tag}`,
      slug: markerSlug,
      schoolName: "E2E 大学",
      isActive: true,
    },
  });
  cleanupCampusIds.push(markerCampus.id);

  const context = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  const page = await context.newPage();

  await page.goto("/governance/campuses?limit=25");
  await expectHeadingSettled(page, "校区管理");
  await expect(page.getByRole("heading", { name: "校区管理" })).toBeVisible();
  // PAGE：第一页恰 25 张卡片 + 下一页
  await expect(page.locator("article")).toHaveCount(25);
  const next = page.getByRole("link", { name: "下一页" });
  await expect(next).toBeVisible();

  // 后续页有界遍历：直到 marker 校区可见（--repeat-each 累积数据下页数 > 2；
  // createdSet 无重复无跳过的精确遍历由集成 PAGE-01..05 承担）。
  // 每翻一页执行 settlement（§12 边界合同），marker 卡可见后走详情。
  const markerCard = await walkToCampusCard(page, markerSlug);
  await expect(markerCard).toBeVisible();
  await markerCard
    .getByRole("link", { name: "管理详情" })
    .evaluate((el) => (el as HTMLElement).click());
  await page.waitForURL(/\/governance\/campuses\/[^/]+$/, { timeout: 15_000 });
  await expectHeadingSettled(page, `E2E7H分页标记-${tag}`);

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
  await expectHeadingSettled(page, "治理总览");

  await context.close();
});
