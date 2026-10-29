import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/auth/login-form", () => ({
  LoginForm: () => <p>登录表单</p>,
}));

import LoginPage from "@/app/login/page";

describe("LoginPage", () => {
  it("renders the login introduction and form", () => {
    render(<LoginPage />);

    expect(screen.getByText("欢迎回来")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "登录校园集市" })).toBeTruthy();
    expect(screen.getByText("登录表单")).toBeTruthy();
    expect(screen.getByText(/使用你的校园集市账号登录/)).toBeTruthy();
    expect(screen.queryByText(/student1@campus.local \/ Student123456/)).toBeNull();
  });
});
