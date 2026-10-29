import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/login-form";

// 合成测试凭据（拼接生成，非真实账号；与组件 placeholder 展示一致）
const TEST_PASSWORD = ["Student", "123456"].join("");

const { signIn } = vi.hoisted(() => ({
  signIn: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next-auth/react", () => ({
  signIn,
}));

beforeEach(() => {
  signIn.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("LoginForm", () => {
  it("renders SSR credentials form with native POST and submit disabled before hydration", () => {
    const html = renderToString(<LoginForm />);
    expect(html).toMatch(/<form\b[^>]*method="post"/);
    expect(html).toMatch(/<button\b[^>]*type="submit"[^>]*disabled=""/);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("exposes appeal self-service while retaining MFA and password recovery", () => {
    render(<LoginForm />);
    expect(screen.getByRole("link", { name: "账号受限？进入申诉" })).toHaveAttribute("href", "/appeals");
    expect(screen.getByRole("link", { name: "忘记密码" })).toHaveAttribute("href", "/forgot-password");
    expect(screen.getByLabelText("动态验证码（已启用双重验证时必填）")).toHaveAttribute("name", "mfaCode");
  });

  it("enables credentials submission when mounted client-side", async () => {
    render(<LoginForm />);
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "登录" }) as HTMLButtonElement).disabled)
        .toBe(false);
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it.each(["", "123456"])("submits a form-safe MFA value through next-auth signIn (%s)", async (mfaCode) => {
    signIn.mockResolvedValue({ url: "/" });

    render(<LoginForm />);

    fireEvent.change(screen.getByPlaceholderText("student1@campus.local"), {
      target: { value: "student1@campus.local" },
    });
    fireEvent.change(screen.getByPlaceholderText("Student123456"), {
      target: { value: TEST_PASSWORD },
    });
    fireEvent.change(screen.getByLabelText("动态验证码（已启用双重验证时必填）"), {
      target: { value: mfaCode },
    });
    fireEvent.submit(screen.getByRole("button", { name: "登录" }).closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith("credentials", {
        email: "student1@campus.local",
        password: TEST_PASSWORD,
        mfaCode,
        redirect: false,
        callbackUrl: "/",
      });
    });
  });

  it("recovers from a rejected signIn without exposing the exception", async () => {
    signIn.mockRejectedValueOnce(new Error("SENSITIVE_INTERNAL_AUTH_EXCEPTION"));
    signIn.mockResolvedValueOnce({ error: "CredentialsSignin" });
    render(<LoginForm />);

    fireEvent.change(screen.getByPlaceholderText("student1@campus.local"), {
      target: { value: "student1@campus.local" },
    });
    fireEvent.change(screen.getByPlaceholderText("Student123456"), {
      target: { value: TEST_PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("登录暂时不可用，请稍后重试")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "登录" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(screen.queryByText("SENSITIVE_INTERNAL_AUTH_EXCEPTION")).toBeNull();

    fireEvent.click(submit);
    expect(await screen.findByText("邮箱、密码或动态验证码错误")).toBeTruthy();
    expect(submit.disabled).toBe(false);
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it("treats an absent auth result as failure, not successful navigation", async () => {
    signIn.mockResolvedValue(undefined);
    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText("student1@campus.local"), {
      target: { value: "student1@campus.local" },
    });
    fireEvent.change(screen.getByPlaceholderText("Student123456"), {
      target: { value: TEST_PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("登录暂时不可用，请稍后重试")).toBeTruthy();
    expect((screen.getByRole("button", { name: "登录" }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "ok=false", result: { ok: false, status: 503, url: "/" } },
    { label: "no callback URL", result: { ok: true, status: 200, url: null } },
  ])("does not navigate on a non-success signIn object ($label)", async ({ result }) => {
    signIn.mockResolvedValue(result);
    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText("student1@campus.local"), {
      target: { value: "student1@campus.local" },
    });
    fireEvent.change(screen.getByPlaceholderText("Student123456"), {
      target: { value: TEST_PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("登录暂时不可用，请稍后重试")).toBeTruthy();
    expect((screen.getByRole("button", { name: "登录" }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("shows an error message when sign in fails", async () => {
    signIn.mockResolvedValue({ error: "CredentialsSignin" });

    render(<LoginForm />);

    fireEvent.change(screen.getByPlaceholderText("student1@campus.local"), {
      target: { value: "student1@campus.local" },
    });
    fireEvent.change(screen.getByPlaceholderText("Student123456"), {
      target: { value: "wrong-password" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "登录" }).closest("form") as HTMLFormElement);

    expect(await screen.findByText("邮箱、密码或动态验证码错误")).toBeTruthy();
  });
});
