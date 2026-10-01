import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getMyReviews } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getMyReviews: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/trust-repository", () => ({
  getMyReviews,
}));

import MyReviewsPage from "@/app/my/reviews/page";

afterEach(() => {
  cleanup();
});

describe("MyReviewsPage", () => {
  it("renders the empty state for written and received reviews", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyReviews.mockResolvedValue({ written: [], received: [] });

    render(await MyReviewsPage());

    expect(screen.getByRole("heading", { name: "我的评价" })).toBeTruthy();
    expect(screen.getByText("你还没有提交过评价。")).toBeTruthy();
    expect(screen.getByText("你暂时还没有收到公开的评价。")).toBeTruthy();
  });

  it("renders written reviews with 中文类型与 publication 状态，received 全为已公开", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyReviews.mockResolvedValue({
      written: [
        {
          id: "review-1",
          orderNo: "CM202607180010",
          orderTypeLabel: "技能服务",
          counterpartyName: "李同学",
          rating: 5,
          content: "沟通顺畅，准时交付。",
          tags: ["守时"],
          createdAt: new Date("2026-07-18T08:00:00.000Z"),
          statusLabel: "等待双方完成评价后公开（评价期结束后自动公开）",
        },
        {
          id: "review-3",
          orderNo: "CM202607180012",
          orderTypeLabel: "物品租赁",
          counterpartyName: "赵同学",
          rating: 4,
          content: null,
          tags: [],
          createdAt: new Date("2026-07-17T08:00:00.000Z"),
          statusLabel: "已公开",
        },
      ],
      received: [
        {
          id: "review-2",
          orderNo: "CM202607180011",
          orderTypeLabel: "二手商品",
          counterpartyName: "王同学",
          rating: 4,
          content: null,
          tags: [],
          createdAt: new Date("2026-07-18T09:00:00.000Z"),
          statusLabel: null,
        },
      ],
    });

    render(await MyReviewsPage());

    expect(screen.getByText("李同学")).toBeTruthy();
    expect(screen.getByText("王同学")).toBeTruthy();
    expect(screen.getByText("评分：5 / 5")).toBeTruthy();
    expect(screen.getAllByText("评分：4 / 5")).toHaveLength(2);
    expect(screen.getByText("沟通顺畅，准时交付。")).toBeTruthy();
    expect(screen.getByText("对方未填写文字评价。")).toBeTruthy();
    expect(screen.getByText(/订单 CM202607180010/)).toBeTruthy();
    expect(screen.getByText(/订单 CM202607180011/)).toBeTruthy();
    // 中文类型标签（§26：禁止 PRODUCT/SERVICE/ERRAND/RENTAL 原文）
    expect(screen.getByText(/技能服务/)).toBeTruthy();
    expect(screen.getByText(/物品租赁/)).toBeTruthy();
    expect(screen.getByText(/二手商品/)).toBeTruthy();
    expect(screen.queryByText(/PRODUCT|SERVICE|ERRAND|RENTAL/)).toBeNull();
    // §27 publication 状态投影
    expect(screen.getByText("等待双方完成评价后公开（评价期结束后自动公开）")).toBeTruthy();
  });
});
