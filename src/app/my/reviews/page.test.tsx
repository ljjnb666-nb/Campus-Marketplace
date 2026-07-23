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
    getMyReviews.mockResolvedValue({
      writtenReviews: [],
      receivedReviews: [],
    });

    render(await MyReviewsPage());

    expect(screen.getByRole("heading", { name: "我的评价" })).toBeTruthy();
    expect(screen.getByText("你还没有提交过评价。")).toBeTruthy();
    expect(screen.getByText("你暂时还没有收到评价。")).toBeTruthy();
  });

  it("renders both written and received reviews", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyReviews.mockResolvedValue({
      writtenReviews: [
        {
          id: "review-1",
          rating: 5,
          content: "沟通顺畅，准时交付。",
          createdAt: new Date("2026-07-18T08:00:00.000Z"),
          targetUser: { id: "user-2", name: "李同学" },
          order: { orderNo: "CM202607180010", type: "SERVICE" },
        },
      ],
      receivedReviews: [
        {
          id: "review-2",
          rating: 4,
          content: null,
          createdAt: new Date("2026-07-18T09:00:00.000Z"),
          author: { id: "user-3", name: "王同学" },
          order: { orderNo: "CM202607180011", type: "PRODUCT" },
        },
      ],
    });

    render(await MyReviewsPage());

    expect(screen.getByText("李同学")).toBeTruthy();
    expect(screen.getByText("王同学")).toBeTruthy();
    expect(screen.getByText("评分：5 / 5")).toBeTruthy();
    expect(screen.getByText("评分：4 / 5")).toBeTruthy();
    expect(screen.getByText("沟通顺畅，准时交付。")).toBeTruthy();
    expect(screen.getByText("对方未填写文字评价。")).toBeTruthy();
    expect(screen.getByText(/订单 CM202607180010/)).toBeTruthy();
    expect(screen.getByText(/订单 CM202607180011/)).toBeTruthy();
  });
});
