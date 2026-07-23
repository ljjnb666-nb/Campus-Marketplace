import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignOutButton } from "@/components/auth/sign-out-button";

const { signOut } = vi.hoisted(() => ({
  signOut: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  signOut,
}));

describe("SignOutButton", () => {
  it("triggers sign out with the login callback url", () => {
    render(<SignOutButton className="test-button">退出当前账号</SignOutButton>);

    fireEvent.click(screen.getByRole("button", { name: "退出当前账号" }));

    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });
});
