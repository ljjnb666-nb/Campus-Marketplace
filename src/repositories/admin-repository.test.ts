import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  userVerificationFindMany,
  userVerificationCount,
  reportFindMany,
  reportCount,
  userCount,
  productCount,
  errandTaskCount,
  productCategoryFindMany,
  errandCategoryFindMany,
  serviceCategoryFindMany,
  moderationKeywordFindMany,
} = vi.hoisted(() => ({
  userVerificationFindMany: vi.fn(),
  userVerificationCount: vi.fn(),
  reportFindMany: vi.fn(),
  reportCount: vi.fn(),
  userCount: vi.fn(),
  productCount: vi.fn(),
  errandTaskCount: vi.fn(),
  productCategoryFindMany: vi.fn(),
  errandCategoryFindMany: vi.fn(),
  serviceCategoryFindMany: vi.fn(),
  moderationKeywordFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    userVerification: {
      findMany: userVerificationFindMany,
      count: userVerificationCount,
    },
    report: {
      findMany: reportFindMany,
      count: reportCount,
    },
    user: {
      count: userCount,
    },
    product: {
      count: productCount,
    },
    errandTask: {
      count: errandTaskCount,
    },
    productCategory: {
      findMany: productCategoryFindMany,
    },
    errandCategory: {
      findMany: errandCategoryFindMany,
    },
    serviceCategory: {
      findMany: serviceCategoryFindMany,
    },
    moderationKeyword: {
      findMany: moderationKeywordFindMany,
    },
  },
}));

import {
  getAdminCategoryList,
  getAdminDashboardData,
  getAdminErrandCategoryList,
  getAdminModerationKeywords,
  getAdminServiceCategoryList,
  getReportReviewQueue,
  getVerificationReviewQueue,
} from "@/repositories/admin-repository";

describe("admin repository", () => {
  beforeEach(() => {
    userVerificationFindMany.mockReset();
    userVerificationCount.mockReset();
    reportFindMany.mockReset();
    reportCount.mockReset();
    userCount.mockReset();
    productCount.mockReset();
    errandTaskCount.mockReset();
    productCategoryFindMany.mockReset();
    errandCategoryFindMany.mockReset();
    serviceCategoryFindMany.mockReset();
    moderationKeywordFindMany.mockReset();
  });

  it("returns dashboard data with pending queues and daily counters", async () => {
    userVerificationFindMany.mockResolvedValue([{ id: "verification-1" }]);
    reportFindMany.mockResolvedValue([{ id: "report-1" }]);
    reportCount.mockResolvedValueOnce(6).mockResolvedValueOnce(2).mockResolvedValueOnce(6);
    userVerificationCount.mockResolvedValueOnce(4).mockResolvedValueOnce(3);
    userCount.mockResolvedValueOnce(42).mockResolvedValueOnce(5);
    productCount.mockResolvedValueOnce(20).mockResolvedValueOnce(12).mockResolvedValueOnce(3);
    errandTaskCount.mockResolvedValueOnce(10).mockResolvedValueOnce(7);

    const result = await getAdminDashboardData();

    expect(result).toEqual({
      pendingVerifications: [{ id: "verification-1" }],
      openReports: [{ id: "report-1" }],
      latestReports: 6,
      latestVerifications: 4,
      todayNewReports: 2,
      todayNewVerifications: 3,
      totalUsers: 42,
      todayNewUsers: 5,
      totalProducts: 20,
      activeProducts: 12,
      todayNewProducts: 3,
      totalErrands: 10,
      completedErrands: 7,
      totalReports: 6,
    });
    expect(reportFindMany).toHaveBeenCalledWith({
      where: { status: "OPEN" },
      orderBy: { createdAt: "asc" },
      include: {
        reporter: {
          select: {
            id: true,
            name: true,
          },
        },
        product: {
          select: {
            id: true,
            title: true,
          },
        },
        errandTask: {
          select: {
            id: true,
            title: true,
          },
        },
        serviceListing: {
          select: {
            id: true,
            title: true,
          },
        },
        targetUser: {
          select: {
            id: true,
            name: true,
          },
        },
        message: {
          select: {
            id: true,
            content: true,
          },
        },
      },
      take: 8,
    });
    expect(userCount).toHaveBeenNthCalledWith(1, {
      where: {
        deletedAt: null,
      },
    });
    expect(userCount).toHaveBeenNthCalledWith(2, {
      where: {
        deletedAt: null,
        createdAt: {
          gte: expect.any(Date),
        },
      },
    });
    expect(productCount).toHaveBeenNthCalledWith(1, {
      where: {
        deletedAt: null,
      },
    });
    expect(productCount).toHaveBeenNthCalledWith(2, {
      where: {
        deletedAt: null,
        status: "ACTIVE",
      },
    });
    expect(productCount).toHaveBeenNthCalledWith(3, {
      where: {
        deletedAt: null,
        createdAt: {
          gte: expect.any(Date),
        },
      },
    });
    expect(errandTaskCount).toHaveBeenNthCalledWith(1, {
      where: {
        deletedAt: null,
      },
    });
    expect(errandTaskCount).toHaveBeenNthCalledWith(2, {
      where: {
        deletedAt: null,
        status: "COMPLETED",
      },
    });
    expect(reportCount).toHaveBeenNthCalledWith(3);
  });

  it("returns the report review queue with all supported target relations", async () => {
    reportFindMany.mockResolvedValue([{ id: "report-2" }]);

    const result = await getReportReviewQueue();

    expect(reportFindMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["OPEN", "IN_REVIEW"] },
      },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      include: {
        reporter: {
          select: {
            id: true,
            name: true,
          },
        },
        product: {
          select: {
            id: true,
            title: true,
          },
        },
        errandTask: {
          select: {
            id: true,
            title: true,
          },
        },
        serviceListing: {
          select: {
            id: true,
            title: true,
          },
        },
        targetUser: {
          select: {
            id: true,
            name: true,
          },
        },
        message: {
          select: {
            id: true,
            content: true,
          },
        },
      },
      take: 50,
    });
    expect(result).toEqual([{ id: "report-2" }]);
  });

  it("returns the verification review queue bounded with sort and take", async () => {
    userVerificationFindMany.mockResolvedValue([{ id: "verification-2" }]);

    const result = await getVerificationReviewQueue();

    expect(userVerificationFindMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["PENDING", "REJECTED"] },
      },
      orderBy: [{ status: "asc" }, { submittedAt: "asc" }],
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            schoolName: true,
            campus: {
              select: {
                name: true,
              },
            },
          },
        },
      },
      take: 50,
    });
    expect(result).toEqual([{ id: "verification-2" }]);
  });

  it("returns product, errand, service categories and moderation keywords in admin order", async () => {
    productCategoryFindMany.mockResolvedValue([{ id: "product-category-1" }]);
    errandCategoryFindMany.mockResolvedValue([{ id: "errand-category-1" }]);
    serviceCategoryFindMany.mockResolvedValue([{ id: "service-category-1" }]);
    moderationKeywordFindMany.mockResolvedValue([{ id: "keyword-1" }]);

    const [productCategories, errandCategories, serviceCategories, keywords] = await Promise.all([
      getAdminCategoryList(),
      getAdminErrandCategoryList(),
      getAdminServiceCategoryList(),
      getAdminModerationKeywords(),
    ]);

    expect(serviceCategoryFindMany).toHaveBeenCalledWith({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        _count: {
          select: {
            serviceListings: true,
          },
        },
      },
    });
    expect(productCategories).toEqual([{ id: "product-category-1" }]);
    expect(errandCategories).toEqual([{ id: "errand-category-1" }]);
    expect(serviceCategories).toEqual([{ id: "service-category-1" }]);
    expect(keywords).toEqual([{ id: "keyword-1" }]);
  });
});
