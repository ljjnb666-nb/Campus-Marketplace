import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/login-form";

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
  it("submits credentials through next-auth signIn", async () => {
    signIn.mockResolvedValue({ url: "/" });

    render(<LoginForm />);

    fireEvent.change(screen.getByPlaceholderText("student1@campus.local"), {
      target: { value: "student1@campus.local" },
    });
    fireEvent.change(screen.getByPlaceholderText("Student123456"), {
      target: { value: "Student123456" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "登录" }).closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith("credentials", {
        email: "student1@campus.local",
        password: "Student123456",
        redirect: false,
        callbackUrl: "/",
      });
    });
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

    expect(await screen.findByText("邮箱或密码错误")).toBeTruthy();
  });
});
