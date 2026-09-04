import { test, expect } from "@playwright/test";
import { E2E_ACCOUNTS, storageStatePath, uniqueTag } from "./helpers/e2e";
import { e2eDb, seedActiveDataHold } from "./helpers/db";
import { flushRateLimits } from "./helpers/rate-limit";
import { loginViaUI } from "./helpers/auth";

/**
 * Phase 5 Golden Flows — 隐私请求治理
 * GF-P1 PRIVACY_EXPORT：本人导出含自有数据，不含他人私密字段/内部秘密
 * GF-P2 ACCOUNT_DELETION：显式确认 → 匿名化 → listing 下架 → 无法再登录
 * GF-P3 HOLD_BLOCKS_DELETION：active hold 阻断破坏性步骤，零部分擦除
 */

test("GF-P1 数据导出：仅本人数据 + 必要公共信息，无跨用户泄漏与秘密", async ({ browser }) => {
  const buyer = E2E_ACCOUNTS.buyer;
  const seller = E2E_ACCOUNTS.seller;
  const tag = uniqueTag("gf-p1");

  // fixture：buyer↔seller 订单（导出应含订单参与信息但不得泄漏对方私密字段）
  const buyerUser = await e2eDb().user.findUniqueOrThrow({ where: { email: buyer.email } });
  const sellerUser = await e2eDb().user.findUniqueOrThrow({ where: { email: seller.email } });
  const sellerPhone = `139${String(Date.now()).slice(-8)}`;
  await e2eDb().user.update({
    where: { id: sellerUser.id },
    data: { phone: sellerPhone },
  });
  const order = await e2eDb().order.create({
    data: {
      orderNo: `P1-${tag}`,
      type: "PRODUCT",
      status: "COMPLETED",
      amount: "12.34",
      buyerId: buyerUser.id,
      sellerId: sellerUser.id,
    },
  });

  const context = await browser.newContext({ storageState: storageStatePath("buyer") });
  const page = await context.newPage();

  // 1. 匿名请求导出 → 401
  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  const anonymousResponse = await anonymousPage.request.get("/api/privacy/export");
  expect(anonymousResponse.status()).toBe(401);
  await anonymousContext.close();

  // 2. 登录态导出 → 200 + no-store 响应安全头
  const response = await page.request.get("/api/privacy/export");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");

  const payload = JSON.stringify(await response.json());

  // 3. 自有数据在（账号 + 订单 + 同意历史）
  expect(payload).toContain(buyer.email);
  expect(payload).toContain(`P1-${tag}`);

  // 4. 他人私密字段不在（卖家 email/手机号绝不出现）
  expect(payload).not.toContain(seller.email);
  expect(payload).not.toContain(sellerPhone);

  // 5. 内部秘密/存储内部形态不在
  for (const forbidden of [
    "passwordHash",
    "sessionToken",
    "objectKey",
    "bucket",
    "databaseUrl",
    "redisUrl",
    "NEXTAUTH_SECRET",
  ]) {
    expect(payload.includes(forbidden)).toBe(false);
  }

  await e2eDb().order.delete({ where: { id: order.id } });
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
