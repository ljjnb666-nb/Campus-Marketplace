import { test, expect } from "@playwright/test";
import { E2E_ACCOUNTS, storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb, eraseUserFixture, seedActiveDataHold } from "./helpers/db";
import { flushRateLimits } from "./helpers/rate-limit";
import { loginViaUI } from "./helpers/auth";

/**
 * Phase 5 Golden Flows — 隐私请求治理（Phase 9C-03 异步导出语义更新）
 * GF-P1 EXPORT_ENTRY_SECURITY：导出入口安全（匿名 401 / GET 405 无 mutation /
 *   POST 202 恰一条 request + 恰一条 durable job / 重复 409 稳定收敛）
 * GF-P2 ACCOUNT_DELETION：显式确认 → 匿名化 → listing 下架 → 无法再登录
 * GF-P3 HOLD_BLOCKS_DELETION：active hold 阻断破坏性步骤，零部分擦除
 * GF-P4 ASYNC_EXPORT_LIFECYCLE：一次 UI 点击 = 恰好一条 PrivacyRequest
 *   + 恰好一条 DATA_EXPORT_GENERATE job（无孤儿 REQUESTED）
 * GF-P5 STALE_JWT（business mutation + pages）：注销后残留 cookie 全部被拒
 * GF-P6 STALE_JWT（privacy API）：注销后残留 cookie 无法发起导出/创建隐私请求
 */

test("GF-P1 导出入口安全：匿名 401 / GET 405 / POST 202 原子落盘 / 重复 409", async ({ browser }) => {
  const buyer = E2E_ACCOUNTS.buyer;
  const seller = E2E_ACCOUNTS.seller;
  const tag = uniqueTag("gf-p1");

  // fixture：buyer↔seller 订单（后续下载面的数据边界由 9C03-E2E-01 覆盖；
  // 此处只验证入口安全与原子落盘）
  const buyerUser = await e2eDb().user.findUniqueOrThrow({ where: { email: buyer.email } });
  const sellerUser = await e2eDb().user.findUniqueOrThrow({ where: { email: seller.email } });

  const context = await browser.newContext({ storageState: storageStatePath("buyer") });
  const page = await context.newPage();

  // 1. 匿名 POST 发起导出 → 401
  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  const anonymousResponse = await anonymousPage.request.post("/api/privacy/export");
  expect(anonymousResponse.status()).toBe(401);
  await anonymousContext.close();

  // 2. GET /api/privacy/export 已退役：405 方法级拒绝，绝不产生 mutation
  const getResponse = await page.request.get("/api/privacy/export");
  expect(getResponse.status()).toBe(405);
  expect(getResponse.headers()["allow"]).toContain("POST");

  // 3. 登录态 POST → 202 + safe DTO
  const beforeCount = await e2eDb().privacyRequest.count({
    where: { userId: buyerUser.id, type: "DATA_EXPORT" },
  });
  const response = await page.request.post("/api/privacy/export");
  expect(response.status()).toBe(202);
  expect(response.headers()["cache-control"]).toContain("no-store");

  const createBody = await response.json();
  expect(createBody.request).toMatchObject({
    type: "DATA_EXPORT",
    status: "REQUESTED",
  });
  expect(Object.keys(createBody.request).sort()).toEqual(["id", "requestedAt", "status", "type"]);
  // §54：创建响应面绝不含内部定位符
  const createBodyText = JSON.stringify(createBody);
  for (const forbidden of ["objectKey", "bucket", "presignedUrl", "sha256"]) {
    expect(createBodyText.includes(forbidden)).toBe(false);
  }

  // 4. INV-9C03-01：恰一条 request + 恰一条 durable job（原子落盘）
  const requests = await e2eDb().privacyRequest.findMany({
    where: { userId: buyerUser.id, type: "DATA_EXPORT" },
    orderBy: { requestedAt: "desc" },
  });
  expect(requests.length).toBe(beforeCount + 1);
  const request = requests[0]!;
  expect(request.status).toBe("REQUESTED");

  const jobs = await e2eDb().asyncJob.findMany({
    where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
  });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.kind).toBe("DATA_EXPORT_GENERATE");
  expect(jobs[0]!.schemaVersion).toBe(1);
  expect(jobs[0]!.payload).toEqual({ requestId: request.id });

  // 5. §7 并发重复（双击/多 tab/retry）→ 409 DATA_EXPORT_ALREADY_ACTIVE，
  //    绝不产生第二条 request/job
  const duplicate = await page.request.post("/api/privacy/export");
  expect(duplicate.status()).toBe(409);
  expect((await duplicate.json()).code).toBe("DATA_EXPORT_ALREADY_ACTIVE");
  expect(
    await e2eDb().privacyRequest.count({ where: { userId: buyerUser.id, type: "DATA_EXPORT" } }),
  ).toBe(beforeCount + 1);
  expect(
    await e2eDb().asyncJob.count({
      where: { kind: "DATA_EXPORT_GENERATE", payload: { path: ["requestId"], equals: request.id } },
    }),
  ).toBe(1);

  // fixture 清理（导出 artifact 尚未生成——worker 不参与本测试）
  await e2eDb().asyncJob.delete({ where: { id: jobs[0]!.id } });
  await e2eDb().privacyRequest.delete({ where: { id: request.id } });
  void sellerUser;
  void tag;
  await context.close();
});

test("GF-P4 ASYNC_EXPORT_LIFECYCLE：一次 UI 点击 = 恰好一条 request + 恰好一条 durable job", async ({
  browser,
}) => {
  const tag = uniqueTag("gf-p4");
  const email = `${tag}@e2e.test`;
  const nickname = `导出用户${tag.slice(-8)}`;

  await flushRateLimits();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/register");
  await page.locator('input[name="name"]').first().fill(nickname);
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').first().fill("P4Pass#2026");
  await page.locator('input[name="confirmPassword"]').first().fill("P4Pass#2026");
  await page.locator('input[name="agreeLegal"]').first().check();
  await page.getByRole("button", { name: "注册账户" }).click();
  await expect(page.getByText("注册成功，请登录")).toBeVisible();
  await loginViaUI(page, email, "P4Pass#2026", nickname);

  const user = await e2eDb().user.findUniqueOrThrow({ where: { email } });

  // 一次 UI 点击：POST 202 快速返回（HTTP 不执行数据构建，INV-9C03-02）
  await page.goto("/my/privacy");
  await page.getByTestId("export-data-trigger").first().click();

  // UI 显示排队/生成中（异步生命周期状态）
  await expect(
    page.getByTestId("export-status").first(),
  ).toHaveText(/正在排队|正在生成/, { timeout: 15_000 });

  // §58 合同：恰好一条 DATA_EXPORT request + 恰好一条 DATA_EXPORT_GENERATE
  // job（同事务原子落盘；无孤儿 REQUESTED、无重复）
  const requests = await e2eDb().privacyRequest.findMany({
    where: { userId: user.id, type: "DATA_EXPORT" },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.status).toBe("REQUESTED");

  const jobs = await e2eDb().asyncJob.findMany({
    where: { dedupeKey: `DATA_EXPORT_GENERATE:${requests[0]!.id}` },
  });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.kind).toBe("DATA_EXPORT_GENERATE");
  expect(jobs[0]!.payload).toEqual({ requestId: requests[0]!.id });

  // fixture 清理（本测试不 spawn worker，零对象产生）
  await e2eDb().asyncJob.delete({ where: { id: jobs[0]!.id } });
  await e2eDb().privacyRequest.delete({ where: { id: requests[0]!.id } });

  await context.close();
});

test("GF-P5 STALE_JWT（business mutation + pages）：注销后残留 cookie 全部被拒", async ({
  browser,
}) => {
  const tag = uniqueTag("gf-p5");
  const email = `${tag}@e2e.test`;
  const nickname = `残留会话${tag.slice(-8)}`;

  await flushRateLimits();

  const context = await browser.newContext();
  const page = await context.newPage();

  // 1. 真实登录取得 session cookie
  await page.goto("/register");
  await page.locator('input[name="name"]').first().fill(nickname);
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').first().fill("P5Pass#2026");
  await page.locator('input[name="confirmPassword"]').first().fill("P5Pass#2026");
  await page.locator('input[name="agreeLegal"]').first().check();
  await page.getByRole("button", { name: "注册账户" }).click();
  await expect(page.getByText("注册成功，请登录")).toBeVisible();
  await loginViaUI(page, email, "P5Pass#2026", nickname);

  // 2. 账号被注销（fixture seam）——不执行 signOut，旧 JWT 保留在 cookie
  await eraseUserFixture(email);

  // 3. 受保护页面：旧 cookie 被重定向回登录页
  await page.goto("/profile");
  await page.waitForURL((url) => url.pathname === "/login");

  // 4. 业务 mutation API：旧 cookie 得到 401 ACCOUNT_INACTIVE
  const upload = await page.request.post("/api/upload/images", {
    multipart: {
      file: {
        name: "stale.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from([
          0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 1, 1, 0, 0,
          1, 0, 1, 0, 0, 0xff, 0xd9,
        ]),
      },
      category: "product",
    },
  });
  expect(upload.status()).toBe(401);
  expect((await upload.json()).code).toBe("ACCOUNT_INACTIVE");

  // 5. 数据库无新 mutation（没有为该用户创建任何 asset）
  const user = await e2eDb().user.findUniqueOrThrow({ where: { email } });
  const assets = await e2eDb().uploadedAsset.findMany({ where: { ownerId: user.id } });
  expect(assets).toHaveLength(0);

  await context.close();
});

test("GF-P6 STALE_JWT（privacy API）：注销后残留 cookie 无法导出或创建隐私请求", async ({
  browser,
}) => {
  const tag = uniqueTag("gf-p6");
  const email = `${tag}@e2e.test`;
  const nickname = `残留隐私${tag.slice(-8)}`;

  await flushRateLimits();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/register");
  await page.locator('input[name="name"]').first().fill(nickname);
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').first().fill("P6Pass#2026");
  await page.locator('input[name="confirmPassword"]').first().fill("P6Pass#2026");
  await page.locator('input[name="agreeLegal"]').first().check();
  await page.getByRole("button", { name: "注册账户" }).click();
  await expect(page.getByText("注册成功，请登录")).toBeVisible();
  await loginViaUI(page, email, "P6Pass#2026", nickname);

  await eraseUserFixture(email);

  // 导出发起（POST）：401（不允许旧 JWT 创建导出生命周期）
  const exportResponse = await page.request.post("/api/privacy/export");
  expect(exportResponse.status()).toBe(401);

  // 旧 GET 入口：405 方法级（不产生任何 mutation，匿名/无效会话同形）
  const legacyGet = await page.request.get("/api/privacy/export");
  expect(legacyGet.status()).toBe(405);

  // 隐私请求创建：401（不允许旧 JWT 创建/推进任何请求）
  const createResponse = await page.request.post("/api/privacy/requests", {
    data: { type: "DATA_EXPORT" },
  });
  expect(createResponse.status()).toBe(401);

  // 数据库零新请求
  const user = await e2eDb().user.findUniqueOrThrow({ where: { email } });
  const requests = await e2eDb().privacyRequest.findMany({ where: { userId: user.id } });
  expect(requests).toHaveLength(0);

  await context.close();
});

test("GF-P2 账号注销：显式确认 → 匿名化 → listing 下架 → 登录被拒绝", async ({ browser }) => {
  const tag = uniqueTag("gf-p2");
  const email = `${tag}@e2e.test`;
  const nickname = `注销用户${tag.slice(-8)}`;

  await flushRateLimits();

  // 0. 注册并登录（Phase 5：注册含协议同意勾选）
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/register");
  await page.locator('input[name="name"]').first().fill(nickname);
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').first().fill("P2Pass#2026");
  await page.locator('input[name="confirmPassword"]').first().fill("P2Pass#2026");
  await page.locator('input[name="agreeLegal"]').first().check();
  await page.getByRole("button", { name: "注册账户" }).click();
  await expect(page.getByText("注册成功，请登录")).toBeVisible();
  await loginViaUI(page, email, "P2Pass#2026", nickname);

  const user = await e2eDb().user.findUniqueOrThrow({ where: { email } });

  // fixture：一个 ACTIVE 商品（注销时必须退出可交易状态）
  await e2eDb().product.create({
    data: {
      title: `注销测试商品 ${tag}`,
      description: "GF-P2 注销前发布的商品",
      price: "9.90",
      locationText: "E2E 注销测试点",
      condition: "LIKE_NEW",
      status: "ACTIVE",
      sellerId: user.id,
      campusId: user.campusId,
      categoryId: (await e2eDb().productCategory.findFirstOrThrow()).id,
    },
  });

  // 1. 隐私设置页：显式 typed confirmation
  await page.goto("/my/privacy");
  await page.locator('input[name="confirmation"]').first().fill("注销账号");
  await page.getByRole("button", { name: "申请注销账号" }).first().click();
  await expect(page.getByTestId("deletion-result")).toContainText("账号已注销");

  // 2. 会话被登出（signOut 回调）
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });

  // 3. DB 验证：匿名化 + 商品下架 + 历史无物理删除
  const erased = await e2eDb().user.findUniqueOrThrow({ where: { id: user.id } });
  expect(erased.erasedAt).toBeTruthy();
  expect(erased.name).toBe("已注销用户");
  expect(erased.email).toMatch(/^erased-.*@erased\.invalid$/);

  const listing = await e2eDb().product.findFirst({ where: { sellerId: user.id } });
  expect(listing!.status).toBe("OFFLINE");

  // 4. 之后的登录被拒绝
  await page.goto("/login");
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').first().fill("P2Pass#2026");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("邮箱或密码错误")).toBeVisible();

  await context.close();
});

test("GF-P3 active hold 阻断注销：破坏性步骤被阻止，账号数据零部分擦除", async ({ browser }) => {
  const tag = uniqueTag("gf-p3");
  const email = `${tag}@e2e.test`;
  const nickname = `冻结用户${tag.slice(-8)}`;

  await flushRateLimits();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/register");
  await page.locator('input[name="name"]').first().fill(nickname);
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').first().fill("P3Pass#2026");
  await page.locator('input[name="confirmPassword"]').first().fill("P3Pass#2026");
  await page.locator('input[name="agreeLegal"]').first().check();
  await page.getByRole("button", { name: "注册账户" }).click();
  await expect(page.getByText("注册成功，请登录")).toBeVisible();
  await loginViaUI(page, email, "P3Pass#2026", nickname);

  const user = await e2eDb().user.findUniqueOrThrow({ where: { email } });

  // fixture：LEGAL hold（seed/service seam，无生产 debug endpoint）
  await seedActiveDataHold(user.id, "LEGAL");

  // 1. 申请注销 → 被阻止并给出领域原因
  await page.goto("/my/privacy");
  await page.locator('input[name="confirmation"]').first().fill("注销账号");
  await page.getByRole("button", { name: "申请注销账号" }).first().click();
  await expect(page.getByTestId("deletion-result")).toContainText("法律/纠纷冻结");

  // 2. 请求状态 BLOCKED；账号零部分擦除
  const intact = await e2eDb().user.findUniqueOrThrow({ where: { id: user.id } });
  expect(intact.erasedAt).toBeNull();
  expect(intact.name).toBe(nickname);
  expect(intact.email).toBe(email);

  const request = await e2eDb().privacyRequest.findFirst({
    where: { userId: user.id, type: "ACCOUNT_DELETION" },
    orderBy: { requestedAt: "desc" },
  });
  expect(request!.status).toBe("BLOCKED");
  expect(request!.reasonCode).toBe("ACTIVE_DATA_HOLD");

  // 3. 隐私请求历史在设置页可见（BLOCKED 徽标）
  await page.reload();
  await expect(page.getByText("已阻止").first()).toBeVisible();

  await context.close();
});
