import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getRentalOrderDetail, initiateDispute, redirect, notFound } =
  vi.hoisted(() => ({
    requireUser: vi.fn(),
    getRentalOrderDetail: vi.fn(),
    initiateDispute: vi.fn(),
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
  initiateDispute,
}));

import DisputePage from "@/app/rental-orders/[id]/dispute/page";

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    ownerId: "owner-1",
    renterId: "renter-1",
    status: "PENDING_INSPECTION",
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

describe("DisputePage", () => {
  it("参与者纠纷页面正常渲染", async () => {
    requireUser.mockResolvedValue({ id: "owner-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());

    render(await DisputePage({ params: Promise.resolve({ id: "order-1" }) }));

    expect(screen.getByText("发起纠纷")).toBeTruthy();
    expect(screen.getByLabelText(/纠纷原因/)).toBeTruthy();
  });

  it("不可纠纷状态被重定向", async () => {
    requireUser.mockResolvedValue({ id: "owner-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder({ status: "PENDING_APPROVAL" }));

    await expect(
      DisputePage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("redirected");
  });

  it("非参与者得到 404", async () => {
    requireUser.mockResolvedValue({ id: "stranger-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());

    await expect(
      DisputePage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("notFound");
  });

  it("提交表单调用 initiateDispute 并携带 orderId 与 reason", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder({ status: "COMPLETED" }));
    initiateDispute.mockResolvedValue({ success: true, message: "已提交" });

    render(await DisputePage({ params: Promise.resolve({ id: "order-1" }) }));

    fireEvent.change(screen.getByLabelText(/纠纷原因/), {
      target: { value: "归还物品与出租时不符" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交纠纷申请" }));

    await waitFor(() => expect(initiateDispute).toHaveBeenCalledTimes(1));
    const formData = initiateDispute.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(formData.get("reason")).toBe("归还物品与出租时不符");
  });
});
