import { test, expect } from "@playwright/test";
import { e2eDb } from "./helpers/db";

/** Real production-build form POST -> HTTP 303 -> unchanged GET read. */
test("10K-R2a search submit preserves navigation while telemetry is disabled", async ({ page }) => {
  const beforeClaims = await e2eDb().searchTelemetryClaim.count();
  const beforeHours = await e2eDb().searchTelemetryHour.count();
  await page.goto("/search");
  // Next.js may retain a hidden outgoing tree during navigation. The form
  // contract is exactly one VISIBLE search form inside the active main region,
  // not exactly one matching DOM node across retained hidden trees.
  // Do not use .first(): two simultaneously visible forms are a real UI bug.
  const form = page.locator('main form[action="/search/submit"]:visible');
  await expect(form).toHaveCount(1);
  await expect(form).toBeVisible();
  const keyword = "r2a-no-results-fixture-" + Date.now();
  await form.locator('input[name="q"]').fill(keyword);
  await Promise.all([
    page.waitForURL(url => url.pathname === "/search" && url.searchParams.get("q") === keyword),
    form.getByRole("button", { name: "搜索" }).click(),
  ]);
  // Next navigation may briefly retain both outgoing and incoming trees.
  // Restrict to the currently visible search result before asserting.
  await expect(page.getByText("没有找到相关内容，可以换一个关键词再试。")
    .filter({ visible: true }).first()).toBeVisible();
  // The destination page must also have a single usable search form.
  await expect(page.locator('main form[action="/search/submit"]:visible')).toHaveCount(1);
  expect(await e2eDb().searchTelemetryClaim.count()).toBe(beforeClaims);
  expect(await e2eDb().searchTelemetryHour.count()).toBe(beforeHours);
});
