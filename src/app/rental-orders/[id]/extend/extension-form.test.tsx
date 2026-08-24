import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requestExtension } = vi.hoisted(() => ({
  requestExtension: vi.fn(),
}));

vi.mock("@/actions/rental-order", () => ({
  requestExtension,
}));

import { RentalExtensionForm } from "@/app/rental-orders/[id]/extend/extension-form";

const currentEndTime = "2026-08-21T10:00:00.000Z";

function endTimeField() {
  const el = document.querySelector('input[name="newEndTime"]');
  if (!el) throw new Error("newEndTime field not found");
  return el as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderForm(overrides: Record<string, unknown> = {}) {
  return render(
    <RentalExtensionForm
      orderId="order-1"
      currentEndTime={currentEndTime}
      price={20}
      pricingUnit="PER_DAY"
      {...overrides}
    />,
  );
}

describe("RentalExtensionForm", () => {
  it("disables submission until a later end time is chosen", () => {
    renderForm();

    expect(screen.getByRole("button", { name: "提交续租申请" })).toBeDisabled();
    expect(screen.getByText("当前到期时间")).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it("estimates the extra fee for additional days", () => {
    renderForm();

    // 选 10 天后的时间：无论测试机时区如何都是 10 天（20 元/天 → 200 元）
    fireEvent.change(endTimeField(), {
      target: { value: "2026-08-31T10:00" },
    });

    expect(screen.getByText((_, el) => el?.textContent === "10 天")).toBeInTheDocument();
    expect(screen.getByText("¥200.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交续租申请" })).toBeEnabled();
  });

  it("shows no estimate when the chosen time is not after the current end", () => {
    renderForm();

    fireEvent.change(endTimeField(), {
      target: { value: "2026-08-20T10:00" },
    });

    expect(screen.queryByText(/预计额外费用/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交续租申请" })).toBeDisabled();
  });

  it("charges a single session for PER_SESSION pricing regardless of duration", () => {
    renderForm({ pricingUnit: "PER_SESSION", price: 15 });

    fireEvent.change(endTimeField(), {
      target: { value: "2026-08-25T10:00" },
    });

    expect(screen.getByText((_, el) => el?.textContent === "1 次")).toBeInTheDocument();
    expect(screen.getByText("¥15.00")).toBeInTheDocument();
  });

  it("surfaces the action error message after a failed submit", async () => {
    requestExtension.mockResolvedValue({ success: false, message: "续租时间段库存不足" });
    renderForm();

    fireEvent.change(endTimeField(), {
      target: { value: "2026-08-22T12:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交续租申请" }));

    expect(await screen.findByText("续租时间段库存不足")).toBeInTheDocument();
    expect(requestExtension).toHaveBeenCalledTimes(1);
    const formData = requestExtension.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(formData.get("newEndTime")).toBe("2026-08-22T12:00");
  });
});
