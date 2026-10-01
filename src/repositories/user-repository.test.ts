import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getUnreadConversationCount,
  getUnreadNotificationCount,
  userFindFirst,
  productCount,
  errandTaskCount,
  serviceListingCount,
  campusFindMany,
  reviewAggregate,
} = vi.hoisted(() => ({
  getUnreadConversationCount: vi.fn(),
  getUnreadNotificationCount: vi.fn(),
  userFindFirst: vi.fn(),
  productCount: vi.fn(),
  errandTaskCount: vi.fn(),
  serviceListingCount: vi.fn(),
  campusFindMany: vi.fn(),
  // Phase 8E：好评率 = canonical visible Review 聚合
  reviewAggregate: vi.fn(),
}));

vi.mock("@/repositories/conversation-repository", () => ({
  getUnreadConversationCount,
}));

vi.mock("@/repositories/notification-repository", () => ({
  getUnreadNotificationCount,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findFirst: userFindFirst,
    },
    product: {
      count: productCount,
    },
    errandTask: {
      count: errandTaskCount,
    },
    serviceListing: {
      count: serviceListingCount,
    },
    campus: {
      findMany: campusFindMany,
    },
    review: {
      aggregate: reviewAggregate,
    },
  },
}));

import {
  getProfileDashboard,
  getPublicUserProfile,
  listActiveCampuses,
} from "@/repositories/user-repository";

describe("user repository", () => {
  beforeEach(() => {
    getUnreadConversationCount.mockReset();
    getUnreadNotificationCount.mockReset();
    userFindFirst.mockReset();
    productCount.mockReset();
    errandTaskCount.mockReset();
    serviceListingCount.mockReset();
    campusFindMany.mockReset();
    reviewAggregate.mockReset().mockResolvedValue({ _avg: { rating: 4.5 }, _count: { rating: 2 } });
  });

  it("returns profile dashboard data with unread counters", async () => {
    userFindFirst.mockResolvedValue({
      id: "user-1",
      name: "张同学",
      campus: { id: "campus-1", name: "主校区" },
      verification: null,
      _count: {
        products: 2,
        createdErrandTasks: 1,
        serviceListings: 3,
        buyerOrders: 4,
        sellerOrders: 5,
        notifications: 6,
      },
    });
    getUnreadNotificationCount.mockResolvedValue(7);
    getUnreadConversationCount.mockResolvedValue(8);

    const result = await getProfileDashboard("user-1");

    expect(userFindFirst).toHaveBeenCalledWith({
      where: {
        id: "user-1",
        deletedAt: null,
      },
      include: {
        campus: true,
        verification: true,
        _count: {
          select: {
            products: true,
            createdErrandTasks: true,
            serviceListings: true,
            buyerOrders: true,
            sellerOrders: true,
            notifications: true,
          },
        },
      },
    });
    expect(result).toEqual({
      user: {
        id: "user-1",
        name: "张同学",
        campus: { id: "campus-1", name: "主校区" },
        verification: null,
        _count: {
          products: 2,
          createdErrandTasks: 1,
          serviceListings: 3,
          buyerOrders: 4,
          sellerOrders: 5,
          notifications: 6,
        },
      },
      unreadNotifications: 7,
      unreadConversations: 8,
      // Phase 8E：published-only 评价统计（avg 4.5/5 = 0.9，count 2）
      publishedReviewCount: 2,
      publishedPositiveReviewRate: 0.9,
    });
  });

  it("queries only active public user content for the public profile page", async () => {
    userFindFirst.mockResolvedValue({
      id: "user-2",
      name: "李同学",
      products: [],
      createdErrandTasks: [],
      serviceListings: [],
    });
    productCount.mockResolvedValue(1);
    errandTaskCount.mockResolvedValue(2);
    serviceListingCount.mockResolvedValue(3);

    const result = await getPublicUserProfile("user-2");

    expect(userFindFirst).toHaveBeenCalledWith({
      where: {
        id: "user-2",
        deletedAt: null,
        status: "ACTIVE",
      },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        bio: true,
        schoolName: true,
        college: true,
        grade: true,
        verificationStatus: true,
        completedOrdersCount: true,
        createdAt: true,
        campus: {
          select: {
            id: true,
            name: true,
            schoolName: true,
          },
        },
        products: {
          where: {
            deletedAt: null,
            status: "ACTIVE",
            moderations: { none: { resolvedAt: null } },
          },
          orderBy: { createdAt: "desc" },
          take: 6,
          include: {
            category: true,
            images: {
              orderBy: { sortOrder: "asc" },
              take: 1,
            },
          },
        },
        serviceListings: {
          where: {
            deletedAt: null,
            status: "ACTIVE",
            moderations: { none: { resolvedAt: null } },
          },
          orderBy: { createdAt: "desc" },
          take: 6,
          include: {
            category: true,
          },
        },
        createdErrandTasks: {
          where: {
            deletedAt: null,
            status: "OPEN",
            moderations: { none: { resolvedAt: null } },
          },
          orderBy: { createdAt: "desc" },
          take: 6,
          include: {
            category: true,
          },
        },
      },
    });
    expect(productCount).toHaveBeenCalledWith({
      where: {
        sellerId: "user-2",
        deletedAt: null,
        status: "ACTIVE",
        moderations: { none: { resolvedAt: null } },
      },
    });
    expect(errandTaskCount).toHaveBeenCalledWith({
      where: {
        publisherId: "user-2",
        deletedAt: null,
        status: "OPEN",
        moderations: { none: { resolvedAt: null } },
      },
    });
    expect(serviceListingCount).toHaveBeenCalledWith({
      where: {
        providerId: "user-2",
        deletedAt: null,
        status: "ACTIVE",
        moderations: { none: { resolvedAt: null } },
      },
    });
    expect(result).toEqual({
      id: "user-2",
      name: "李同学",
      products: [],
      createdErrandTasks: [],
      serviceListings: [],
      visibleCounts: {
        products: 1,
        createdErrandTasks: 2,
        serviceListings: 3,
      },
      // Phase 8E：published-only 评价统计
      publishedReviewCount: 2,
      publishedPositiveReviewRate: 0.9,
    });
  });

  it("lists active campuses for the register page", async () => {
    campusFindMany.mockResolvedValue([
      { id: "campus-1", name: "主校区", schoolName: "示例大学" },
    ]);

    const result = await listActiveCampuses();

    expect(campusFindMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, schoolName: true },
    });
    expect(result).toEqual([
      { id: "campus-1", name: "主校区", schoolName: "示例大学" },
    ]);
  });
});
