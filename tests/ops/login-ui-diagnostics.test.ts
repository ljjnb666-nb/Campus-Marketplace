import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginViaUI } from "../e2e/helpers/auth";

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
  callbackMode: "complete" | "pending" | "foreign" = "complete",
  mainFrameNavigation = false,
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
    } | null),
    goto: vi.fn(async () => undefined),
    locator: () => ({ first: () => ({ fill: async () => undefined }) }),
    getByRole: (_role: string, options: { name: string }) => ({
      click: async () => {
        if (options.name !== "登录") throw new Error("UNEXPECTED_BUTTON");
        if (mainFrameNavigation) {
          for (const cb of listeners.framenavigated) cb(mainFrame);
        }
        if (clickFailure) throw new Error("CLICK_PROBE");
        const callbackUrl = callbackMode === "foreign"
          ? "http://other.invalid/api/auth/callback/credentials"
          : "http://localhost:3000/api/auth/callback/credentials";
        for (const cb of listeners.request) cb({ url: () => callbackUrl });
        if (callbackMode !== "pending") {
          for (const cb of listeners.response) {
            cb({ url: () => callbackUrl, status: () => 302 });
          }
        }
      },
      isVisible: async () => options.name === "登录中...",
    }),
    getByText: () => ({ isVisible: async () => false }),
    url: () => navigation.redirected ? "http://localhost:3000/" : "http://localhost:3000/login",
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

describe("Issue #115 login timeout diagnostics", () => {
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
