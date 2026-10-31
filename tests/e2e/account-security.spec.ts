import { hashSync, compare } from "bcryptjs";
import { expect, test } from "@playwright/test";
import { createTestFixtureAcceptance } from "../../prisma/legal-seed-content";
import { challengeToken } from "../../src/lib/account-security-crypto";
import { e2eDb } from "./helpers/db";
import { uniqueTag } from "./helpers/e2e";
import { loginViaUI, verifyEmailViaUI } from "./helpers/account-security";
// Intentionally leave proofs incomplete in negative boundary tests.
import { loginViaUI as loginWithPasswordOnly } from "./helpers/auth";

async function fixture(privileged = false) {
  const db = e2eDb(); const tag = uniqueTag("security"); const password = "SecurityFixture123";
  const campus = await db.campus.findUniqueOrThrow({ where: { slug: "main-campus" } });
  const user = await db.user.create({ data: {
    email: `${tag}@e2e.test`, name: `安全${tag.slice(-8)}`, schoolName: campus.schoolName, campusId: campus.id,
    passwordHash: hashSync(password, 10), emailVerifiedAt: privileged ? new Date() : null,
  } });
  await createTestFixtureAcceptance(db, user.id);
  if (privileged) {
    const role = await db.role.findUniqueOrThrow({ where: { key: "PLATFORM_ADMIN" } });
    await db.userRoleAssignment.create({ data: { userId: user.id, roleId: role.id, scopeKey: "GLOBAL" } });
  }
  return { ...user, password };
}

test("账号安全：邮箱证明、设备撤销和单次密码恢复均通过真实页面", async ({ browser }) => {
  const user = await fixture();
  const firstContext = await browser.newContext(); const otherContext = await browser.newContext();
  try {
    const first = await firstContext.newPage(); const other = await otherContext.newPage();
    await loginWithPasswordOnly(first, user.email, user.password, user.name!);
    await first.goto("/profile");
    await expect(first).toHaveURL((url) => url.pathname === "/my/security" && url.searchParams.get("step") === "email");
    const gated = await first.request.post("/api/upload/images", { multipart: { category: "product" } });
    expect(gated.status()).toBe(403); expect((await gated.json()).code).toBe("EMAIL_VERIFICATION_REQUIRED");
    await verifyEmailViaUI(first, user.id);
    await first.goto("/profile");
    await expect(first.getByRole("heading", { name: user.name! })).toBeVisible();
    await loginViaUI(other, user.email, user.password, user.name!);
    await first.goto("/my/security");
    await first.getByRole("button", { name: "退出其他设备", exact: true }).click();
    await expect.poll(() => e2eDb().accountSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);
    await other.goto("/profile"); await expect(other).toHaveURL((url) => url.pathname === "/login");
    await loginViaUI(other, user.email, user.password, user.name!);

    // The fixture database represents the recipient's mailbox; proof is still
    // submitted by the real confirmation page, never by a direct DB update.
    await first.goto("/forgot-password");
    await first.locator('input[name="email"]').fill(user.email);
    await first.getByRole("button", { name: "发送密码重置邮件", exact: true }).click();
    await expect(first.getByRole("status")).toContainText("如果账号符合条件");
    const challenge = await e2eDb().accountChallenge.findFirstOrThrow({ where: { userId: user.id, purpose: "RESET_PASSWORD", consumedAt: null }, orderBy: { createdAt: "desc" } });
    const url = `/account/confirm#${new URLSearchParams({ id: challenge.id, purpose: challenge.purpose, token: challengeToken(challenge.id, challenge.purpose) })}`;
    await first.goto(url);
    await first.locator('input[name="newPassword"]').fill("ChangedSecurity456");
    await first.locator('input[name="confirmPassword"]').fill("ChangedSecurity456");
    await first.getByRole("button", { name: "重置密码", exact: true }).click();
    await expect(first.getByRole("status")).toContainText("密码已重置");
    expect(await e2eDb().accountSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect(await compare("ChangedSecurity456", (await e2eDb().user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
    await other.goto("/profile"); await expect(other).toHaveURL((current) => current.pathname === "/login");
    await first.goto(url);
    await first.locator('input[name="newPassword"]').fill("AnotherSecurity789");
    await first.locator('input[name="confirmPassword"]').fill("AnotherSecurity789");
    await first.getByRole("button", { name: "重置密码", exact: true }).click();
    await expect(first.getByRole("status")).toContainText("操作失败");
    expect(await e2eDb().adminLog.count({ where: { adminId: user.id, action: "ACCOUNT_PASSWORD_RESET" } })).toBe(1);
    await loginViaUI(first, user.email, "ChangedSecurity456", user.name!);
  } finally { await firstContext.close(); await otherContext.close(); }
});

test("账号安全：有效RBAC权限要求MFA，绑定与后续TOTP登录均通过真实页面", async ({ browser }) => {
  const user = await fixture(true);
  const weakContext = await browser.newContext(); const strongContext = await browser.newContext();
  try {
    const weak = await weakContext.newPage(); const strong = await strongContext.newPage();
    await loginWithPasswordOnly(weak, user.email, user.password, user.name!);
    await weak.goto("/admin");
    await expect(weak).toHaveURL((url) => url.pathname === "/my/security" && url.searchParams.get("step") === "mfa");
    expect((await weak.request.get("/api/assets/missing-asset/access")).status()).toBe(403);
    await loginViaUI(strong, user.email, user.password, user.name!);
    await strong.goto("/admin");
    await expect(strong).toHaveURL((url) => url.pathname === "/admin");
    expect((await strong.request.get("/api/assets/missing-asset/access")).status()).toBe(404);
    await weak.goto("/admin"); await expect(weak).toHaveURL((url) => url.pathname === "/login");
    // Password alone no longer creates a session after real enrollment.
    await weak.locator('input[name="email"]').first().fill(user.email);
    await weak.locator('input[name="password"]').first().fill(user.password);
    await weak.getByRole("button", { name: "登录", exact: true }).click();
    await expect(weak.getByText("邮箱、密码或动态验证码错误", { exact: true })).toBeVisible();
    // The helper waits for a new counter, never erases the replay guard.
    await loginViaUI(weak, user.email, user.password, user.name!);
    await weak.goto("/admin"); await expect(weak).toHaveURL((url) => url.pathname === "/admin");
    expect(await e2eDb().accountSession.count({ where: { userId: user.id, revokedAt: null, strongAuthAt: { not: null } } })).toBe(2);
  } finally { await weakContext.close(); await strongContext.close(); }
});
