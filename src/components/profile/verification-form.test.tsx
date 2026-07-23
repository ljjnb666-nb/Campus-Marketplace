import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerificationForm } from "@/components/profile/verification-form";

const { mockPush, mockRefresh, mockUseActionState } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockUseActionState: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");

  return {
    ...actual,
    useActionState: mockUseActionState,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockRefresh.mockReset();
  mockUseActionState.mockReset();
  mockUseActionState.mockReturnValue([{ success: false, message: "" }, vi.fn()]);
});

afterEach(() => {
  cleanup();
});

describe("VerificationForm", () => {
  it("renders initial verification values and upload inputs", () => {
    const { container } = render(
      <VerificationForm
        action={async () => ({ success: false, message: "" })}
        initialValues={{
          schoolName: "示例大学",
          campusName: "主校区",
          studentIdLast4: "2048",
          studentCardImage: "/uploads/verification/card.jpg",
        }}
      />,
    );

    expect(screen.getByDisplayValue("示例大学")).toBeTruthy();
    expect(screen.getByDisplayValue("主校区")).toBeTruthy();
    expect(screen.getByDisplayValue("2048")).toBeTruthy();
    expect(screen.getByDisplayValue("/uploads/verification/card.jpg")).toBeTruthy();
    expect(screen.getByPlaceholderText("例如 2048")).toHaveAttribute("maxlength", "4");
    expect(container.querySelector('input[type="file"][name="studentCardImageFile"]')).toBeInTheDocument();
  });

  it("shows the action error message from server state", () => {
    mockUseActionState.mockReturnValue([{ success: false, message: "学号后四位格式不正确" }, vi.fn()]);

    render(
      <VerificationForm
        action={async () => ({ success: false, message: "" })}
        initialValues={{ schoolName: "示例大学" }}
      />,
    );

    expect(screen.getByText("学号后四位格式不正确")).toBeTruthy();
  });

  it("redirects after a successful action state", () => {
    mockUseActionState.mockReturnValue([
      { success: true, message: "提交成功", redirectTo: "/verification" },
      vi.fn(),
    ]);

    render(
      <VerificationForm
        action={async () => ({ success: false, message: "" })}
        initialValues={{ schoolName: "示例大学" }}
      />,
    );

    expect(mockPush).toHaveBeenCalledWith("/verification");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
