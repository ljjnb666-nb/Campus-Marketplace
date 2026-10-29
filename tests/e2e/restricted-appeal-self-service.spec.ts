import { expect, test } from "@playwright/test";
import { hashSync } from "bcryptjs";
import { E2E_ACCOUNTS, uniqueTag } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";
import { loginViaUI } from "./helpers/account-security";

/**
 * Actual browser + NextAuth + PostgreSQL proof of the restricted appellant
 * surface. A suspended account can appeal only its own enforcement action;
 * the same session must never grant access to regular business pages.
 */
test("受限账号：登录 → 本人申诉 → 普通业务仍拒绝", async ({ page }) => {
  const db = e2eDb();
  const tag = uniqueTag("restricted-appeal");
  const email = `appeal-self-${tag}@e2e.test`;
  const password = "E2eRestrictedAppeal#2026";
  const name = `申诉测试${tag.slice(-7)}`;
  const campus = await db.campus.findFirstOrThrow({ where: { slug: "main-campus" } });
  const actor = await db.user.findUniqueOrThrow({ where: { email: E2E_ACCOUNTS.admin.email } });

  const appellant = await db.user.create({ data: {
    email, name, passwordHash: hashSync(password, 10),
    schoolName: campus.schoolName, campusId: campus.id,
    status: "SUSPENDED", emailVerifiedAt: new Date(),
  } });
  const action = await db.enforcementAction.create({ data: {
    type: "ACCOUNT_SUSPEND", actorId: actor.id, targetId: appellant.id,
    campusId: null, scopeKey: "GLOBAL", reasonCode: "POLICY_VIOLATION",
    previousState: "ACTIVE", resultState: "SUSPENDED",
  } });

  // Anonymous appeal shell must remain public, but reveal no private rows.
  await page.goto("/login");
  await expect(page.getByText(/测试学生账号/)).toHaveCount(0);
  await expect(page.getByText("student1@campus.local / Student123456")).toHaveCount(0);
  await expect(page.locator('input[name="email"]')).toHaveAttribute("placeholder", "请输入校园邮箱");
  await expect(page.locator('input[name="password"]')).toHaveAttribute("placeholder", "请输入密码");
  await expect(page.getByRole("link", { name: "账号受限？进入申诉" })).toBeVisible();
  await expect(page.getByRole("link", { name: "忘记密码" })).toBeVisible();
  await expect(page.locator('input[name="mfaCode"]')).toBeVisible();
  await page.getByRole("link", { name: "账号受限？进入申诉" }).click();
  await expect(page.getByRole("heading", { name: "账号与处罚申诉" })).toBeVisible();
  await expect(page.getByText(/当前无法验证申诉会话/)).toBeVisible();
  await expect(page.getByText("账号限制", { exact: true })).toHaveCount(0);

  // A SUSPENDED account can establish an appeal-only identity session.
  await loginViaUI(page, email, password, name);
  await page.goto("/appeals");
  await expect(page.getByRole("heading", { name: "账号与处罚申诉" })).toBeVisible();
  await expect(page.getByText("账号限制", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "为此项处罚提交申诉" }).click();
  await page.getByRole("textbox", { name: "申诉说明" }).fill("请复核本次账号处罚的依据。");
  await page.getByRole("button", { name: "提交申诉", exact: true }).click();
  await expect(page.getByText(/已有申诉，状态：/)).toContainText("已提交");
  const recorded = await db.appeal.findUniqueOrThrow({
    where: { enforcementActionId: action.id },
  });
  expect(recorded.statement).toBe("请复核本次账号处罚的依据。");
  expect(recorded.status).toBe("SUBMITTED");

  // Appeal-only authorization must not open general marketplace surfaces.
  await page.goto("/my/orders");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
});
