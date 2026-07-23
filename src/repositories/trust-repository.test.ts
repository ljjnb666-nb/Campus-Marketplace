import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  reviewFindMany,
  reportFindMany,
} = vi.hoisted(() => ({
  reviewFindMany: vi.fn(),
  reportFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    review: {
      findMany: reviewFindMany,
    },
    report: {
      findMany: reportFindMany,
    },
  },
}));

import { getMyReports, getMyReviews } from "@/repositories/trust-repository";

describe("trust repository", () => {
  beforeEach(() => {
    reviewFindMany.mockReset();
    reportFindMany.mockReset();
  });

  it("returns written and received reviews with related users and orders", async () => {
    reviewFindMany
      .mockResolvedValueOnce([
        {
          id: "review-1",
          authorId: "user-1",
          targetUser: { id: "user-2", name: "卖家同学" },
          order: { id: "order-1", orderNo: "CM202607170001", type: "PRODUCT" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "review-2",
          targetUserId: "user-1",
          author: { id: "user-3", name: "买家同学" },
          order: { id: "order-2", orderNo: "CM202607170002", type: "SERVICE" },
        },
      ]);

    const result = await getMyReviews("user-1");

    expect(reviewFindMany).toHaveBeenNthCalledWith(1, {
      where: { authorId: "user-1" },
      orderBy: { createdAt: "desc" },
      include: {
        targetUser: {
          select: { id: true, name: true },
        },
        order: {
          select: {
            id: true,
            orderNo: true,
            type: true,
          },
        },
      },
    });
    expect(reviewFindMany).toHaveBeenNthCalledWith(2, {
      where: { targetUserId: "user-1" },
      orderBy: { createdAt: "desc" },
      include: {
        author: {
          select: { id: true, name: true },
        },
        order: {
          select: {
            id: true,
            orderNo: true,
            type: true,
          },
        },
      },
    });
    expect(result).toEqual({
      writtenReviews: [
        {
          id: "review-1",
          authorId: "user-1",
          targetUser: { id: "user-2", name: "卖家同学" },
          order: { id: "order-1", orderNo: "CM202607170001", type: "PRODUCT" },
        },
      ],
      receivedReviews: [
        {
          id: "review-2",
          targetUserId: "user-1",
          author: { id: "user-3", name: "买家同学" },
          order: { id: "order-2", orderNo: "CM202607170002", type: "SERVICE" },
        },
      ],
    });
  });

  it("returns reports with all supported target relations", async () => {
    reportFindMany.mockResolvedValue([
      {
        id: "report-1",
        reporterId: "user-1",
        product: { id: "product-1", title: "高数教材" },
        errandTask: null,
        serviceListing: null,
        targetUser: null,
        message: null,
      },
    ]);

    const result = await getMyReports("user-1");

    expect(reportFindMany).toHaveBeenCalledWith({
      where: { reporterId: "user-1" },
      orderBy: { createdAt: "desc" },
      include: {
        product: { select: { id: true, title: true } },
        errandTask: { select: { id: true, title: true } },
        serviceListing: { select: { id: true, title: true } },
        targetUser: { select: { id: true, name: true } },
        message: { select: { id: true, content: true } },
      },
    });
    expect(result).toEqual([
      {
        id: "report-1",
        reporterId: "user-1",
        product: { id: "product-1", title: "高数教材" },
        errandTask: null,
        serviceListing: null,
        targetUser: null,
        message: null,
      },
    ]);
  });
});
