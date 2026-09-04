import { test, expect } from "@playwright/test";
import { E2E_ACCOUNTS, uniqueTag } from "./helpers/e2e";
import {
  e2eDb,
  seedNextPolicyVersion,
  seedPolicyAcceptanceFor,
} from "./helpers/db";
import { flushRateLimits } from "./helpers/rate-limit";
import { loginViaUI } from "./helpers/auth";

/**
 * Phase 5 Golden Flow — GF-L3 POLICY_VERSION_UPGRADE
 *
 * 本测试会发布一个全局立即生效的新政策版本（真实 publish 语义）。
 * 任何"注册早于发布"的用户都会被打成 OUTDATED——因此本 spec 被分配到
 * governance-last 项目（playwright.config.ts dependencies: ["chromium"]），
 * 只在主套件全部结束后运行，避免并行 worker 中的其他用户/测试被波及。
 */

test("GF-L3 政策版本升级：stale 同意失效 → 提交旧集合 fail closed → 重新同意恢复", async ({
  browser,
}) => {
  const tag = uniqueTag("gf-l3");
  const email = `${tag}@e2e.test`;
  const nickname = `升级用户${tag.slice(-8)}`;

  await flushRateLimits();

  // 0. 专属用户注册并接受当前版本集合（此时记录其 TERMS 文档 id 作为"旧版本"）
  const setupContext = await browser.newContext();
  const setupPage = await setupContext.newPage();
  await setupPage.goto("/register");
  await setupPage.locator('input[name="name"]').first().fill(nickname);
  await setupPage.locator('input[name="email"]').first().fill(email);
  await setupPage.locator('input[name="password"]').first().fill("L3Pass#2026");
  await setupPage.locator('input[name="confirmPassword"]').first().fill("L3Pass#2026");
  await setupPage.locator('input[name="agreeLegal"]').first().check();
  await setupPage.getByRole("button", { name: "注册账户" }).click();
  await expect(setupPage.getByText("注册成功，请登录")).toBeVisible();
  await setupContext.close();

  const user = await e2eDb().user.findUniqueOrThrow({ where: { email } });
  const previousAcceptance = await e2eDb().policyAcceptance.findFirstOrThrow({
    where: { userId: user.id, documentType: "TERMS_OF_SERVICE" },
  });
  const previousDocumentId = previousAcceptance.documentId;

  // 1. fixture：发布 TERMS 下一版本（真实 publish 语义，立即生效）
  const upgraded = await seedNextPolicyVersion(
    "TERMS_OF_SERVICE",
    `E2E 升级协议 ${tag}`,
    `E2E 升级协议内容 ${tag}`,
  );

  // 2. 给 4 个共享 storageState 账号插入 fixture 同意（本套件已全部结束，
  //    主要为保证下一轮 e2e 重跑前的库内状态一致；legacy 除外：
  //    GF-L2 在主套件中依赖其无同意状态）
  for (const account of [
    E2E_ACCOUNTS.buyer,
    E2E_ACCOUNTS.seller,
    E2E_ACCOUNTS.admin,
    E2E_ACCOUNTS.outsider,
  ]) {
    await seedPolicyAcceptanceFor(account.email, upgraded.id);
  }

  // 3. 专属用户登录 → 旧同意变 OUTDATED → 访问受保护页被拦截
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUI(page, email, "L3Pass#2026", nickname);

  await page.goto("/profile");
  await page.waitForURL((url) => url.pathname === "/legal/accept");
  await expect(page.getByText(/旧版本的同意不会自动延续到新版本/).first()).toBeVisible();

  // 4. stale 提交（直接提交旧版本文档 id）必须 fail closed
  const staleResponse = await page.request.post("/api/legal/acceptances", {
    data: { documentIds: [previousDocumentId] },
  });
  expect(staleResponse.status()).toBe(409);
  expect((await staleResponse.json()).code).toBe("LEGAL_DOCUMENT_NOT_CURRENT");

  // 提交后仍未满足（consent gate 保持）
  await page.goto("/profile");
  await page.waitForURL((url) => url.pathname === "/legal/accept");

  // 5. UI 显式同意当前版本集合 → DB 验证新版本证据 + 恢复访问
  await page.locator('input[name="agreeLegal"]').first().check();
  await page.getByRole("button", { name: "同意并继续" }).first().click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });

  const v2Evidence = await e2eDb().policyAcceptance.findUnique({
    where: { userId_documentId: { userId: user.id, documentId: upgraded.id } },
  });
  expect(v2Evidence).toBeTruthy();
  expect(v2Evidence!.documentVersion).toBe(upgraded.version);
  expect(v2Evidence!.source).toBe("RECONSENT");

  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: nickname })).toBeVisible();

  await context.close();
});
