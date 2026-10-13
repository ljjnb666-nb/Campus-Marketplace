import { expect, test } from "@playwright/test";
import { classifyLoginFailureEvidence, installLoginProbeOnDocument } from "./helpers/auth";

test("Issue #115 R14: registered login probe actually executes in Chromium /login documents", async ({ page }) => {
  await page.addInitScript(installLoginProbeOnDocument);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 0) await page.goto("/login");
    else await page.reload();

    const observed = await page.evaluate(() => {
      const probe = (window as Window & { __campusE2ELoginProbe?: {
        installed: boolean;
        clicks: number;
        submits: number;
        preventedSubmits: number;
        pendingSeen: boolean;
        formCountAtClick: number;
      } }).__campusE2ELoginProbe;
      if (!probe) return null;
      return {
        installed: probe.installed,
        clicks: probe.clicks,
        submits: probe.submits,
        preventedSubmits: probe.preventedSubmits,
        pendingSeen: probe.pendingSeen,
        formCountAtClick: probe.formCountAtClick,
      };
    });

    expect(observed).toEqual({
      installed: true,
      clicks: 0,
      submits: 0,
      preventedSubmits: 0,
      pendingSeen: false,
      formCountAtClick: -1,
    });
  }
});

test("Issue #115 R15: clicking invalid login form does not submit or start credentials callback", async ({ page }) => {
  await page.addInitScript(installLoginProbeOnDocument);
  let callbackCount = 0;
  const onRequest = (request: import("@playwright/test").Request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(page.url()).origin &&
        url.pathname === "/api/auth/callback/credentials") callbackCount++;
  };
  page.on("request", onRequest);
  try {
    await page.goto("/login");
    await page.getByRole("button", { name: "登录" }).click();

    const evidence = await page.evaluate(() => {
      const probe = (window as Window & { __campusE2ELoginProbe?: {
        installed: boolean; clicks: number; submits: number;
      } }).__campusE2ELoginProbe;
      return probe ? { executed: probe.installed, clicks: probe.clicks, submits: probe.submits } : null;
    });
    expect(evidence?.executed).toBe(true);
    expect(evidence?.clicks).toBeGreaterThanOrEqual(1);
    expect(evidence?.submits).toBe(0);
    expect(callbackCount).toBe(0);
    expect(classifyLoginFailureEvidence(false, false, evidence)).toBe("native_click_observed_no_submit");
    await expect(page).toHaveURL((url) => url.pathname === "/login");
  } finally {
    page.off("request", onRequest);
  }
});
