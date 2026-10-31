import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { createLoginAttemptNetworkEvidence } from "./login-callback-evidence";

/**
 * Issue #115 R7: a passive per-document signal probe. It records only bounded
 * event counts and boolean UI transitions, never field values or request data.
 * Install before /login loads so clicking before hydration is observable too.
 */
export function installLoginProbeOnDocument(): void {
  if (window.location.pathname !== "/login") return;
  const probe = {
    installed: false,
    clicks: 0,
    submits: 0,
    preventedSubmits: 0,
    pendingSeen: false,
    formCountAtClick: -1,
  };
  (window as Window & { __campusE2ELoginProbe?: typeof probe }).__campusE2ELoginProbe = probe;
  const isCredentialForm = (form: HTMLFormElement | null) =>
    !!form?.querySelector('input[name="email"]') &&
    !!form.querySelector('input[name="password"]');
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button[type="submit"]');
    if (!button || !isCredentialForm(button.closest("form"))) return;
    probe.clicks = Math.min(probe.clicks + 1, 9);
    probe.formCountAtClick = Math.min(
      [...document.querySelectorAll("form")].filter(isCredentialForm).length,
      9,
    );
  }, true);
  document.addEventListener("submit", (event) => {
    if (!(event.target instanceof HTMLFormElement) ||
        !isCredentialForm(event.target)) return;
    probe.submits = Math.min(probe.submits + 1, 9);
    // Observe React's preventDefault after event dispatch without changing it.
    queueMicrotask(() => {
      if (event.defaultPrevented) {
        probe.preventedSubmits = Math.min(probe.preventedSubmits + 1, 9);
      }
    });
  }, true);
  const inspectPending = () => {
    if ([...document.querySelectorAll('form button[type="submit"]')].some(
      (button) => button.textContent?.trim() === "登录中..." &&
        (button as HTMLButtonElement).disabled,
    )) probe.pendingSeen = true;
  };
  new MutationObserver(inspectPending).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  probe.installed = true;
}


/**
 * Bounded observed event relationship, never a root-cause verdict.
 * Positive network evidence outranks absent or replaced DOM observations.
 */
export function classifyLoginFailureEvidence(
  callbackObserved: boolean,
  mainFrameNavigated: boolean,
  nativeSignals: { executed?: boolean; clicks: number; submits: number } | null,
):
  | "callback_observed"
  | "document_replaced"
  | "probe_unobserved"
  | "probe_incomplete"
  | "native_submit_observed_no_callback"
  | "native_click_observed_no_submit"
  | "native_interaction_unobserved" {
  if (callbackObserved) return "callback_observed";
  if (mainFrameNavigated) return "document_replaced";
  if (nativeSignals?.executed === false) return "probe_incomplete";
  if (nativeSignals?.executed !== true) return "probe_unobserved";
  if (nativeSignals.submits > 0) return "native_submit_observed_no_callback";
  if (nativeSignals.clicks > 0) return "native_click_observed_no_submit";
  return "native_interaction_unobserved";
}

const loginProbeInstalled = new WeakSet<Page>();

/**
 * 真实 UI 登录：走 /login 表单 → NextAuth credentials → JWT session。
 * storageState 由 auth-setup 在测试运行时生成，禁止提交任何 cookie。
 *
 * @param expectedName 登录后顶栏用户菜单按钮应显示的昵称
 */
export async function loginViaUI(
  page: Page,
  email: string,
  password: string,
  expectedName: string,
): Promise<void> {
  if (!loginProbeInstalled.has(page)) {
    try {
      await page.addInitScript(installLoginProbeOnDocument);
    } catch (error) {
      // No login navigation or callback listener exists at this stage.
      // Failed registration does not prove that the browser probe ran.
      // Do not log the browser's error, URL, credentials or session values.
      console.error(
        "LOGIN_E2E_DIAG stage=init-script path=unknown callback_started=unknown callback_status=unknown native_main_frame_navigated=unknown",
      );
      throw error;
    }
    loginProbeInstalled.add(page);
  }
  try {
    await page.goto("/login");
  } catch (error) {
    // No callback listeners exist until /login has loaded. In this stage
    // absence of a recorded callback must be UNKNOWN, never a false zero.
    // Classify only the current path; never log a URL, credentials or tokens.
    const path = (() => {
      try {
        const current = new URL(page.url());
        if (current.protocol !== "http:" && current.protocol !== "https:") return "unknown";
        return current.pathname.startsWith("/login") ? "login" : "other";
      } catch {
        return "unknown";
      }
    })();
    console.error(
      `LOGIN_E2E_DIAG stage=navigate path=${path} callback_started=unknown callback_status=unknown native_main_frame_navigated=unknown`,
    );
    throw error;
  }
  const loginOrigin = new URL(page.url()).origin;
  const callbackEvidence = createLoginAttemptNetworkEvidence(loginOrigin);
  // A native submission before hydration can replace the entire document.
  // The new document would reset window probe counters: never report that as zero.
  let mainFrameNavigated = false;
  const onMainFrameNavigated = (frame: import("@playwright/test").Frame) => {
    // Ignore navigation before this helper's actual submit attempt.
    if (callbackEvidence.isArmed() && frame === page.mainFrame()) mainFrameNavigated = true;
  };
  const onRequest = (request: import("@playwright/test").Request) => {
    callbackEvidence.onRequest(request);
  };
  const onResponse = (response: import("@playwright/test").Response) => {
    callbackEvidence.onResponse(response);
  };
  const onRequestFailed = (request: import("@playwright/test").Request) => {
    callbackEvidence.onRequestFailed(request);
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  page.on("framenavigated", onMainFrameNavigated);
  let loginStage: "fill" | "submit" | "redirect" | "ready-ui" = "fill";
  // 登录使用 window.location.href，但 URL 变化不等于全页 load 已结束。
  // 对 URL 做自动重试断言而非等待所有资源加载；成功仍由角色专属菜单证明。
  // 真实认证失败或 URL 不变仍会超时，不提高超时或 Playwright retry。
  // 包含 click() 在内的每个 await 都必须受 finally 保护，以免泄露监听器。
  try {
    await page.locator('input[name="email"]').first().fill(email);
    await page.locator('input[name="password"]').first().fill(password);
    loginStage = "submit";
    // Arm immediately before clicking, after fields are filled. Earlier and
    // unmatched callback events cannot be attributed to this login attempt.
    callbackEvidence.begin();
    await page.getByRole("button", { name: "登录" }).click();
    loginStage = "redirect";
    await expect(page).toHaveURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });
    // URL change is not sufficient: the role-specific authenticated UI must appear.
    // Keep the same diagnostic listeners active until this final assertion settles.
    loginStage = "ready-ui";
    await expect(page.getByRole("button", { name: expectedName })).toBeVisible();
  } catch (error) {
    // Issue #115: only bounded, non-sensitive state classifications on failure.
    // Never log email, password, cookies, URLs, response bodies, or token values.
    const loginPath = (() => {
      try {
        return new URL(page.url()).pathname.startsWith("/login") ? "login" : "other";
      } catch {
        return "unknown";
      }
    })();
    const pending = await page.getByRole("button", { name: "登录中..." })
      .isVisible().catch(() => false);
    const invalidCredentials = await page.getByText("邮箱、密码或动态验证码错误", { exact: true })
      .isVisible().catch(() => false);
    const sessionCookiePresent = await page.context().cookies(page.url())
      .then((cookies) => cookies.some((cookie) =>
        /^(?:__Secure-)?(?:next-auth|authjs)\.session-token(?:\.\d+)?$/.test(cookie.name)))
      .catch(() => false);
    const nativeSignals = mainFrameNavigated ? null : await page.evaluate(() => {
      const probe = (window as Window & { __campusE2ELoginProbe?: {
        clicks: number;
        submits: number;
        preventedSubmits: number;
        pendingSeen: boolean;
        formCountAtClick: number;
        installed: boolean;
      } }).__campusE2ELoginProbe;
      return probe ? {
        executed: probe.installed === true,
        clicks: probe.clicks,
        submits: probe.submits,
        preventedSubmits: probe.preventedSubmits,
        pendingSeen: probe.pendingSeen,
        formCountAtClick: probe.formCountAtClick,
      } : null;
    }).catch(() => null);
    // Join scoped network events and bounded in-document native evidence.
    // Do not infer historical root cause, user identity, or credentials.
    const callback = callbackEvidence.snapshot();
    const loginEventRelation = classifyLoginFailureEvidence(
      callback.started || callback.status !== "none" || callback.transportFailed,
      mainFrameNavigated,
      nativeSignals,
    );
    // If the main frame navigated, its new probe starts from zero: report unknown.
    // Unknown is distinct from zero (page/context may have navigated away).
    console.error(
      `LOGIN_E2E_DIAG stage=${loginStage} path=${loginPath} pending=${pending ? 1 : 0} invalid_credentials=${invalidCredentials ? 1 : 0} callback_started=${callback.started ? 1 : 0} callback_status=${callback.status} callback_transport_failed=${callback.transportFailed ? 1 : 0} session_cookie_present=${sessionCookiePresent ? 1 : 0} login_event_relation=${loginEventRelation} probe_executed=${nativeSignals?.executed === true ? 1 : nativeSignals?.executed === false ? 0 : "unknown"} native_clicks=${nativeSignals?.clicks ?? "unknown"} native_submits=${nativeSignals?.submits ?? "unknown"} native_submit_prevented=${nativeSignals?.preventedSubmits ?? "unknown"} native_pending_seen=${nativeSignals ? Number(nativeSignals.pendingSeen) : "unknown"} native_forms_at_click=${nativeSignals?.formCountAtClick ?? "unknown"} native_main_frame_navigated=${mainFrameNavigated ? 1 : 0} callback_phase=${callback.phase} callback_pre_attempt_seen=${Number(callback.preAttemptSeen)} callback_orphan_response_seen=${Number(callback.orphanResponseSeen)} callback_tracking_saturated=${Number(callback.trackingSaturated)}`,
    );
    throw error;
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
    page.off("framenavigated", onMainFrameNavigated);
  }
}

/** 真实 UI 登出：点开用户菜单 → 退出登录 → 回到 /login */
export async function logoutViaUI(page: Page, userName: string): Promise<void> {
  await page.getByRole("button", { name: userName }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 15_000 });
}
