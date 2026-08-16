import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getRentalOrderDetail, requestReturn, confirmReturn, redirect, notFound } =
  vi.hoisted(() => ({
    requireUser: vi.fn(),
    getRentalOrderDetail: vi.fn(),
    requestReturn: vi.fn(),
    confirmReturn: vi.fn(),
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
  requestReturn,
  confirmReturn,
}));

import ReturnVerificationPage from "@/app/rental-orders/[id]/return/page";

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    ownerId: "owner-1",
    renterId: "renter-1",
    status: "IN_RENTAL",
    rentalListing: {
      title: "索尼单反相机",
      returnLocation: "实验楼二楼",
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

describe("ReturnVerificationPage", () => {
  it("租客在 IN_RENTAL 通过 requestReturn 提交归还申请（不展示照片栏）", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());
    requestReturn.mockResolvedValue({ success: true, message: "已提交归还请求" });

    const { container } = render(
      await ReturnVerificationPage({ params: Promise.resolve({ id: "order-1" }) }),
    );

    expect(screen.getByRole("heading", { name: "申请归还物品" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交归还申请" })).toBeTruthy();
    // requestReturn 仅接受 orderId，隐藏其不支持的装饰性照片/备注栏
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.querySelector('textarea[name="inspectionNote"]')).toBeNull();

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(requestReturn).toHaveBeenCalledTimes(1);
    });
    const formData = requestReturn.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(confirmReturn).not.toHaveBeenCalled();
  });

  it.each(["OVERDUE", "PICKED_UP"] as const)(
    "租客在 %s 状态同样可进入归还申请页",
    async (status) => {
      requireUser.mockResolvedValue({ id: "renter-1" });
      getRentalOrderDetail.mockResolvedValue(buildOrder({ status }));

      render(await ReturnVerificationPage({ params: Promise.resolve({ id: "order-1" }) }));

      expect(screen.getByRole("button", { name: "提交归还申请" })).toBeTruthy();
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it("租客在 COMPLETED 状态被重定向回订单详情", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder({ status: "COMPLETED" }));

    await expect(
      ReturnVerificationPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("redirected");
    expect(redirect).toHaveBeenCalledWith("/rental-orders/order-1");
  });

  it("出租者在 PENDING_RETURN 使用 confirmReturn 并携带 photos 文件输入", async () => {
    requireUser.mockResolvedValue({ id: "owner-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder({ status: "PENDING_RETURN" }));
    confirmReturn.mockResolvedValue({ success: true, message: "已确认归还" });

    const { container } = render(
      await ReturnVerificationPage({ params: Promise.resolve({ id: "order-1" }) }),
    );

    expect(screen.getByRole("heading", { name: "确认收到归还" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认完好归还" })).toBeTruthy();
    // 照片输入挂到 action 读取的 photos 字段，移除装饰性 returnImages
    expect(container.querySelector('input[type="file"][name="photos"]')).toBeTruthy();
    expect(container.querySelector('input[name="returnImages"]')).toBeNull();

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(confirmReturn).toHaveBeenCalledTimes(1);
    });
    const formData = confirmReturn.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(formData.get("role")).toBe("owner");
    expect(requestReturn).not.toHaveBeenCalled();
  });

  it("租客在 PENDING_RETURN 走 confirmReturn 双向确认分支", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder({ status: "PENDING_RETURN" }));
    confirmReturn.mockResolvedValue({ success: true, message: "已确认归还" });

    const { container } = render(
      await ReturnVerificationPage({ params: Promise.resolve({ id: "order-1" }) }),
    );

    expect(container.querySelector('input[type="file"][name="photos"]')).toBeTruthy();

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(confirmReturn).toHaveBeenCalledTimes(1);
    });
    const formData = confirmReturn.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(formData.get("role")).toBe("renter");
    expect(requestReturn).not.toHaveBeenCalled();
  });
});
