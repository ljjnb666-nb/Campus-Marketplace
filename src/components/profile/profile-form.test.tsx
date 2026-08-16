import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileForm } from "@/components/profile/profile-form";

const { mockPush, mockRefresh, mockUseSession } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockUseSession: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

vi.mock("next-auth/react", () => ({
  useSession: mockUseSession,
}));

beforeEach(() => {
  mockPush.mockReset();
  mockRefresh.mockReset();
  mockUseSession.mockReset();
  mockUseSession.mockReturnValue({
    data: { user: { id: "user-1" } },
    status: "authenticated",
    update: vi.fn().mockResolvedValue({}),
  });
});

afterEach(() => {
  cleanup();
});

describe("ProfileForm", () => {
  it("renders initial profile values and upload inputs", () => {
    render(
      <ProfileForm
        action={async () => ({ success: false, message: "" })}
        initialValues={{
          name: "小林",
          bio: "计算机专业，平时接 PPT 和修图。",
          college: "信息工程学院",
          grade: "2024 级",
          phone: "13800138000",
          avatarUrl: "/uploads/avatars/user-1.jpg",
        }}
      />,
    );

    expect(screen.getByDisplayValue("小林")).toBeTruthy();
    expect(screen.getByDisplayValue("计算机专业，平时接 PPT 和修图。")).toBeTruthy();
    expect(screen.getByDisplayValue("信息工程学院")).toBeTruthy();
    expect(screen.getByDisplayValue("2024 级")).toBeTruthy();
    expect(screen.getByDisplayValue("13800138000")).toBeTruthy();
    expect(screen.getByText("头像")).toBeTruthy();
  });

  it("shows the action error message from server state", async () => {
    const mockAction = vi.fn().mockResolvedValue({ success: false, message: "手机号格式不正确" });

    const { container } = render(
      <ProfileForm
        action={mockAction}
        initialValues={{ name: "小林" }}
      />,
    );

    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText("手机号格式不正确")).toBeTruthy();
    });
  });

  it("redirects after a successful action state", async () => {
    const mockAction = vi.fn().mockResolvedValue({
      success: true,
      message: "保存成功",
      redirectTo: "/profile",
      data: { name: "小林", avatarUrl: "/uploads/avatars/user-1.jpg" },
    });

    const { container } = render(
      <ProfileForm
        action={mockAction}
        initialValues={{ name: "小林" }}
      />,
    );

    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/profile");
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
  });
});
