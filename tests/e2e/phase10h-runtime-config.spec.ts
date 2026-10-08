import { expect, test } from "@playwright/test";
import { e2eDb } from "./helpers/db";
import { uniqueTag } from "./helpers/e2e";
import { expectHeadingSettled } from "./helpers/hydration-settlement";

test.describe.configure({ retries: 0 });

/** Real browser action -> 10E canonical write -> append-only revision/audit.
 * The next guarded E2E setup owns cleanup; browser tests never delete history.
 */
test("10H-E2E01：校区参数 → 二次确认 → CAS/审计 → 恢复继承", async ({ browser }) => {
  test.setTimeout(90_000);
  const db = e2eDb();
  const tag = uniqueTag("p10h");
  const campus = await db.campus.create({
    data: {
      name: `E2E配置校区-${tag}`,
      slug: `p10h-${tag}`,
      schoolName: "E2E 大学",
      isActive: true,
    },
  });
  const context = await browser.newContext({ storageState: "tests/e2e/.auth/admin.json" });
  const page = await context.newPage();
  const key = "RISK_SIGNAL_EVIDENCE_LIMIT";
  const scopeKey = `CAMPUS:${campus.id}`;
  try {
    await page.goto(`/governance/runtime-config?campusId=${campus.id}`);
    await expectHeadingSettled(page, "运行时配置中心");
    await expect(page.getByRole("combobox", { name: "管理范围" })).toHaveValue(campus.id);
    await expect(page.getByText("当前生效：50 条")).toBeVisible();

    await page.getByRole("spinbutton", { name: "证据条数" }).fill("12");
    await page.getByRole("button", { name: "预览变更" }).click();
    const submit = page.getByRole("button", { name: "确认提交" });
    await expect(submit).toBeDisabled();
    await page.getByRole("checkbox", { name: /我已核对校区范围/ }).check();
    await submit.click();

    await expect.poll(async () => db.runtimeConfigOverride.findUnique({
      where: { key_scopeKey: { key, scopeKey } },
      select: { value: true, version: true },
    })).toEqual({ value: 12, version: 1 });
    await expect.poll(async () => db.runtimeConfigRevision.count({
      where: { config: { key, campusId: campus.id } },
    })).toBe(1);
    await expect.poll(async () => db.adminLog.count({
      where: { action: "RUNTIME_CONFIG_CHANGED", campusId: campus.id },
    })).toBe(1);

    await page.reload();
    await expectHeadingSettled(page, "运行时配置中心");
    await expect(page.getByText("当前生效：12 条")).toBeVisible();
    await page.getByRole("combobox", { name: "操作方式" }).selectOption("inherit");
    await page.getByRole("button", { name: "预览变更" }).click();
    await page.getByRole("checkbox", { name: /我已核对校区范围/ }).check();
    await page.getByRole("button", { name: "确认提交" }).click();

    await expect.poll(async () => db.runtimeConfigOverride.findUnique({
      where: { key_scopeKey: { key, scopeKey } },
      select: { value: true, version: true },
    })).toEqual({ value: null, version: 2 });
    await expect.poll(async () => db.runtimeConfigRevision.count({
      where: { config: { key, campusId: campus.id } },
    })).toBe(2);
    await expect.poll(async () => db.adminLog.count({
      where: { action: "RUNTIME_CONFIG_CHANGED", campusId: campus.id },
    })).toBe(2);

    await page.reload();
    await expectHeadingSettled(page, "运行时配置中心");
    await expect(page.getByText("当前生效：50 条")).toBeVisible();
    await expect(page.getByRole("region", { name: "配置修订历史" })).toContainText("v2");
  } finally {
    await context.close();
    // Never delete versioned revisions in tests. Guarded e2e-setup owns reset.
  }
});
