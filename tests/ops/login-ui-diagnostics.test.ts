import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyLoginFailureEvidence, loginViaUI } from "../e2e/helpers/auth";
import { createLoginAttemptNetworkEvidence } from "../e2e/helpers/login-callback-evidence";

const navigation = vi.hoisted(() => ({ shouldFail: false, shouldFailReady: false, redirected: false }));
vi.mock("@playwright/test", () => ({
  expect: () => ({
    toHaveURL: async () => {
      if (navigation.shouldFail) throw new Error("URL_PROBE");
      navigation.redirected = true;
    },
    toBeVisible: async () => {
      if (navigation.shouldFailReady) throw new Error("READY_UI_PROBE");
    },
  }),
}));

function fixture(
  clickFailure: boolean,
  callbackMode: "complete" | "pending" | "foreign" | "none" = "complete",
  mainFrameNavigation = false,
  fillFailure = false,
  navigateFailure = false,
  beforeClickEvents: "none" | "callback" | "navigation" | "both" = "none",
) {
  type EventName = "request" | "response" | "requestfailed" | "framenavigated";
  const mainFrame = {};
  const listeners: Record<EventName, Set<(event: unknown) => void>> = {
    request: new Set(),
    response: new Set(),
    requestfailed: new Set(),
    framenavigated: new Set(),
  };
  let cookieScope: string | undefined;
  let beforeClickInjected = false;
  const page = {
    // The browser executes this script in /login; mock the installation only.
    addInitScript: vi.fn(async (_script: () => void) => undefined),
    mainFrame: vi.fn(() => mainFrame),
    evaluate: vi.fn(async () => null as {
      clicks: number;
      submits: number;
      preventedSubmits: number;
      pendingSeen: boolean;
      formCountAtClick: number;
      executed?: boolean;
    } | null),
    goto: vi.fn(async () => {
      if (navigateFailure) throw new Error("NAVIGATION_PROBE");
    }),
    locator: () => ({ first: () => ({ fill: async () => {
      if (fillFailure) throw new Error("FILL_PROBE");
      if (!beforeClickInjected && beforeClickEvents !== "none") {
        beforeClickInjected = true;
        if (beforeClickEvents === "callback" || beforeClickEvents === "both") {
          const priorRequest = { url: () => "http://localhost:3000/api/auth/callback/credentials" };
          for (const cb of listeners.request) cb(priorRequest);
          for (const cb of listeners.response) cb({
            request: () => priorRequest, status: () => 302,
          });
        }
        if (beforeClickEvents === "navigation" || beforeClickEvents === "both") {
          for (const cb of listeners.framenavigated) cb(mainFrame);
        }
      }
    } }) }),
    getByRole: (_role: string, options: { name: string }) => ({
      click: async () => {
        if (options.name !== "登录") throw new Error("UNEXPECTED_BUTTON");
        if (mainFrameNavigation) {
          for (const cb of listeners.framenavigated) cb(mainFrame);
        }
        if (clickFailure) throw new Error("CLICK_PROBE");
        if (callbackMode === "none") return;
        const callbackUrl = callbackMode === "foreign"
          ? "http://other.invalid/api/auth/callback/credentials"
          : "http://localhost:3000/api/auth/callback/credentials";
        const callbackRequest = { url: () => callbackUrl };
        for (const cb of listeners.request) cb(callbackRequest);
        if (callbackMode !== "pending") {
          for (const cb of listeners.response) {
            cb({ request: () => callbackRequest, url: () => callbackUrl, status: () => 302 });
          }
        }
      },
      isVisible: async () => options.name === "登录中...",
    }),
    getByText: () => ({ isVisible: async () => false }),
    url: (): string => navigation.redirected ? "http://localhost:3000/" : "http://localhost:3000/login",
    context: () => ({
      cookies: async (url: string) => {
        cookieScope = url;
        return [{ name: "next-auth.session-token", value: "SECRET_NEVER_LOG" }];
      },
    }),
    on: vi.fn((name: EventName, listener: (event: unknown) => void) => {
      listeners[name].add(listener);
    }),
    off: vi.fn((name: EventName, listener: (event: unknown) => void) => {
      listeners[name].delete(listener);
    }),
  };
  return { page, listeners, getCookieScope: () => cookieScope };
}

afterEach(() => {
  navigation.shouldFail = false;
  navigation.shouldFailReady = false;
  navigation.redirected = false;
  vi.restoreAllMocks();
});


describe("Issue #115 R16 scoped credentials callback lifecycle", () => {
  const origin = "http://localhost:3000";
  const request = (url = origin + "/api/auth/callback/credentials") => ({ url: () => url });
  const response = (r: ReturnType<typeof request>, status = 302) =>
    ({ request: () => r, status: () => status });

  it("does not attribute a callback request or its response from before the current click", () => {
    const observer = createLoginAttemptNetworkEvidence(origin);
    const earlier = request();
    observer.onRequest(earlier);
    observer.onResponse(response(earlier));
    observer.begin();
    expect(observer.snapshot()).toEqual({
      started: false, status: "none", transportFailed: false, phase: "not_observed",
      preAttemptSeen: true, orphanResponseSeen: true, trackingSaturated: false,
    });
  });

  it("accepts a callback only after arming and correlates its exact response request object", () => {
    const observer = createLoginAttemptNetworkEvidence(origin);
    observer.begin();
    const current = request();
    observer.onRequest(current);
    observer.onResponse(response(request(), 500)); // same URL, different request
    expect(observer.snapshot()).toMatchObject({
      started: true, status: "none", phase: "request_pending", orphanResponseSeen: true,
    });
    observer.onResponse(response(current, 302));
    expect(observer.snapshot()).toMatchObject({
      started: true, status: "3xx", transportFailed: false, phase: "response_observed",
    });
  });

  it("cannot manufacture positive callback evidence from an orphan response alone", () => {
    const observer = createLoginAttemptNetworkEvidence(origin);
    observer.begin();
    observer.onResponse(response(request(), 200));
    expect(observer.snapshot()).toMatchObject({
      started: false, status: "none", phase: "not_observed", orphanResponseSeen: true,
    });
  });

  it("tracks failed request identity rather than an unrelated same-path failure", () => {
    const observer = createLoginAttemptNetworkEvidence(origin);
    observer.begin();
    const current = request();
    observer.onRequest(current);
    observer.onRequestFailed(request());
    expect(observer.snapshot()).toMatchObject({
      started: true, transportFailed: false, phase: "request_pending",
    });
    observer.onRequestFailed(current);
    expect(observer.snapshot()).toMatchObject({
      started: true, transportFailed: true, phase: "request_failed",
    });
  });

  it("reports pending and mixed results without treating a pending request as completed", () => {
    const observer = createLoginAttemptNetworkEvidence(origin);
    observer.begin();
    const first = request();
    const second = request();
    observer.onRequest(first);
    observer.onRequest(second);
    observer.onResponse(response(first, 401));
    expect(observer.snapshot()).toMatchObject({ status: "4xx", phase: "request_pending" });
    observer.onRequestFailed(second);
    expect(observer.snapshot()).toMatchObject({
      status: "4xx", transportFailed: true, phase: "mixed_outcomes",
    });
  });

  it("does not present the last response class as authoritative when multiple callbacks disagree", () => {
    const observer = createLoginAttemptNetworkEvidence(origin);
    observer.begin();
    const first = request();
    const second = request();
    observer.onRequest(first);
    observer.onRequest(second);
    observer.onResponse(response(first, 200));
    observer.onResponse(response(second, 401));
    expect(observer.snapshot()).toMatchObject({
      started: true, status: "mixed", phase: "response_observed",
    });
  });

  it("ignores foreign origin, lookalike path, and malformed URLs", () => {
    const observer = createLoginAttemptNetworkEvidence(origin);
    observer.begin();
    for (const r of [
      request("http://elsewhere.invalid/api/auth/callback/credentials"),
      request(origin + "/api/auth/callback/credentials-other"),
      request("not-a-url"),
    ]) {
      observer.onRequest(r);
      observer.onResponse(response(r));
      observer.onRequestFailed(r);
    }
    expect(observer.snapshot()).toMatchObject({
      started: false, status: "none", preAttemptSeen: false,
      orphanResponseSeen: false, phase: "not_observed",
    });
  });

  it("bounds request tracking rather than retaining unbounded callback identities", () => {
    const observer = createLoginAttemptNetworkEvidence(origin);
    observer.begin();
    for (let i = 0; i < 10; i++) observer.onRequest(request());
    expect(observer.snapshot()).toMatchObject({
      started: true, status: "none", phase: "tracking_saturated",
      trackingSaturated: true,
    });
  });

  it("deduplicates duplicate request and response notifications", () => {
    const observer = createLoginAttemptNetworkEvidence(origin);
    observer.begin();
    const current = request();
    observer.onRequest(current);
    observer.onRequest(current);
    observer.onResponse(response(current, 200));
    observer.onResponse(response(current, 500));
    expect(observer.snapshot()).toMatchObject({
      started: true, status: "2xx", phase: "response_observed",
      trackingSaturated: false,
    });
  });
});

describe("Issue #115 R15 bounded login event evidence", () => {
  it.each([
    { label: "callback evidence", callback: true, navigated: false, probe: { executed: false, clicks: 0, submits: 0 }, expected: "callback_observed" },
    { label: "document replaced", callback: false, navigated: true, probe: { executed: true, clicks: 1, submits: 1 }, expected: "document_replaced" },
    { label: "probe absent", callback: false, navigated: false, probe: null, expected: "probe_unobserved" },
    { label: "probe incomplete", callback: false, navigated: false, probe: { executed: false, clicks: 0, submits: 0 }, expected: "probe_incomplete" },
    { label: "native submit only", callback: false, navigated: false, probe: { executed: true, clicks: 1, submits: 1 }, expected: "native_submit_observed_no_callback" },
    { label: "native click only", callback: false, navigated: false, probe: { executed: true, clicks: 1, submits: 0 }, expected: "native_click_observed_no_submit" },
    { label: "no recorded interaction", callback: false, navigated: false, probe: { executed: true, clicks: 0, submits: 0 }, expected: "native_interaction_unobserved" },
  ])("distinguishes $label without assigning cause", ({ callback, navigated, probe, expected }) => {
    expect(classifyLoginFailureEvidence(callback, navigated, probe)).toBe(expected);
  });
});

describe("Issue #115 login timeout diagnostics", () => {
  it("diagnoses failed init-script registration without manufacturing callback evidence", async () => {
    const { page, listeners } = fixture(false);
    const injected = new Error("INIT_SCRIPT_PROBE private@example.test SECRET_PASSWORD SECRET_NEVER_LOG");
    page.addInitScript.mockRejectedValueOnce(injected);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(loginViaUI(
      page as unknown as Page,
      "private@example.test",
      "SECRET_PASSWORD",
      "SECRET_DISPLAY_NAME",
    )).rejects.toBe(injected);

    expect(page.addInitScript).toHaveBeenCalledTimes(1);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.on).not.toHaveBeenCalled();
    expect(page.off).not.toHaveBeenCalled();
    for (const registered of Object.values(listeners)) expect(registered.size).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "LOGIN_E2E_DIAG stage=init-script path=unknown callback_started=unknown callback_status=unknown native_main_frame_navigated=unknown",
    );
    const message = String(log.mock.calls[0]?.[0]);
    for (const sensitive of [
      "private@example.test", "SECRET_PASSWORD", "SECRET_DISPLAY_NAME",
      "SECRET_NEVER_LOG", "INIT_SCRIPT_PROBE",
    ]) expect(message).not.toContain(sensitive);
  });

  it("does not mark a failed init-script installation as complete on retry", async () => {
    const { page, listeners } = fixture(false);
    const injected = new Error("INIT_SCRIPT_FIRST_FAILURE");
    page.addInitScript.mockRejectedValueOnce(injected);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(loginViaUI(page as unknown as Page, "private@example.test", "SECRET_PASSWORD", "Reviewer"))
      .rejects.toBe(injected);
    expect(page.goto).not.toHaveBeenCalled();
    await loginViaUI(page as unknown as Page, "private@example.test", "SECRET_PASSWORD", "Reviewer");

    expect(page.addInitScript).toHaveBeenCalledTimes(2);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.on).toHaveBeenCalledTimes(4);
    expect(page.off).toHaveBeenCalledTimes(4);
    for (const registered of Object.values(listeners)) expect(registered.size).toBe(0);
    expect(navigation.redirected).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "LOGIN_E2E_DIAG stage=init-script path=unknown callback_started=unknown callback_status=unknown native_main_frame_navigated=unknown",
    );
  });

  it("classifies failed initial /login navigation as unknown callback, not false zero", async () => {
    const { page, listeners } = fixture(false, "complete", false, false, true);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(
      page as unknown as Page,
      "private@example.test",
      "SECRET_PASSWORD",
      "SECRET_DISPLAY_NAME",
    )).rejects.toThrow("NAVIGATION_PROBE");

    expect(page.addInitScript).toHaveBeenCalledTimes(1);
    expect(page.on).not.toHaveBeenCalled();
    expect(page.off).not.toHaveBeenCalled();
    for (const registered of Object.values(listeners)) expect(registered.size).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toBe(
      "LOGIN_E2E_DIAG stage=navigate path=login callback_started=unknown callback_status=unknown native_main_frame_navigated=unknown",
    );
    for (const sensitive of ["private@example.test", "SECRET_PASSWORD", "SECRET_DISPLAY_NAME", "SECRET_NEVER_LOG"]) {
      expect(message).not.toContain(sensitive);
    }
  });

  it("uses unknown path for a failed navigation from an about:blank document", async () => {
    const { page, listeners } = fixture(false, "complete", false, false, true);
    page.url = vi.fn(() => "about:blank");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(
      page as unknown as Page,
      "private@example.test",
      "SECRET_PASSWORD",
      "Reviewer",
    )).rejects.toThrow("NAVIGATION_PROBE");

    expect(log).toHaveBeenCalledWith(
      "LOGIN_E2E_DIAG stage=navigate path=unknown callback_started=unknown callback_status=unknown native_main_frame_navigated=unknown",
    );
    expect(page.on).not.toHaveBeenCalled();
    expect(page.off).not.toHaveBeenCalled();
    for (const registered of Object.values(listeners)) expect(registered.size).toBe(0);
  });

  it("logs a bounded fill-stage classification and cleans up all listeners", async () => {
    const { page, listeners } = fixture(false, "complete", false, true);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(
      page as unknown as Page,
      "private@example.test",
      "SECRET_PASSWORD",
      "SECRET_DISPLAY_NAME",
    )).rejects.toThrow("FILL_PROBE");
    expect(page.off).toHaveBeenCalledTimes(4);
    expect(listeners.request.size).toBe(0);
    expect(listeners.response.size).toBe(0);
    expect(listeners.requestfailed.size).toBe(0);
    expect(listeners.framenavigated.size).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("LOGIN_E2E_DIAG stage=fill path=login");
    expect(message).toContain("callback_started=0 callback_status=none");
    for (const sensitive of ["private@example.test", "SECRET_PASSWORD", "SECRET_DISPLAY_NAME", "SECRET_NEVER_LOG"]) {
      expect(message).not.toContain(sensitive);
    }
  });

  it("unbinds callbacks even when the login click fails, without leaking input", async () => {
    const { page, listeners } = fixture(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(page as unknown as Page, "private@example.test", "SECRET_PASSWORD", "Reviewer"))
      .rejects.toThrow("CLICK_PROBE");
    expect(page.off).toHaveBeenCalledTimes(4);
    expect(listeners.request.size).toBe(0);
    expect(listeners.response.size).toBe(0);
    expect(listeners.requestfailed.size).toBe(0);
    expect(listeners.framenavigated.size).toBe(0);
    const message = String(log.mock.calls[0]?.[0]);
    expect(page.addInitScript).toHaveBeenCalledTimes(1);
    expect(message).toContain("LOGIN_E2E_DIAG stage=submit path=login");
    expect(message).toContain("native_clicks=unknown native_submits=unknown");
    expect(message).toContain("native_main_frame_navigated=0");
    expect(message).not.toContain("private@example.test");
    expect(message).not.toContain("SECRET_PASSWORD");
    expect(message).not.toContain("SECRET_NEVER_LOG");
  });

  it("classifies a callback on URL timeout and queries only current-origin cookies", async () => {
    navigation.shouldFail = true;
    const { page, listeners, getCookieScope } = fixture(false);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(page as unknown as Page, "private@example.test", "SECRET_PASSWORD", "Reviewer"))
      .rejects.toThrow("URL_PROBE");
    expect(page.off).toHaveBeenCalledTimes(4);
    expect(listeners.request.size).toBe(0);
    expect(listeners.response.size).toBe(0);
    expect(listeners.requestfailed.size).toBe(0);
    expect(listeners.framenavigated.size).toBe(0);
    expect(getCookieScope()).toBe("http://localhost:3000/login");
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("stage=redirect path=login");
    expect(message).toContain("login_event_relation=callback_observed");
    expect(message).toContain("callback_started=1 callback_status=3xx callback_transport_failed=0 session_cookie_present=1");
    expect(message).not.toContain("SECRET_NEVER_LOG");
    expect(message).not.toContain("private@example.test");
    expect(message).not.toContain("SECRET_PASSWORD");
  });
  it("distinguishes an in-flight credentials callback from no callback", async () => {
    navigation.shouldFail = true;
    const { page, listeners } = fixture(false, "pending");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(page as unknown as Page, "private@example.test", "SECRET_PASSWORD", "Reviewer"))
      .rejects.toThrow("URL_PROBE");
    expect(page.off).toHaveBeenCalledTimes(4);
    expect(listeners.request.size).toBe(0);
    expect(listeners.response.size).toBe(0);
    expect(listeners.requestfailed.size).toBe(0);
    expect(listeners.framenavigated.size).toBe(0);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("callback_started=1 callback_status=none callback_transport_failed=0");
    expect(message).not.toContain("private@example.test");
    expect(message).not.toContain("SECRET_PASSWORD");
  });

  it("ignores matching callback paths on unrelated origins", async () => {
    navigation.shouldFail = true;
    const { page, listeners } = fixture(false, "foreign");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(page as unknown as Page, "private@example.test", "SECRET_PASSWORD", "Reviewer"))
      .rejects.toThrow("URL_PROBE");
    expect(page.off).toHaveBeenCalledTimes(4);
    expect(listeners.request.size).toBe(0);
    expect(listeners.response.size).toBe(0);
    expect(listeners.requestfailed.size).toBe(0);
    expect(listeners.framenavigated.size).toBe(0);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("callback_started=0 callback_status=none callback_transport_failed=0");
    expect(message).not.toContain("other.invalid");
    expect(message).not.toContain("private@example.test");
    expect(message).not.toContain("SECRET_PASSWORD");
  });

  it("emits only bounded native signal classifications on an observed failure", async () => {
    navigation.shouldFail = true;
    const { page } = fixture(false, "pending");
    page.evaluate.mockResolvedValueOnce({
      clicks: 1,
      submits: 1,
      preventedSubmits: 1,
      pendingSeen: true,
      formCountAtClick: 1,
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(page as unknown as Page, "private@example.test", "SECRET_PASSWORD", "Reviewer"))
      .rejects.toThrow("URL_PROBE");
    expect(page.addInitScript).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("native_clicks=1 native_submits=1 native_submit_prevented=1");
    expect(message).toContain("native_pending_seen=1 native_forms_at_click=1 native_main_frame_navigated=0");
    expect(message).not.toContain("private@example.test");
    expect(message).not.toContain("SECRET_PASSWORD");
    expect(message).not.toContain("SECRET_NEVER_LOG");
  });

  it.each([
    { installed: true, expected: "probe_executed=1" },
    { installed: false, expected: "probe_executed=0" },
  ])("identifies completed browser probe execution from an observable document: $expected", async ({ installed, expected }) => {
    navigation.shouldFail = true;
    const { page, listeners } = fixture(false, "none");
    page.evaluate.mockResolvedValueOnce({
      executed: installed,
      clicks: 0,
      submits: 0,
      preventedSubmits: 0,
      pendingSeen: false,
      formCountAtClick: -1,
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(
      page as unknown as Page,
      "private@example.test",
      "SECRET_PASSWORD",
      "SECRET_DISPLAY_NAME",
    )).rejects.toThrow("URL_PROBE");
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.off).toHaveBeenCalledTimes(4);
    for (const registered of Object.values(listeners)) expect(registered.size).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain(expected);
    expect(message).toContain("callback_started=0 callback_status=none");
    expect(message).toContain("native_clicks=0 native_submits=0");
    for (const secret of ["private@example.test", "SECRET_PASSWORD", "SECRET_DISPLAY_NAME", "SECRET_NEVER_LOG"]) {
      expect(message).not.toContain(secret);
    }
  });

  it("keeps probe execution unknown when page evaluation cannot observe a probe", async () => {
    navigation.shouldFail = true;
    const { page } = fixture(false, "none");
    page.evaluate.mockRejectedValueOnce(new Error("PAGE_UNAVAILABLE_SECRET_NEVER_LOG"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(page as unknown as Page, "private@example.test", "SECRET_PASSWORD", "Reviewer"))
      .rejects.toThrow("URL_PROBE");
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("login_event_relation=probe_unobserved");
    expect(message).toContain("probe_executed=unknown");
    expect(message).toContain("native_clicks=unknown native_submits=unknown");
    expect(message).not.toContain("PAGE_UNAVAILABLE_SECRET_NEVER_LOG");
  });

  it("reports unknown instead of false zero when navigation replaces the observed document", async () => {
    navigation.shouldFail = true;
    const { page, listeners } = fixture(false, "pending", true);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(page as unknown as Page, "private@example.test", "SECRET_PASSWORD", "Reviewer"))
      .rejects.toThrow("URL_PROBE");
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(page.off).toHaveBeenCalledTimes(4);
    expect(listeners.framenavigated.size).toBe(0);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("native_clicks=unknown native_submits=unknown");
    expect(message).toContain("native_submit_prevented=unknown native_pending_seen=unknown");
    expect(message).toContain("native_main_frame_navigated=1");
    expect(message).not.toContain("private@example.test");
    expect(message).not.toContain("SECRET_PASSWORD");
  });

  it("diagnoses authenticated UI readiness failure after successful URL redirect", async () => {
    navigation.shouldFailReady = true;
    const { page, listeners } = fixture(false);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(
      page as unknown as Page,
      "private@example.test",
      "SECRET_PASSWORD",
      "SECRET_DISPLAY_NAME",
    )).rejects.toThrow("READY_UI_PROBE");

    expect(page.off).toHaveBeenCalledTimes(4);
    expect(listeners.request.size).toBe(0);
    expect(listeners.response.size).toBe(0);
    expect(listeners.requestfailed.size).toBe(0);
    expect(listeners.framenavigated.size).toBe(0);
    expect(navigation.redirected).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("LOGIN_E2E_DIAG stage=ready-ui path=other");
    expect(message).toContain("callback_started=1 callback_status=3xx callback_transport_failed=0");
    expect(message).toContain("session_cookie_present=1");
    expect(message).not.toContain("private@example.test");
    expect(message).not.toContain("SECRET_PASSWORD");
    expect(message).not.toContain("SECRET_DISPLAY_NAME");
    expect(message).not.toContain("SECRET_NEVER_LOG");
  });

  it.each([
    {
      label: "click without native submit",
      native: { executed: true, clicks: 1, submits: 0, preventedSubmits: 0, pendingSeen: false, formCountAtClick: 1 },
      expected: "native_clicks=1 native_submits=0 native_submit_prevented=0",
    },
    {
      label: "native submit prevented without callback",
      native: { executed: true, clicks: 1, submits: 1, preventedSubmits: 1, pendingSeen: true, formCountAtClick: 2 },
      expected: "native_clicks=1 native_submits=1 native_submit_prevented=1",
    },
  ])("preserves separate callback_started=0 and native signals: $label", async ({ native, expected }) => {
    navigation.shouldFail = true;
    const { page, listeners } = fixture(false, "none");
    page.evaluate.mockResolvedValueOnce(native);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(loginViaUI(
      page as unknown as Page,
      "private@example.test",
      "SECRET_PASSWORD",
      "SECRET_DISPLAY_NAME",
    )).rejects.toThrow("URL_PROBE");

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.off).toHaveBeenCalledTimes(4);
    expect(listeners.request.size).toBe(0);
    expect(listeners.response.size).toBe(0);
    expect(listeners.requestfailed.size).toBe(0);
    expect(listeners.framenavigated.size).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);

    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("LOGIN_E2E_DIAG stage=redirect path=login");
    expect(message).toContain(
      "callback_started=0 callback_status=none callback_transport_failed=0",
    );
    expect(message).toContain(expected);
    expect(message).toContain(`login_event_relation=${native.submits > 0 ? "native_submit_observed_no_callback" : "native_click_observed_no_submit"}`);
    expect(message).toContain(`native_forms_at_click=${native.formCountAtClick}`);
    expect(message).toContain("native_main_frame_navigated=0");
    expect(message).not.toContain("private@example.test");
    expect(message).not.toContain("SECRET_PASSWORD");
    expect(message).not.toContain("SECRET_DISPLAY_NAME");
    expect(message).not.toContain("SECRET_NEVER_LOG");
  });

  it("does not attribute a prior-fill callback or navigation to this helper's click window", async () => {
    navigation.shouldFail = true;
    const { page, listeners } = fixture(false, "none", false, false, false, "both");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loginViaUI(
      page as unknown as Page,
      "private@example.test",
      "SECRET_PASSWORD",
      "Reviewer",
    )).rejects.toThrow("URL_PROBE");

    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("callback_started=0 callback_status=none callback_transport_failed=0");
    expect(message).toContain("native_main_frame_navigated=0");
    expect(message).toContain("callback_phase=not_observed");
    expect(message).toContain("callback_pre_attempt_seen=1");
    expect(message).toContain("callback_orphan_response_seen=1");
    expect(message).not.toContain("private@example.test");
    expect(message).not.toContain("SECRET_PASSWORD");
    for (const registered of Object.values(listeners)) expect(registered.size).toBe(0);
  });

  it("does not emit an error diagnostic when redirect and authenticated UI both succeed", async () => {
    const { page, listeners } = fixture(false);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await loginViaUI(page as unknown as Page, "private@example.test", "SECRET_PASSWORD", "Reviewer");

    expect(navigation.redirected).toBe(true);
    expect(page.off).toHaveBeenCalledTimes(4);
    expect(listeners.request.size).toBe(0);
    expect(listeners.response.size).toBe(0);
    expect(listeners.requestfailed.size).toBe(0);
    expect(listeners.framenavigated.size).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

});
