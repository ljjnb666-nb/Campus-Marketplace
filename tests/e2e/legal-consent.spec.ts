import { test, expect } from "@playwright/test";
import { E2E_ACCOUNTS, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";
import { flushRateLimits } from "./helpers/rate-limit";
import { loginViaUI } from "./helpers/auth";

/**
 * Phase 5 Golden Flows — 法务协议与同意治理
 * GF-L1 NEW_USER_LEGAL_ACCEPTANCE：注册即绑定当前版本同意证据
 * GF-L2 LEGACY_USER_RECONSENT：无同意用户被 consent gate 拦截，API mutation 不可绕过
 * （GF-L3 POLICY_VERSION_UPGRADE 拆分至 legal-version-upgrade.spec.ts：
 *   该测试会发布全局生效的新政策版本，必须在主套件全部结束后单独执行，
 *   避免并行 worker 中的其他用户被升级打成 OUTDATED）
 */

test("GF-L1 新用户注册：阅读并同意 required 协议 → 同意证据与当前版本绑定 → 正常访问", async ({
  browser,
}) => {
  const tag = uniqueTag("gf-l1");
  const email = `${tag}@e2e.test`;
  const nickname = `新用户${tag.slice(-8)}`;

  await flushRateLimits();

  // 1. 注册（含显式同意勾选）
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/register");
  await page.locator('input[name="name"]').first().fill(nickname);
  await page.locator('input[name="email"]').first().fill(email);
  await page.locator('input[name="password"]').first().fill("L1Pass#2026");
  await page.locator('input[name="confirmPassword"]').first().fill("L1Pass#2026");

  // 注册页展示当前 required 文档链接
  const documentLinks = page.locator('a[href^="/legal/"]');
  expect(await documentLinks.count()).toBeGreaterThanOrEqual(1);

  await page.locator('input[name="agreeLegal"]').first().check();
  await page.getByRole("button", { name: "注册账户" }).click();
  await expect(page.getByText("注册成功，请登录")).toBeVisible();

  // 2. DB 验证：acceptance 记录与实际 published 当前版本绑定
  const user = await e2eDb().user.findUnique({ where: { email } });
  expect(user).toBeTruthy();

  const acceptances = await e2eDb().policyAcceptance.findMany({
    where: { userId: user!.id },
    include: { document: true },
  });
  expect(acceptances.length).toBeGreaterThanOrEqual(1);
  for (const acceptance of acceptances) {
    expect(acceptance.source).toBe("SIGNUP");
    expect(acceptance.document.status).toBe("PUBLISHED");
    expect(acceptance.documentVersion).toBe(acceptance.document.version);
    expect(acceptance.documentHash).toBe(acceptance.document.contentHash);
  }

  // 3. 登录后正常访问受保护页（consent gate 放行）
  await loginViaUI(page, email, "L1Pass#2026", nickname);
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: nickname })).toBeVisible();

  await context.close();
});

test("GF-L2 legacy 用户：登录被引导重新同意，API mutation 无法绕过 consent gate", async ({
  browser,
}) => {
  const legacy = E2E_ACCOUNTS.legacy;
  const context = await browser.newContext();
  const page = await context.newPage();

  // 1. legacy 用户登录（storageState 不存在 → 走真实表单）
  await loginViaUI(page, legacy.email, legacy.password, legacy.name);

  // 2. 访问任何受保护业务页 → 被引导到 /legal/accept
  await page.goto("/profile");
  await page.waitForURL((url) => url.pathname === "/legal/accept");
  await expect(page.getByRole("heading", { name: /请阅读并确认最新协议/ })).toBeVisible();

  // 3. 直接调用业务 API（上传）试图绕过 → 403 LEGAL_ACCEPTANCE_REQUIRED
  const bypass = await page.request.post("/api/upload/images", {
    multipart: {
      file: {
        name: "bypass.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from([
          0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 1, 1, 0, 0,
          1, 0, 1, 0, 0, 0xff, 0xd9,
        ]),
      },
      category: "product",
    },
  });
  expect(bypass.status()).toBe(403);
  expect((await bypass.json()).code).toBe("LEGAL_ACCEPTANCE_REQUIRED");

  // 4. 显式同意 → 访问恢复
  await page.locator('input[name="agreeLegal"]').first().check();
  await page.getByRole("button", { name: "同意并继续" }).first().click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });

  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: legacy.name }).first()).toBeVisible();

  // 5. 同意历史留下 RECONSENT 证据
  const user = await e2eDb().user.findUnique({ where: { email: legacy.email } });
  const acceptances = await e2eDb().policyAcceptance.findMany({
    where: { userId: user!.id, source: "RECONSENT" },
  });
  expect(acceptances.length).toBeGreaterThanOrEqual(1);

  await context.close();
});
