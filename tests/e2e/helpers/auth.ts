import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * 真实 UI 登录：走 /login 表单 → NextAuth credentials → JWT session。
 * storageState 由 auth-setup 在测试运行时生成，禁止提交任何 cookie。
 *
 * @param expectedName 登录后顶栏用户菜单按钮应显示的昵称
 */
export async function loginViaUI(
  page: Page,
  email: string,
  password: string,
  expectedName: string,
): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').first().fill(password);
  const loginOrigin = new URL(page.url()).origin;
  let callbackStarted = false;
  let callbackStatus = "none";
  let callbackTransportFailure = false;
  const isCredentialsCallback = (url: string): boolean => {
    try {
      const target = new URL(url);
      return target.origin === loginOrigin && target.pathname === "/api/auth/callback/credentials";
    } catch {
      return false;
    }
  };
  const onRequest = (request: import("@playwright/test").Request) => {
    if (isCredentialsCallback(request.url())) callbackStarted = true;
  };
  const onResponse = (response: import("@playwright/test").Response) => {
    if (!isCredentialsCallback(response.url())) return;
    const status = response.status();
    callbackStatus = status >= 200 && status < 300 ? "2xx"
      : status >= 300 && status < 400 ? "3xx"
      : status >= 400 && status < 500 ? "4xx" : "5xx";
  };
  const onRequestFailed = (request: import("@playwright/test").Request) => {
    if (isCredentialsCallback(request.url())) callbackTransportFailure = true;
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  let loginStage: "submit" | "redirect" = "submit";
  // 登录使用 window.location.href，但 URL 变化不等于全页 load 已结束。
  // 对 URL 做自动重试断言而非等待所有资源加载；成功仍由角色专属菜单证明。
  // 真实认证失败或 URL 不变仍会超时，不提高超时或 Playwright retry。
  // 包含 click() 在内的每个 await 都必须受 finally 保护，以免泄露监听器。
  try {
    await page.getByRole("button", { name: "登录" }).click();
    loginStage = "redirect";
    await expect(page).toHaveURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });
  } catch (error) {
    // Issue #115: only bounded, non-sensitive state classifications on failure.
    // Never log email, password, cookies, URLs, response bodies, or token values.
    const loginPath = (() => {
      try {
        return new URL(page.url()).pathname.startsWith("/login") ? "login" : "other";
      } catch {
        return "unknown";
      }
    })();
    const pending = await page.getByRole("button", { name: "登录中..." })
      .isVisible().catch(() => false);
    const invalidCredentials = await page.getByText("邮箱或密码错误", { exact: true })
      .isVisible().catch(() => false);
    const sessionCookiePresent = await page.context().cookies(page.url())
      .then((cookies) => cookies.some((cookie) =>
        /^(?:__Secure-)?(?:next-auth|authjs)\.session-token(?:\.\d+)?$/.test(cookie.name)))
      .catch(() => false);
    console.error(
      `LOGIN_E2E_DIAG stage=${loginStage} path=${loginPath} pending=${pending ? 1 : 0} invalid_credentials=${invalidCredentials ? 1 : 0} callback_started=${callbackStarted ? 1 : 0} callback_status=${callbackStatus} callback_transport_failed=${callbackTransportFailure ? 1 : 0} session_cookie_present=${sessionCookiePresent ? 1 : 0}`,
    );
    throw error;
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
  }
  await expect(page.getByRole("button", { name: expectedName })).toBeVisible();
}

/** 真实 UI 登出：点开用户菜单 → 退出登录 → 回到 /login */
export async function logoutViaUI(page: Page, userName: string): Promise<void> {
  await page.getByRole("button", { name: userName }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 15_000 });
}
