import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getRentalOrderDetail, submitRentalReview, redirect, notFound } =
  vi.hoisted(() => ({
    requireUser: vi.fn(),
    getRentalOrderDetail: vi.fn(),
    submitRentalReview: vi.fn(),
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
  submitRentalReview,
}));

import ReviewPage from "@/app/rental-orders/[id]/review/page";

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    ownerId: "owner-1",
    renterId: "renter-1",
    status: "COMPLETED",
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

describe("ReviewPage", () => {
  it("COMPLETED 订单参与者可以看到评价表单", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());

    render(await ReviewPage({ params: Promise.resolve({ id: "order-1" }) }));

    expect(screen.getByText("评价本次租赁")).toBeTruthy();
    expect(screen.getByLabelText(/整体评分/)).toBeTruthy();
    expect(screen.getByLabelText(/评价内容/)).toBeTruthy();
  });

  it("非 COMPLETED 状态被重定向", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder({ status: "IN_RENTAL" }));

    await expect(
      ReviewPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("redirected");
  });

  it("非参与者得到 404", async () => {
    requireUser.mockResolvedValue({ id: "stranger-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());

    await expect(
      ReviewPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("notFound");
  });

  // Phase 8E §43 RB01：business deny != infrastructure failure
  it("ERR-REVIEW-01：DB exception 沿 server error path 传播，不伪装成 404/redirect", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockRejectedValue(new Error("db down"));

    await expect(
      ReviewPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("db down");
    expect(notFound).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("ERR-REVIEW-02：missing/unauthorized 仍保持 fail-closed notFound contract", async () => {
    // repository 对 missing/unauthorized 调 notFound()（以 rejection 模拟
    // notFound() throw 经由 page 直接传播——无 broad catch 吞噬）
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockRejectedValue(
      Object.assign(new Error("notFound"), { digest: "NEXT_NOT_FOUND" }),
    );

    await expect(
      ReviewPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("提交表单调用 submitRentalReview 并携带评分", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());
    submitRentalReview.mockResolvedValue({ success: true, message: "已评价" });

    render(await ReviewPage({ params: Promise.resolve({ id: "order-1" }) }));

    fireEvent.change(screen.getByLabelText(/整体评分/), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText(/评价内容/), {
      target: { value: "物品很好，交接顺利" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交评价" }));

    await waitFor(() => expect(submitRentalReview).toHaveBeenCalledTimes(1));
    const formData = submitRentalReview.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(formData.get("overallRating")).toBe("4");
    expect(formData.get("content")).toBe("物品很好，交接顺利");
  });
});
