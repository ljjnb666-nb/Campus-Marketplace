import { expect, test } from "@playwright/test";
import { e2eDb } from "./helpers/db";
import { uniqueTag } from "./helpers/e2e";
import { expectHeadingSettled } from "./helpers/hydration-settlement";

test.describe.configure({ retries: 0 });

test("10I-E2E01：risk.read 全局/单校区精确隔离，未核实举报只提示观察", async ({ browser }) => {
  test.setTimeout(90_000);
  const db = e2eDb();
  const tag = uniqueTag("p10i");
  const target = await db.user.findUniqueOrThrow({
    where: { email: "e2e-buyer@e2e.test" }, select: { id: true },
  });
  const [campusA, campusB] = await Promise.all([
    db.campus.create({ data: { name: "风险校区甲-" + tag, slug: "p10i-a-" + tag, schoolName: "E2E A", isActive: true } }),
    db.campus.create({ data: { name: "风险校区乙-" + tag, slug: "p10i-b-" + tag, schoolName: "E2E B", isActive: true } }),
  ]);
  // Different campus signal provenance must never mix in a scoped query.
  const secret = "never-render-note-" + tag;
  await Promise.all([
    db.riskFlag.create({ data: {
      userId: target.id, campusId: campusA.id, kind: "REPORT_SUBMITTED",
      severity: "HIGH", sourceType: "E2E_UNCONFIRMED", sourceId: "10i-a-" + tag,
      note: secret, reasonCode: secret,
    } }),
    db.riskFlag.create({ data: {
      userId: target.id, campusId: campusB.id, kind: "REPORT_CONFIRMED",
      severity: "HIGH", sourceType: "E2E_CONFIRMED", sourceId: "10i-b-" + tag,
      note: secret, reasonCode: secret,
    } }),
  ]);
  const context = await browser.newContext({ storageState: "tests/e2e/.auth/admin.json" });
  const page = await context.newPage();
  try {
    const exactA = new URLSearchParams({ targetUserId: target.id, campusId: campusA.id });
    await page.goto("/governance/risk?" + exactA.toString());
    await expectHeadingSettled(page, "风险情报查询");
    const summary = page.getByRole("region", { name: "风险情报概览" });
    await expect(summary.getByRole("heading", { name: "持续关注" })).toBeVisible();
    await expect(summary).toContainText("活跃风险信号数1");
    const evidenceA = page.getByRole("region", { name: "风险信号证据" });
    await expect(evidenceA).toContainText("E2E_UNCONFIRMED");
    await expect(evidenceA).not.toContainText("E2E_CONFIRMED");
    await expect(page.getByRole("region", { name: "命中规则" })).toContainText("未核实举报（仅供参考）");
    await expect(page.locator("body")).not.toContainText(secret);

    const exactB = new URLSearchParams({ targetUserId: target.id, campusId: campusB.id });
    await page.goto("/governance/risk?" + exactB.toString());
    await expectHeadingSettled(page, "风险情报查询");
    await expect(summary.getByRole("heading", { name: "优先人工复核" })).toBeVisible();
    await expect(evidenceA).toContainText("E2E_CONFIRMED");
    await expect(evidenceA).not.toContainText("E2E_UNCONFIRMED");

    await page.goto("/governance/risk?targetUserId=" + encodeURIComponent(target.id));
    await expectHeadingSettled(page, "风险情报查询");
    await expect(summary.getByRole("heading", { name: "优先人工复核" })).toBeVisible();
    await expect(summary).toContainText("活跃风险信号数2");
    await expect(evidenceA).toContainText("E2E_UNCONFIRMED");
    await expect(evidenceA).toContainText("E2E_CONFIRMED");
    await expect(page.locator("body")).not.toContainText(secret);
  } finally {
    await context.close();
    // E2E reset owns fixture cleanup; no direct admin history mutation.
  }
});
