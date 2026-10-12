import { test, expect } from "@playwright/test";
import { loginViaUI } from "./helpers/auth";
import { E2E_ACCOUNTS, uniqueTag } from "./helpers/e2e";
import { flushRateLimits } from "./helpers/rate-limit";

/**
 * GOLDEN FLOW 1 — 注册 / 登录 / Profile
 * 匿名保护页 → 真实注册 → 登录 → 修改资料 → 刷新持久 → 登出 → 会话消失
 */

test("认证与个人资料：未登录访问受保护页被引导到登录页", async ({ page }) => {
  await page.goto("/profile");
  await page.waitForURL((url) => url.pathname === "/login");

  await page.goto("/products/new");
  await page.waitForURL((url) => url.pathname === "/login");
});

test("认证与个人资料：注册 → 登录 → 修改资料 → 刷新持久 → 登出", async ({ page }) => {
  const tag = uniqueTag("gf1");
  const email = `${tag}@e2e.test`;
  // 昵称上限 20 字符：uniqueTag 较长，这里截取尾部保证唯一且不超限
  const shortTag = tag.slice(-10);
  const nickname = `用户${shortTag}`;
  const updatedNickname = `改名${shortTag}`;
  const bio = `E2E 个人简介 ${tag}`;

  // 注册限流 5 次/小时/IP：多轮连跑时在用例内清一次计数，避免撞线
  await flushRateLimits();

  // 1. 注册（真实表单 → server action → PostgreSQL；页面渲染两份输入框时取第一份）
  // Phase 5：注册必须显式勾选同意当前 required 协议版本（未勾选无法提交）
  await page.goto("/register");
  await page.locator('input[name="name"]').first().fill(nickname);
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').first().fill("Gf1Pass#2026");
  await page.locator('input[name="confirmPassword"]').first().fill("Gf1Pass#2026");
  await page.locator('input[name="agreeLegal"]').first().check();
  await page.getByRole("button", { name: "注册账户" }).click();
  await expect(page.getByText("注册成功，请登录")).toBeVisible();

  // 2. 登录
  await loginViaUI(page, email, "Gf1Pass#2026", nickname);

  // 3. 修改非敏感资料并保存（表单作用域：页面其它区域可能复用相同字段名）
  await page.goto("/profile");
  const profileForm = page.locator("form", { has: page.getByRole("button", { name: "保存资料" }) });
  await profileForm.locator('input[name="name"]').fill(updatedNickname);
  await profileForm.locator('textarea[name="bio"]').fill(bio);
  await profileForm.getByRole("button", { name: "保存资料" }).click();

  // 保存成功（session.update 只刷新客户端会话，顶栏 Server Component 昵称
  // 在下一次整页导航时才更新——因此这里只断言表单值持久化）
  await expect
    .poll(async () => {
      await page.reload();
      return page.locator('form input[name="name"]').first().inputValue();
    })
    .toBe(updatedNickname);
  await expect(page.locator('form textarea[name="bio"]').first()).toHaveValue(bio);

  // 5. 登出 → 登录状态消失（顶栏昵称可能仍是旧名：双尝试）
  const menuButton = page
    .getByRole("button", { name: updatedNickname })
    .or(page.getByRole("button", { name: nickname }))
    .first();
  await menuButton.click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 15_000 });
  await page.goto("/profile");
  await page.waitForURL((url) => url.pathname === "/login");
});

test("认证与个人资料：错误密码登录被拒绝", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').first().fill("e2e-buyer@e2e.test");
  await page.locator('input[name="password"]').first().fill("WrongPassword#1");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("邮箱或密码错误")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("认证与个人资料：登录回调网络失败后提示并允许原表单重试", async ({ page }) => {
  await page.goto("/login");

  const origin = new URL(page.url()).origin;
  const credentialsCallback = (url: URL) =>
    url.origin === origin && url.pathname === "/api/auth/callback/credentials";
  let interruptedCallbacks = 0;
  await page.route(credentialsCallback, async (route) => {
    interruptedCallbacks += 1;
    await route.abort("failed");
  });

  // Use a pre-seeded E2E-only identity. The interception is page-local,
  // so no other worker or auth-setup request is affected.
  await page.locator('input[name="email"]').first().fill(E2E_ACCOUNTS.buyer.email);
  await page.locator('input[name="password"]').first().fill(E2E_ACCOUNTS.buyer.password);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByText("登录暂时不可用，请稍后重试", { exact: true }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "登录" })).toBeEnabled();
  await expect(page).toHaveURL((url) => url.pathname === "/login");
  expect(interruptedCallbacks).toBe(1);

  // Stop fault injection, then retry on the very same form. This is a real
  // credentials -> JWT cookie -> authenticated UI round trip.
  await page.unroute(credentialsCallback);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: E2E_ACCOUNTS.buyer.name }))
    .toBeVisible();
});

test("认证与个人资料：凭据回调等待期间保持提交态，响应后登录成功", async ({ page }) => {
  await page.goto("/login");

  const origin = new URL(page.url()).origin;
  const credentialsCallback = (url: URL) =>
    url.origin === origin && url.pathname === "/api/auth/callback/credentials";

  // Gate only the current page's credentials callback. No timer, global
  // network interception, shared user mutation, or altered login timeout.
  let releaseCallback: (() => void) | undefined;
  const callbackGate = new Promise<void>((resolve) => {
    releaseCallback = resolve;
  });
  let interceptedCallbacks = 0;
  let markContinuationSettled: (() => void) | undefined;
  const continuationSettled = new Promise<void>((resolve) => {
    markContinuationSettled = resolve;
  });
  const gateRequest = async (route: import("@playwright/test").Route) => {
    interceptedCallbacks += 1;
    try {
      await callbackGate;
      await route.continue();
    } finally {
      markContinuationSettled?.();
    }
  };
  await page.route(credentialsCallback, gateRequest);

  try {
    await page.locator('input[name="email"]').first().fill(E2E_ACCOUNTS.buyer.email);
    await page.locator('input[name="password"]').first().fill(E2E_ACCOUNTS.buyer.password);
    await page.getByRole("button", { name: "登录" }).click();

    // Assert an actual in-flight callback before checking pending UI. If this
    // fails, finally still releases the gated request.
    await expect.poll(() => interceptedCallbacks).toBe(1);
    await expect(page.getByRole("button", { name: "登录中..." })).toBeDisabled();
    await expect(page).toHaveURL((url) => url.pathname === "/login");
  } finally {
    // Do not unroute a still-pending Route: Playwright may auto-handle it,
    // making route.continue() fail with "Route is already handled".
    releaseCallback?.();
    if (interceptedCallbacks > 0) {
      await continuationSettled;
    }
    await page.unroute(credentialsCallback, gateRequest);
  }

  // The original request resumes: real credentials, session cookie, and the
  // authenticated navigation/UI must complete without a second submission.
  await expect(page).toHaveURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: E2E_ACCOUNTS.buyer.name }))
    .toBeVisible();
});
