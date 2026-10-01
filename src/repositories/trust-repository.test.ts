import { beforeEach, describe, expect, it, vi } from "vitest";

const { reportFindMany } = vi.hoisted(() => ({
  reportFindMany: vi.fn(),
}));

const getMyReviewsReadModel = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    report: {
      findMany: reportFindMany,
    },
  },
}));

// Phase 8E：getMyReviews 完全委托 canonical read model——委托合同是本测试
// 的唯一域（visible 谓词/归一化由 review-query 单测 + 真实 PG 集成覆盖）
vi.mock("@/lib/reviews/review-query", () => ({
  getMyReviewsReadModel,
}));

import { getMyReports, getMyReviews } from "@/repositories/trust-repository";

describe("trust repository", () => {
  beforeEach(() => {
    reportFindMany.mockReset();
    getMyReviewsReadModel.mockReset();
  });

  it("getMyReviews 委托 canonical read model（written 全量 + received visible-only）", async () => {
    const readModel = {
      written: [
        {
          id: "review-1",
          orderNo: "CM202607170001",
          orderTypeLabel: "二手商品",
          counterpartyName: "卖家同学",
          rating: 5,
          content: null,
          tags: [],
          createdAt: new Date("2026-07-17T08:00:00.000Z"),
          statusLabel: "已公开",
        },
      ],
      received: [
        {
          id: "review-2",
          orderNo: "CM202607170002",
          orderTypeLabel: "技能服务",
          counterpartyName: "买家同学",
          rating: 4,
          content: null,
          tags: [],
          createdAt: new Date("2026-07-17T09:00:00.000Z"),
          statusLabel: null,
        },
      ],
    };
    getMyReviewsReadModel.mockResolvedValue(readModel);

    expect(await getMyReviews("user-1")).toBe(readModel);
    expect(getMyReviewsReadModel).toHaveBeenCalledWith("user-1");
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
