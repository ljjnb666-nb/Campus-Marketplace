import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createRentalOrder } = vi.hoisted(() => ({
  createRentalOrder: vi.fn(async () => ({ success: false, message: "" })),
}));

vi.mock("@/actions/rental-order", () => ({
  createRentalOrder,
}));

import { RentalBookingForm } from "@/components/rental/rental-booking-form";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderForm(overrides: Record<string, unknown> = {}) {
  return render(
    <RentalBookingForm
      listingId="listing-1"
      price={20}
      pricingUnit="PER_DAY"
      depositAmount={100}
      requiresApproval={false}
      {...overrides}
    />,
  );
}

function field(name: string) {
  const el = document.querySelector(`[name="${name}"]`);
  if (!el) throw new Error(`field ${name} not found`);
  return el as HTMLInputElement;
}

describe("RentalBookingForm", () => {
  it("disables submission before times are chosen", () => {
    renderForm();

    expect(screen.getByRole("button", { name: "立即预订" })).toBeDisabled();
    expect(screen.getByText("押金")).toBeInTheDocument();
    // 押金与总计在租费为 0 时相同
    expect(screen.getAllByText("¥100.00")).toHaveLength(2);
  });

  it("computes the duration and total for a valid range", () => {
    renderForm();

    // 10 天间隔，与测试机时区无关
    fireEvent.change(field("startTime"), { target: { value: "2026-09-01T10:00" } });
    fireEvent.change(field("endTime"), { target: { value: "2026-09-11T10:00" } });

    expect(screen.getByText((_, el) => el?.textContent === "10 天")).toBeInTheDocument();
    expect(screen.getByText("¥200.00")).toBeInTheDocument();
    expect(screen.getByText("¥300.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即预订" })).toBeEnabled();
  });

  it("resets the estimate when the range is invalid", () => {
    renderForm();

    fireEvent.change(field("startTime"), { target: { value: "2026-09-11T10:00" } });
    fireEvent.change(field("endTime"), { target: { value: "2026-09-01T10:00" } });

    expect(screen.getByText("-")).toBeInTheDocument();
    expect(screen.getByText("¥0.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即预订" })).toBeDisabled();
  });

  it("shows the approval hint and request label when required", () => {
    renderForm({ requiresApproval: true });

    expect(screen.getByRole("button", { name: "提交预约请求" })).toBeInTheDocument();
    expect(screen.getByText("房东开启了手动审核，提交后需等待确认")).toBeInTheDocument();
  });

  it("charges one session for PER_SESSION pricing", () => {
    renderForm({ pricingUnit: "PER_SESSION", price: 15, depositAmount: 0 });

    fireEvent.change(field("startTime"), { target: { value: "2026-09-01T10:00" } });
    fireEvent.change(field("endTime"), { target: { value: "2026-09-02T10:00" } });

    expect(screen.getByText((_, el) => el?.textContent === "1 次")).toBeInTheDocument();
    // 租费小计与总计一致（押金为 0）
    expect(screen.getAllByText("¥15.00")).toHaveLength(2);
  });
});
