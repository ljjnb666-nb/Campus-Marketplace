import { expect, test } from "@playwright/test";
import { installLoginProbeOnDocument } from "./helpers/auth";

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
