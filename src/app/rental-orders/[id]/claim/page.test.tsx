import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getRentalOrderDetail, submitDamageClaim, redirect, notFound } =
  vi.hoisted(() => ({
    requireUser: vi.fn(),
    getRentalOrderDetail: vi.fn(),
    submitDamageClaim: vi.fn(),
    redirect: vi.fn(() => {
      throw new Error("redirected");
    }),
    notFound: vi.fn(() => {
      throw new Error("notFound");
    }),
  }));

vi.mock("next/navigation", () => ({
  redirect,
  notFound,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/rental-order-repository", () => ({
  getRentalOrderDetail,
}));

vi.mock("@/actions/rental-order", () => ({
  submitDamageClaim,
}));

import DamageClaimPage from "@/app/rental-orders/[id]/claim/page";

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    ownerId: "owner-1",
    renterId: "renter-1",
    status: "PENDING_INSPECTION",
    depositAmount: 200,
    rentalListing: { title: "索尼单反相机" },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  redirect.mockImplementation(() => {
    throw new Error("redirected");
  });
  notFound.mockImplementation(() => {
    throw new Error("notFound");
  });
});

describe("DamageClaimPage", () => {
  it("出租者在 PENDING_INSPECTION 可以看到索赔表单", async () => {
    requireUser.mockResolvedValue({ id: "owner-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());

    render(await DamageClaimPage({ params: Promise.resolve({ id: "order-1" }) }));

    expect(screen.getByText("提交损坏索赔")).toBeTruthy();
    expect(screen.getByText("押金金额：¥200.00")).toBeTruthy();
    expect(screen.getByLabelText(/损坏描述/)).toBeTruthy();
    expect(screen.getByLabelText(/申请扣除金额/)).toBeTruthy();
  });

  it("租客访问被重定向", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());

    await expect(
      DamageClaimPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("redirected");
  });

  it("非订单参与者得到 404", async () => {
    requireUser.mockResolvedValue({ id: "stranger-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());

    await expect(
      DamageClaimPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("notFound");
  });

  it("提交表单调用 submitDamageClaim", async () => {
    requireUser.mockResolvedValue({ id: "owner-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());
    submitDamageClaim.mockResolvedValue({ success: true, message: "已提交索赔" });

    const { fireEvent } = await import("@testing-library/react");
    render(await DamageClaimPage({ params: Promise.resolve({ id: "order-1" }) }));

    fireEvent.change(screen.getByLabelText(/损坏描述/), {
      target: { value: "镜头有划痕影响成像" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交索赔" }));

    await waitFor(() => expect(submitDamageClaim).toHaveBeenCalledTimes(1));
    const formData = submitDamageClaim.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(formData.get("damageDescription")).toBe("镜头有划痕影响成像");
  });
});
