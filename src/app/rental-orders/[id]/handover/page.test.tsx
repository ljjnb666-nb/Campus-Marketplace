import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getRentalOrderDetail, confirmPickup, redirect, notFound } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getRentalOrderDetail: vi.fn(),
  confirmPickup: vi.fn(),
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
  confirmPickup,
}));

import HandoverVerificationPage from "@/app/rental-orders/[id]/handover/page";

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    ownerId: "owner-1",
    renterId: "renter-1",
    status: "PENDING_PICKUP",
    rentalListing: {
      title: "索尼单反相机",
      pickupLocation: "实验楼二楼",
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  redirect.mockImplementation(() => {
    throw new Error("redirected");
  });
});

describe("HandoverVerificationPage", () => {
  it("交接页照片输入挂载到 confirmPickup 读取的 photos 字段", async () => {
    requireUser.mockResolvedValue({ id: "owner-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());
    confirmPickup.mockResolvedValue({ success: true, message: "已确认取货" });

    const { container } = render(
      await HandoverVerificationPage({ params: Promise.resolve({ id: "order-1" }) }),
    );

    expect(screen.getByRole("heading", { name: "交接确认" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认已交接" })).toBeTruthy();
    expect(container.querySelector('input[type="file"][name="photos"]')).toBeTruthy();
    // 装饰性 mock 隐藏输入已移除
    expect(container.querySelector('input[name="handoverImages"]')).toBeNull();

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(confirmPickup).toHaveBeenCalledTimes(1);
    });
    const formData = confirmPickup.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(formData.get("role")).toBe("owner");
    // 未选择文件时 jsdom 提交空 File 条目（saveFormPhotos 会按 size=0 过滤）
    expect(formData.getAll("photos").every((entry) => entry instanceof File && entry.size === 0)).toBe(true);
  });

  it("租客确认交接时提交 role=renter", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());
    confirmPickup.mockResolvedValue({ success: true, message: "已确认取货" });

    const { container } = render(
      await HandoverVerificationPage({ params: Promise.resolve({ id: "order-1" }) }),
    );

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(confirmPickup).toHaveBeenCalledTimes(1);
    });
    const formData = confirmPickup.mock.calls[0][0] as FormData;
    expect(formData.get("role")).toBe("renter");
  });

  it("非 PENDING_PICKUP 状态被重定向回订单详情", async () => {
    requireUser.mockResolvedValue({ id: "owner-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder({ status: "IN_RENTAL" }));

    await expect(
      HandoverVerificationPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("redirected");
    expect(redirect).toHaveBeenCalledWith("/rental-orders/order-1");
  });
});
