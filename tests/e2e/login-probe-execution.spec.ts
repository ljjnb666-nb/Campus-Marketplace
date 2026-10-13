import { expect, test } from "@playwright/test";
import { classifyLoginFailureEvidence, installLoginProbeOnDocument } from "./helpers/auth";
import { createLoginAttemptNetworkEvidence } from "./helpers/login-callback-evidence";

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

/**
 * R16: real Chromium network-event lifecycle. Intercept the synthetic callback
 * locally before it reaches NextAuth; no real credentials, cookies, or session
 * state are used. A pre-attempt same-path response cannot become current
 * login evidence, even though Playwright delivers it on the same Page.
 */
test("Issue #115 R16: only post-arm Chromium callback request/response identity is attributed", async ({ page }) => {
  await page.goto("/login");
  const observer = createLoginAttemptNetworkEvidence(new URL(page.url()).origin);
  const callbackPath = "**/api/auth/callback/credentials";
  const fulfill = async (route: import("@playwright/test").Route) => {
    await route.fulfill({ status: 204, body: "" });
  };
  const onRequest = (request: import("@playwright/test").Request) => observer.onRequest(request);
  const onResponse = (response: import("@playwright/test").Response) => observer.onResponse(response);
  page.on("request", onRequest);
  page.on("response", onResponse);
  await page.route(callbackPath, fulfill);
  try {
    const sendSyntheticCallback = () => page.evaluate(async () => {
      await fetch("/api/auth/callback/credentials", { method: "POST" });
    });
    await sendSyntheticCallback();
    expect(observer.snapshot()).toMatchObject({
      started: false, status: "none", phase: "not_observed",
      preAttemptSeen: true, orphanResponseSeen: true,
    });

    observer.begin();
    await sendSyntheticCallback();
    await expect.poll(() => observer.snapshot().phase).toBe("response_observed");
    expect(observer.snapshot()).toMatchObject({
      started: true, status: "2xx", transportFailed: false,
      preAttemptSeen: true, orphanResponseSeen: true,
      trackingSaturated: false,
    });
    await expect(page).toHaveURL((url) => url.pathname === "/login");
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    await page.unroute(callbackPath, fulfill);
  }
});

test("Issue #115 R16: Chromium callback transport failure belongs to its observed request", async ({ page }) => {
  await page.goto("/login");
  const observer = createLoginAttemptNetworkEvidence(new URL(page.url()).origin);
  const callbackPath = "**/api/auth/callback/credentials";
  const abort = async (route: import("@playwright/test").Route) => {
    await route.abort("failed");
  };
  const onRequest = (request: import("@playwright/test").Request) => observer.onRequest(request);
  const onRequestFailed = (request: import("@playwright/test").Request) =>
    observer.onRequestFailed(request);
  page.on("request", onRequest);
  page.on("requestfailed", onRequestFailed);
  await page.route(callbackPath, abort);
  try {
    observer.begin();
    await page.evaluate(async () => {
      try {
        await fetch("/api/auth/callback/credentials", { method: "POST" });
      } catch {
        // Expected deliberate E2E-only transport fault; never log raw error.
      }
    });
    await expect.poll(() => observer.snapshot().phase).toBe("request_failed");
    expect(observer.snapshot()).toMatchObject({
      started: true, status: "none", transportFailed: true,
      trackingSaturated: false,
    });
    await expect(page).toHaveURL((url) => url.pathname === "/login");
  } finally {
    page.off("request", onRequest);
    page.off("requestfailed", onRequestFailed);
    await page.unroute(callbackPath, abort);
  }
});
