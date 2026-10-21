import { test, expect } from "@playwright/test";
import { hashSync } from "bcryptjs";

import { uniqueTag, E2E_ACCOUNTS } from "./helpers/e2e";
import { e2eDb } from "./helpers/db";

/**
 * R3D02C07D03 — REAL Next.js production bundle + Prisma6 + PG + browser JWT:
 * a suspended user may reach only the existing bounded appeal API/portal,
 * never the normal notification or business surfaces.
 *
 * Per-spec random credentials and two unique fixture users, no fixture
 * mutation of shared E2E accounts. This runs in the standard Chromium E2E
 * job and does NOT certify Microsoft Edge specifically.
 */
test("停用账户真实登录后只能查看本人处罚并提交一份申诉，普通通知与交易页面仍禁止", async ({ browser }) => {
  const db = e2eDb();
  const tag = uniqueTag("r3d02c07d03");
  const campus = await db.campus.findUniqueOrThrow({ where: { slug: "main-campus" } });
  const actor = await db.user.findUniqueOrThrow({ where: { email: E2E_ACCOUNTS.admin.email } });
  const password = (process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e") + "Appeal#2026";
  const createSuspended = async (suffix: string) => {
    const user = await db.user.create({
      data: {
        email: tag + "-" + suffix + "@e2e.test",
        name: "申诉隔离用户" + suffix,
        passwordHash: hashSync(password, 10),
        schoolName: campus.schoolName,
        campusId: campus.id,
        status: "SUSPENDED",
        verificationStatus: "VERIFIED",
      },
    });
    const membership = await db.campusMembership.upsert({
      where: { userId_campusId: { userId: user.id, campusId: campus.id } },
      update: {},
      create: { userId: user.id, campusId: campus.id, status: "ACTIVE" },
    });
    expect(membership.status).toBe("ACTIVE");
    const action = await db.enforcementAction.create({
      data: {
        type: "ACCOUNT_SUSPEND",
        actorId: actor.id,
        targetId: user.id,
        campusId: null,
        scopeKey: "GLOBAL",
        reasonCode: "POLICY_VIOLATION",
        note: "NOT-FOR-USER-UI-" + suffix + "-" + tag,
        previousState: "USER:ACTIVE",
        resultState: "USER:SUSPENDED",
      },
    });
    return { user, action };
  };

  const own = await createSuspended("own");
  const foreign = await createSuspended("foreign");

  // Unauthenticated public shell does not hydrate any private row.
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto("/appeals");
  await expect(guestPage.getByRole("heading", { name: "账号与处罚申诉" })).toBeVisible();
  await expect(guestPage.getByText("当前无法验证申诉会话", { exact: false })).toBeVisible();
  await expect(guestPage.getByText("账号限制", { exact: true })).toHaveCount(0);
  const unauth = await guestPage.request.get("/api/appeals/eligible-actions", { failOnStatusCode: false });
  expect(unauth.status()).toBe(401);
  expect(unauth.headers()["cache-control"]).toContain("no-store");
  await guest.close();

  // Credentials authorizes the limited suspended identity session; it must
  // not grant the ACTIVE-only capability checked by requireUser().
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "账号受限？进入申诉" })).toBeVisible();
  // Issue #115 login DOM instability: on a first CI attempt Playwright
  // observed TWO email inputs (strict-mode collision) during login render.
  // Never choose .first() and silently operate on an arbitrary duplicate.
  // Allow a bounded settling window; persistent duplication is a true FAIL.
  const firstObservedEmailCount = Math.min(await page.locator('input[name="email"]').count(), 4);
  if (firstObservedEmailCount > 1) {
    console.warn("R3D02C07D03_LOGIN_DUPLICATE_INPUT_OBSERVED bounded_count=" + firstObservedEmailCount);
  }
  await expect(page.locator('input[name="email"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('input[name="password"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "登录", exact: true })).toHaveCount(1, {
    timeout: 15_000,
  });
  await page.locator('input[name="email"]').fill(own.user.email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();

  await expect.poll(async () => {
    const res = await page.request.get("/api/appeals/eligible-actions", { failOnStatusCode: false });
    return res.status();
  }, { timeout: 30_000 }).toBe(200);

  await page.goto("/notifications");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await page.goto("/my/orders");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);

  // Reuse the same JWT at the designated appeal-only allowlisted endpoint.
  await page.goto("/appeals");
  await expect(page.getByRole("heading", { name: "账号与处罚申诉" })).toBeVisible();
  await expect(page.getByText("本人可申诉记录")).toBeVisible();
  await expect(page.getByText("账号限制", { exact: true })).toBeVisible();
  await expect(page.locator("section ul > li")).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText("NOT-FOR-USER-UI-own-" + tag);
  await expect(page.locator("body")).not.toContainText("NOT-FOR-USER-UI-foreign-" + tag);
  const ownList = await page.request.get("/api/appeals/eligible-actions");
  expect(ownList.ok()).toBe(true);
  expect(ownList.headers()["cache-control"]).toContain("no-store");
  const payload = await ownList.json() as { items: { enforcementActionId: string }[] };
  expect(payload.items.map(row => row.enforcementActionId)).toEqual([own.action.id]);
  expect(payload.items.some(row => row.enforcementActionId === foreign.action.id)).toBe(false);

  await page.getByRole("button", { name: "为此项处罚提交申诉" }).click();
  await page.getByLabel("申诉说明").fill("R3D02C07D03 本人提出申诉 " + tag);
  await page.getByRole("button", { name: "提交申诉", exact: true }).click();
  await expect(page.getByText("已有申诉，状态：", { exact: false })).toContainText("已提交");
  await expect.poll(async () => db.appeal.count({
    where: { enforcementActionId: own.action.id },
  })).toBe(1);
  await expect(page.getByRole("button", { name: "为此项处罚提交申诉" })).toHaveCount(0);
  expect(await db.appeal.count({
    where: { enforcementActionId: foreign.action.id },
  })).toBe(0);
  expect((await db.user.findUniqueOrThrow({ where: { id: own.user.id } })).status).toBe("SUSPENDED");
  await ctx.close();
});
