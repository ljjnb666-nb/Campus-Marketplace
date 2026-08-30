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
  await page.getByRole("button", { name: "登录" }).click();

  // 登录成功后 window.location.href 跳转首页
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
  await expect(page.getByRole("button", { name: expectedName })).toBeVisible();
}

/** 真实 UI 登出：点开用户菜单 → 退出登录 → 回到 /login */
export async function logoutViaUI(page: Page, userName: string): Promise<void> {
  await page.getByRole("button", { name: userName }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 15_000 });
}
