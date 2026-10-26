import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmAccountChallengeForm, EmailVerificationControl, ForgotPasswordForm, MfaControls } from "./account-recovery-controls";
import { PasswordChangeForm, RevokeSessionForm } from "./account-session-controls";

const actions = vi.hoisted(() => ({ begin: vi.fn(), complete: vi.fn(), confirm: vi.fn(), email: vi.fn(), reset: vi.fn(), change: vi.fn(), revoke: vi.fn() }));
vi.mock("@/actions/account-recovery", () => ({ beginMfaAction: actions.begin, completeChallengeAction: actions.complete, confirmMfaAction: actions.confirm, requestEmailVerificationAction: actions.email, requestPasswordResetAction: actions.reset }));
vi.mock("@/actions/account-sessions", () => ({ changePasswordAction: actions.change, revokeSessionsAction: actions.revoke }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/account/confirm");
});
afterEach(cleanup);
async function submit(name: string) {
  await act(async () => { fireEvent.submit(screen.getByRole("button", { name }).closest("form")!); });
}
function openLink(purpose: string, id = "challenge") {
  window.history.replaceState(null, "", `/account/confirm#${new URLSearchParams({ id, token: "test-bearer", purpose })}`);
}

describe("account security UI proof boundaries", () => {
  it.each(["", "#id=x", "#id=x&token=t&purpose=OTHER"])("rejects incomplete links without rendering an actionable form (%s)", (fragment) => {
    window.history.replaceState(null, "", `/account/confirm${fragment}`);
    render(<ConfirmAccountChallengeForm />);
    expect(screen.getByText(/链接不完整/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(actions.complete).not.toHaveBeenCalled();
  });
  it("preserves a proof through Strict Mode, removes its URL token, and resets consumed state on hash navigation", async () => {
    openLink("VERIFY_EMAIL");
    actions.complete.mockResolvedValueOnce({ success: true, message: "邮箱已验证" });
    actions.complete.mockResolvedValueOnce({ success: false, message: "链接已使用" });
    render(<StrictMode><ConfirmAccountChallengeForm /></StrictMode>);
    expect(window.location.hash).toBe("");
    expect(document.querySelector<HTMLInputElement>('input[name="token"]')?.value).toBe("test-bearer");
    await submit("确认验证邮箱");
    expect(screen.getByRole("button", { name: "确认验证邮箱" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "继续" })).toHaveAttribute("href", "/my/security");
    act(() => { openLink("VERIFY_EMAIL"); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(screen.getByRole("button", { name: "确认验证邮箱" })).toBeEnabled();
    expect(screen.queryByRole("status")).toBeNull();
    await submit("确认验证邮箱");
    expect(screen.getByRole("status")).toHaveTextContent("链接已使用");
    expect(screen.queryByRole("link")).toBeNull();
    expect(actions.complete).toHaveBeenCalledTimes(2);
  });
  it("submits reset credentials and disables repeat submission only after success", async () => {
    openLink("RESET_PASSWORD");
    actions.complete.mockResolvedValue({ success: true, message: "密码已重置" });
    render(<ConfirmAccountChallengeForm />);
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "ChangedPassword123" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "ChangedPassword123" } });
    fireEvent.change(screen.getByLabelText(/动态验证码/), { target: { value: "123456" } });
    await submit("重置密码");
    const submitted = actions.complete.mock.calls[0][1] as FormData;
    expect(submitted.get("purpose")).toBe("RESET_PASSWORD");
    expect(submitted.get("mfaCode")).toBe("123456");
    expect(screen.getByRole("button", { name: "重置密码" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "继续" })).toHaveAttribute("href", "/login");
  });
  it("never offers a verification request for an already verified address", async () => {
    actions.email.mockResolvedValue({ success: true, message: "申请已受理" });
    const view = render(<EmailVerificationControl verified={false} />);
    await submit("发送验证邮件");
    expect(screen.getByRole("status")).toHaveTextContent("申请已受理");
    view.rerender(<EmailVerificationControl verified />);
    expect(screen.getByText("邮箱已验证")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("shows the generic recovery result without exposing credentials", async () => {
    actions.reset.mockResolvedValue({ success: true, message: "如果账号符合条件" });
    render(<ForgotPasswordForm />);
    fireEvent.change(screen.getByLabelText("注册邮箱"), { target: { value: "user@example.test" } });
    await submit("发送密码重置邮件");
    expect(screen.getByRole("status")).toHaveTextContent("如果账号符合条件");
    expect((actions.reset.mock.calls[0][1] as FormData).get("email")).toBe("user@example.test");
  });
  it("reveals enrollment material only after proof and replaces it with management forms when enabled", async () => {
    actions.begin.mockResolvedValue({ success: true, message: "绑定待确认", setupSecret: "TEST-ONLY-SECRET" });
    actions.confirm.mockResolvedValue({ success: false, message: "验证码无效" });
    const view = render(<MfaControls enabled={false} />);
    expect(screen.queryByText("TEST-ONLY-SECRET")).toBeNull();
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "Password123" } });
    await submit("开始绑定验证器");
    expect(screen.getByText("TEST-ONLY-SECRET")).toBeTruthy();
    await submit("确认启用双重验证");
    expect(screen.getByText("验证码无效")).toBeTruthy();
    expect((actions.confirm.mock.calls[0][1] as FormData).get("mode")).toBe("ENABLE");
    view.rerender(<MfaControls enabled />);
    expect(screen.queryByText("TEST-ONLY-SECRET")).toBeNull();
    expect(screen.getByRole("button", { name: "验证以继续管理操作" })).toBeEnabled();
    await submit("关闭双重验证");
    expect((actions.confirm.mock.calls[1][1] as FormData).get("mode")).toBe("DISABLE");
  });
  it("keeps password submission pending and requires login after a successful change", async () => {
    let finish!: (value: { success: boolean; message: string; signedOut: boolean }) => void;
    actions.change.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<PasswordChangeForm />);
    fireEvent.submit(screen.getByRole("form", { name: "修改密码" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "正在修改…" })).toBeDisabled());
    await act(async () => finish({ success: true, message: "所有设备已退出", signedOut: true }));
    expect(screen.getByRole("button", { name: "修改密码并退出所有设备" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "重新登录" })).toHaveAttribute("href", "/login");
  });
  it.each([true, false])("uses the server's signedOut result for session revocation (%s)", async (signedOut) => {
    actions.revoke.mockResolvedValue({ success: true, message: "会话已撤销", signedOut });
    render(<RevokeSessionForm mode={signedOut ? "ALL" : "ONE"} sessionId={signedOut ? undefined : "other-session"} label="退出设备" />);
    await submit("退出设备");
    expect(screen.getByRole("button", { name: "退出设备" }).hasAttribute("disabled")).toBe(signedOut);
    expect(Boolean(screen.queryByRole("link", { name: "重新登录" }))).toBe(signedOut);
    expect((actions.revoke.mock.calls[0][1] as FormData).get("sessionId")).toBe(signedOut ? null : "other-session");
  });
});
