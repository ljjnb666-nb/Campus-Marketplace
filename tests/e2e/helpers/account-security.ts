import { expect, type Page } from "@playwright/test";
import { e2eDb } from "./db";
import { loginViaUI as loginWithoutMfa } from "./auth";
import { challengeToken, decryptMfa, totpCode } from "../../../src/lib/account-security-crypto";
import { asPermissionKey } from "../../../src/lib/rbac/permissions";
import { assertE2EDatabaseIsolation } from "../../../scripts/e2e-database-guard";

export { logoutViaUI } from "./auth";

function configureFixtureKey() {
  assertE2EDatabaseIsolation(process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public", process.env);
  // Same explicit test key as playwright.config.ts's isolated web server.
  process.env.NEXTAUTH_SECRET = process.env.E2E_NEXTAUTH_SECRET ?? "e2e-only-nextauth-secret-not-for-prod";
}

async function nextCode(userId: string): Promise<string> {
  // Wait for a never-consumed time step; never clear or rewrite replay state.
  for (;;) {
    const user = await e2eDb().user.findUniqueOrThrow({ where: { id: userId }, select: { mfaSecretEncrypted: true, mfaLastCounter: true } });
    if (!user.mfaSecretEncrypted) throw new Error("E2E_MFA_NOT_ENROLLED");
    const now = Date.now(); const counter = Math.floor(now / 30_000);
    if ((user.mfaLastCounter === null || BigInt(counter) > user.mfaLastCounter) && 30_000 - now % 30_000 > 2_000) {
      return totpCode(decryptMfa(user.mfaSecretEncrypted, userId), counter);
    }
    const next = Math.max(counter + 1, Number(user.mfaLastCounter ?? BigInt(counter)) + 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, next * 30_000 + 100 - now)));
  }
}

/** Browser completes the real mailbox challenge; the isolated DB is the test mailbox. */
export async function verifyEmailViaUI(page: Page, userId: string) {
  configureFixtureKey();
  await page.goto("/my/security");
  await page.getByRole("button", { name: "发送验证邮件", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("如果账号符合条件");
  const row = await e2eDb().accountChallenge.findFirstOrThrow({ where: {
    userId, purpose: "VERIFY_EMAIL", consumedAt: null, expiresAt: { gt: new Date() },
  }, orderBy: { createdAt: "desc" } });
  const fragment = new URLSearchParams({ id: row.id, purpose: row.purpose, token: challengeToken(row.id, row.purpose) });
  await page.goto(`/account/confirm#${fragment}`);
  await page.getByRole("button", { name: "确认验证邮箱", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("邮箱已验证");
  expect((await e2eDb().user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt).not.toBeNull();
}

/**
 * Authentication fixture adapter: all proofs are submitted through real UI.
 * The original auth.ts helper and its bounded callback diagnostics stay intact.
 */
export async function loginViaUI(page: Page, email: string, password: string, expectedName: string): Promise<void> {
  configureFixtureKey();
  const snapshot = await e2eDb().user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  // Test-only mutex, in a distinct namespace from USER governance locks. Shared
  // fixture administrators may be used by two Playwright workers concurrently.
  await e2eDb().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(979313, hashtext(${snapshot.id}))`;
    const user = await e2eDb().user.findUniqueOrThrow({ where: { id: snapshot.id }, include: {
      memberships: { where: { status: "ACTIVE" } },
      userRoles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } },
    } });
    if (user.mfaSecretEncrypted) {
      await page.goto("/login");
      await page.locator('input[name="email"]').first().fill(email);
      await page.locator('input[name="password"]').first().fill(password);
      await page.locator('input[name="mfaCode"]').first().fill(await nextCode(user.id));
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page).toHaveURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
      await expect(page.getByRole("button", { name: expectedName })).toBeVisible();
    } else {
      await loginWithoutMfa(page, email, password, expectedName);
    }
    // Suspended users intentionally retain the appeal-only identity flow.
    if (user.status !== "ACTIVE" || user.deletedAt || user.erasedAt) return;
    const landing = new URL(page.url());
    if (!user.emailVerifiedAt) await verifyEmailViaUI(page, user.id);
    const privileged = user.userRoles.some((assignment) =>
      assignment.role.rolePermissions.some((grant) => asPermissionKey(grant.permission.key)) &&
      (assignment.role.scope === "GLOBAL" || user.memberships.some((membership) => membership.campusId === assignment.campusId)));
    if (privileged && !user.mfaSecretEncrypted) {
      await page.goto("/my/security");
      const setup = page.locator("form", { has: page.getByRole("button", { name: "开始绑定验证器", exact: true }) });
      await setup.locator('input[name="password"]').fill(password);
      await setup.getByRole("button", { name: "开始绑定验证器", exact: true }).click();
      const displayedKey = page.locator("code");
      await expect(displayedKey).toHaveText(/^[A-Z2-7]{32}$/);
      const key = (await displayedKey.textContent())!;
      const confirm = page.getByRole("form", { name: "确认启用双重验证" });
      await confirm.locator('input[name="code"]').fill(totpCode(key, Math.floor(Date.now() / 30_000)));
      await confirm.getByRole("button", { name: "确认启用双重验证", exact: true }).click();
      // A successful confirmMfaAction revalidates /my/security. Its server
      // component swaps enabled=false for enabled=true, unmounting this ENABLE
      // form (and its status message). Never require a success status inside an
      // element that is intentionally removed on success. Instead assert the
      // committed MFA secret, followed by the newly rendered STEP_UP control.
      // A failed action leaves the DB assertion false and fails closed.
      // Never mutate MFA rows or bypass the real form from this fixture.
      await expect.poll(async () =>
        Boolean((await e2eDb().user.findUniqueOrThrow({
          where: { id: user.id }, select: { mfaSecretEncrypted: true },
        })).mfaSecretEncrypted),
      { message: "MFA enable must commit after the real UI submission", timeout: 12_000 }).toBe(true);
      await page.goto("/my/security");
      await expect(page.getByRole("button", { name: "验证以继续管理操作", exact: true })).toBeVisible();
    }
    if (!user.emailVerifiedAt || (privileged && !user.mfaSecretEncrypted)) {
      await page.goto(landing.pathname === "/my/security" ? "/" : `${landing.pathname}${landing.search}`);
    }
  }, { maxWait: 80_000, timeout: 80_000 });
}
