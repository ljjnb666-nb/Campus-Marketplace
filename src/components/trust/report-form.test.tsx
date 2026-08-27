import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportForm } from "@/components/trust/report-form";

const { mockUseActionState } = vi.hoisted(() => ({
  mockUseActionState: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");

  return {
    ...actual,
    useActionState: mockUseActionState,
  };
});

beforeEach(() => {
  mockUseActionState.mockReset();
  mockUseActionState.mockReturnValue([{ success: false, message: "" }, vi.fn()]);
});

afterEach(() => {
  cleanup();
});

describe("ReportForm", () => {
  it("renders hidden target fields, compact rows, and default reason", () => {
    render(
      <ReportForm
        action={async () => ({ success: false, message: "" })}
        targetType="MESSAGE"
        targetUserId="user-2"
        messageId="message-1"
        compact
      />,
    );

    expect(screen.getByDisplayValue("MESSAGE")).toHaveAttribute("type", "hidden");
    expect(screen.getByDisplayValue("user-2")).toHaveAttribute("type", "hidden");
    expect(screen.getByDisplayValue("message-1")).toHaveAttribute("type", "hidden");
    expect(screen.getByLabelText("举报原因")).toHaveValue("FAKE_INFO");
    expect(screen.getByPlaceholderText("补充描述问题细节，便于后续处理。")).toHaveAttribute("rows", "2");
  });

  it("shows the action error message from server state", () => {
    mockUseActionState.mockReturnValue([{ success: false, message: "请不要重复举报同一对象" }, vi.fn()]);

    render(
      <ReportForm
        action={async () => ({ success: false, message: "" })}
        targetType="PRODUCT"
        productId="product-1"
      />,
    );

    expect(screen.getByText("请不要重复举报同一对象")).toBeTruthy();
  });

  it("shows the success message from action state", () => {
    mockUseActionState.mockReturnValue([{ success: true, message: "举报已提交，我们会尽快处理" }, vi.fn()]);

    render(
      <ReportForm
        action={async () => ({ success: false, message: "" })}
        targetType="SERVICE_LISTING"
        serviceListingId="service-1"
      />,
    );

    expect(screen.getByText("举报已提交，我们会尽快处理")).toBeTruthy();
  });
});
