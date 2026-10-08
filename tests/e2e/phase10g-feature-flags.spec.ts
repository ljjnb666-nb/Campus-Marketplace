import { expect, test } from "@playwright/test";

import { e2eDb } from "./helpers/db";
import { uniqueTag } from "./helpers/e2e";
import { expectHeadingSettled } from "./helpers/hydration-settlement";

test.describe.configure({ retries: 0 });

/**
 * G15: browser performs real user actions; DB asserts canonical 10F authority.
 * Isolated campus avoids any interaction with the other 93 E2E flows.
 */
test("10G-E2E01：中文控制台 → 校区暂停 → 二次确认 → 原子审计 → 恢复继承", async ({ browser }) => {
  test.setTimeout(90_000);
  const db = e2eDb();
  const tag = uniqueTag("p10g");
  const campus = await db.campus.create({
    data: {
      name: `E2E开关校区-${tag}`,
      slug: `p10g-${tag}`,
      schoolName: "E2E 大学",
      isActive: true,
    },
  });
  const context = await browser.newContext({ storageState: "tests/e2e/.auth/admin.json" });
  const page = await context.newPage();
  try {
    await page.goto(`/governance/feature-flags?campusId=${campus.id}`);
    await expectHeadingSettled(page, "功能开关与应急熔断");
    // Exact scope authority, not a text locator that also matches the picker option.
    await expect(page.getByRole("combobox", { name: "管理范围" })).toHaveValue(campus.id);

    const card = page.locator("article", {
      has: page.getByRole("heading", { name: "新用户注册", exact: true }),
    });
    await expect(card).toContainText("可使用");
    await card.getByRole("button", { name: "修改新用户注册配置" }).click();
    await card.getByLabel("变更为").selectOption("true");
    await card.getByRole("button", { name: "预览变更" }).click();
    const confirm = card.getByRole("button", { name: "确认提交" });
    await expect(confirm).toBeDisabled();
    await card.getByRole("checkbox", { name: /我已核对作用范围/ }).check();
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect.poll(async () => db.featureFlagOverride.findUnique({
      where: { key_scopeKey: { key: "DISABLE_REGISTRATION", scopeKey: `CAMPUS:${campus.id}` } },
      select: { disabled: true, version: true },
    })).toEqual({ disabled: true, version: 1 });
    await expect.poll(async () => db.featureFlagRevision.count({
      where: { flag: { key: "DISABLE_REGISTRATION", campusId: campus.id } },
    })).toBe(1);
    await expect.poll(async () => db.adminLog.count({
      where: { action: "FEATURE_FLAG_CHANGED", campusId: campus.id },
    })).toBe(1);

    await expect(card).toContainText("已暂停");
    await page.reload();
    await expectHeadingSettled(page, "功能开关与应急熔断");
    const freshCard = page.locator("article", {
      has: page.getByRole("heading", { name: "新用户注册", exact: true }),
    });
    await freshCard.getByRole("button", { name: "修改新用户注册配置" }).click();
    await freshCard.getByLabel("变更为").selectOption("inherit");
    await freshCard.getByRole("button", { name: "预览变更" }).click();
    await freshCard.getByRole("checkbox", { name: /我已核对作用范围/ }).check();
    await freshCard.getByRole("button", { name: "确认提交" }).click();

    await expect.poll(async () => db.featureFlagOverride.findUnique({
      where: { key_scopeKey: { key: "DISABLE_REGISTRATION", scopeKey: `CAMPUS:${campus.id}` } },
      select: { disabled: true, version: true },
    })).toEqual({ disabled: null, version: 2 });
    await expect.poll(async () => db.featureFlagRevision.count({
      where: { flag: { key: "DISABLE_REGISTRATION", campusId: campus.id } },
    })).toBe(2);
    await expect.poll(async () => db.adminLog.count({
      where: { action: "FEATURE_FLAG_CHANGED", campusId: campus.id },
    })).toBe(2);
    await expect(freshCard).toContainText("可使用");
  } finally {
    await context.close();
    // Phase 10F append-only revisions MUST NOT be deleted, even for test
    // fixtures. Keep this isolated campus and its revision/audit evidence for
    // E2E failure diagnosis. The NEXT run's guarded e2e-setup owns the entire
    // E2E database reset, including the immutable revision tables.
  }
});
