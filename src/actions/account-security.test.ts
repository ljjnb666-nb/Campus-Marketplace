import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginMfaAction, completeChallengeAction, confirmMfaAction, requestEmailVerificationAction, requestPasswordResetAction } from "./account-recovery";
import { changePasswordAction, revokeSessionsAction } from "./account-sessions";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), headers: vi.fn(), revalidate: vi.fn(), request: vi.fn(), complete: vi.fn(),
  begin: vi.fn(), confirm: vi.fn(), change: vi.fn(), revoke: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/server-auth", () => ({ requireVerifiedPageUser: mocks.user }));
vi.mock("@/lib/account-challenge-service", () => ({ requestAccountChallenge: mocks.request, completeAccountChallenge: mocks.complete }));
vi.mock("@/lib/account-mfa-service", () => ({ beginMfaSetup: mocks.begin, confirmMfa: mocks.confirm }));
vi.mock("@/lib/account-session-service", () => ({ changeOwnPassword: mocks.change, revokeOwnSessions: mocks.revoke }));
const initial = { success: false, message: "" };
function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "owner", email: "owner@example.test", sessionId: "current-session" });
  mocks.headers.mockResolvedValue(new Headers({ "x-real-ip": "192.0.2.9" }));
  mocks.begin.mockResolvedValue("TEST-ONLY-SETUP-SECRET");
});

describe("account security action boundaries", () => {
  it("requests recovery without revealing whether the address exists", async () => {
    const known = await requestPasswordResetAction(initial, form({ email: " owner@example.test " }));
    const unknown = await requestPasswordResetAction(initial, form());
    expect(known).toEqual(unknown);
    expect(mocks.request).toHaveBeenNthCalledWith(1, "owner@example.test", "RESET_PASSWORD", "192.0.2.9");
    expect(mocks.request).toHaveBeenNthCalledWith(2, "", "RESET_PASSWORD", "192.0.2.9");
    // An existing account may reach provider/DB code that an unknown address
    // never touches. Public results must stay indistinguishable even then.
    mocks.request.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_DETAIL"));
    const providerFailure = await requestPasswordResetAction(initial, form({ email: "owner@example.test" }));
    expect(providerFailure).toEqual(known);
    expect(providerFailure.message).not.toContain("PRIVATE_PROVIDER_DETAIL");
    mocks.request.mockRejectedValueOnce(new Error("PRIVATE_DATABASE_DETAIL"));
    const databaseFailure = await requestPasswordResetAction(initial, form({ email: "owner@example.test" }));
    expect(databaseFailure).toEqual(unknown);
  });
  it("binds verification to the authenticated email and preserves auth failures", async () => {
    expect((await requestEmailVerificationAction()).success).toBe(true);
    expect(mocks.request).toHaveBeenCalledWith("owner@example.test", "VERIFY_EMAIL", "192.0.2.9");
    mocks.request.mockRejectedValueOnce(new Error("PRIVATE_TOKEN"));
    expect((await requestEmailVerificationAction()).message).not.toContain("PRIVATE_TOKEN");
    mocks.user.mockRejectedValueOnce(new Error("AUTH_REQUIRED"));
    await expect(requestEmailVerificationAction()).rejects.toThrow("AUTH_REQUIRED");
  });
  it("rejects malformed purposes and mismatching passwords before consuming a challenge", async () => {
    expect((await completeChallengeAction(initial, form())).success).toBe(false);
    expect((await completeChallengeAction(initial, form({ purpose: "RESET_PASSWORD", newPassword: "a", confirmPassword: "b" }))).success).toBe(false);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it.each(["VERIFY_EMAIL", "RESET_PASSWORD"])("forwards %s proof with its source and hides internal errors", async (purpose) => {
    const data = form({ purpose, id: "challenge", token: "bearer", newPassword: "NewPassword123", confirmPassword: "NewPassword123", mfaCode: "123456" });
    expect((await completeChallengeAction(initial, data)).success).toBe(true);
    expect(mocks.complete).toHaveBeenCalledWith({ purpose, id: "challenge", token: "bearer", newPassword: "NewPassword123", mfaCode: "123456" }, "192.0.2.9");
    expect(mocks.revalidate).toHaveBeenCalledWith("/my/security");
    mocks.complete.mockRejectedValueOnce(new Error("PRIVATE_TOKEN"));
    const failure = await completeChallengeAction(initial, data);
    expect(failure.success).toBe(false);
    expect(failure.message).not.toContain("PRIVATE_TOKEN");
  });
  it("passes missing proof as empty values for domain validation, never inventing proof", async () => {
    mocks.complete.mockRejectedValue(new Error("INVALID_PROOF"));
    await completeChallengeAction(initial, form({ purpose: "VERIFY_EMAIL" }));
    expect(mocks.complete).toHaveBeenCalledWith({ purpose: "VERIFY_EMAIL", id: "", token: "", newPassword: "", mfaCode: "" }, "192.0.2.9");
  });
  it("requires a current session for enrollment and returns secrets only on success", async () => {
    expect((await beginMfaAction(initial, form({ password: "current-password", userId: "attacker" }))).setupSecret).toBe("TEST-ONLY-SETUP-SECRET");
    expect(mocks.begin).toHaveBeenCalledWith("owner", "current-session", "current-password");
    mocks.begin.mockRejectedValueOnce(new Error("PRIVATE_SECRET"));
    expect(await beginMfaAction(initial, form())).not.toHaveProperty("setupSecret");
    mocks.user.mockResolvedValueOnce({ id: "owner" });
    expect((await beginMfaAction(initial, form())).success).toBe(false);
    expect(mocks.begin).toHaveBeenCalledTimes(2);
  });
  it.each(["ENABLE", "STEP_UP", "DISABLE"])("binds MFA %s to server identity", async (mode) => {
    expect((await confirmMfaAction(initial, form({ mode, code: "123456", userId: "attacker", sessionId: "forged" }))).success).toBe(true);
    expect(mocks.confirm).toHaveBeenCalledWith("owner", "current-session", "123456", mode);
    mocks.confirm.mockRejectedValueOnce(new Error("PRIVATE_DETAIL"));
    const rejected = await confirmMfaAction(initial, form({ mode }));
    expect(rejected.success).toBe(false);
    expect(rejected.message).not.toContain("PRIVATE_DETAIL");
  });
  it("rejects unknown MFA operations and missing sessions", async () => {
    expect((await confirmMfaAction(initial, form())).success).toBe(false);
    mocks.user.mockResolvedValueOnce({ id: "owner" });
    expect((await confirmMfaAction(initial, form({ mode: "ENABLE" }))).success).toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("only reports password-change logout after domain success", async () => {
    expect((await changePasswordAction(initial, form({ newPassword: "a", confirmPassword: "b" }))).success).toBe(false);
    expect(mocks.change).not.toHaveBeenCalled();
    const data = form({ currentPassword: "old", newPassword: "NewPassword123", confirmPassword: "NewPassword123", userId: "attacker" });
    expect(await changePasswordAction(initial, data)).toMatchObject({ success: true, signedOut: true });
    expect(mocks.change).toHaveBeenCalledWith("owner", "current-session", "old", "NewPassword123");
    mocks.user.mockResolvedValueOnce({ id: "owner" });
    expect((await changePasswordAction(initial, data)).success).toBe(false);
  });
  it.each([new Error("当前密码不正确"), new Error("PRIVATE_DB_PASSWORD"), "PRIVATE_UNKNOWN"])("does not expose internal password-change errors (%s)", async (error) => {
    mocks.change.mockRejectedValue(error);
    const result = await changePasswordAction(initial, form({ confirmPassword: "" }));
    expect(result.success).toBe(false);
    expect(result.signedOut).toBeUndefined();
    expect(result.message).toBe(error instanceof Error && error.message === "当前密码不正确" ? "当前密码不正确" : "修改失败，请检查密码格式或稍后重试。");
  });
  it.each([
    { mode: "ALL", target: "", signedOut: true },
    { mode: "OTHERS", target: "", signedOut: false },
    { mode: "ONE", target: "other-session", signedOut: false },
    { mode: "ONE", target: "current-session", signedOut: true },
  ])("revokes $mode/$target within the server-owned identity", async ({ mode, target, signedOut }) => {
    expect(await revokeSessionsAction(initial, form({ mode, sessionId: target, userId: "attacker" }))).toMatchObject({ success: true, signedOut });
    expect(mocks.revoke).toHaveBeenCalledWith("owner", "current-session", mode, target);
    expect(mocks.revalidate).toHaveBeenCalledWith("/my/security");
  });
  it("does not revoke on invalid modes/missing sessions or claim success after failure", async () => {
    expect((await revokeSessionsAction(initial, form())).success).toBe(false);
    mocks.user.mockResolvedValueOnce({ id: "owner" });
    expect((await revokeSessionsAction(initial, form({ mode: "ALL" }))).success).toBe(false);
    expect(mocks.revoke).not.toHaveBeenCalled();
    mocks.revoke.mockRejectedValue(new Error("PRIVATE_DETAIL"));
    expect(await revokeSessionsAction(initial, form({ mode: "ALL" }))).toEqual({ success: false, message: "操作失败，请重新登录后重试。" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
