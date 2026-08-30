import { mkdirSync } from "node:fs";
import { test as setup } from "@playwright/test";
import { E2E_ACCOUNTS, storageStatePath } from "./helpers/e2e";
import { loginViaUI } from "./helpers/auth";

/**
 * setup 依赖项目：为四个 E2E 角色真实登录一次并落盘 storageState。
 * - 每次运行重新生成（tests/e2e/.auth 已 gitignore）
 * - 登录走真实 /login 表单（这也是对登录链路的一次真实校验）
 * - GF1 里的注册/登录/登出用独立匿名 context 完整覆盖，不依赖这里的 state
 */

const roles = [
  ["buyer", E2E_ACCOUNTS.buyer],
  ["seller", E2E_ACCOUNTS.seller],
  ["admin", E2E_ACCOUNTS.admin],
  ["outsider", E2E_ACCOUNTS.outsider],
] as const;

for (const [role, account] of roles) {
  setup(`登录 ${account.name} 并保存 storageState`, async ({ page }) => {
    mkdirSync("tests/e2e/.auth", { recursive: true });
    await loginViaUI(page, account.email, account.password, account.name);
    await page.context().storageState({ path: storageStatePath(role) });
  });
}
