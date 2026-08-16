import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getUnreadConversationCount,
  getUnreadNotificationCount,
  campusFindMany,
  productFindMany,
  errandTaskFindMany,
  serviceListingFindMany,
  productCount,
  errandTaskCount,
  serviceListingCount,
  orderCount,
} = vi.hoisted(() => ({
  getUnreadConversationCount: vi.fn(),
  getUnreadNotificationCount: vi.fn(),
  campusFindMany: vi.fn(),
  productFindMany: vi.fn(),
  errandTaskFindMany: vi.fn(),
  serviceListingFindMany: vi.fn(),
  productCount: vi.fn(),
  errandTaskCount: vi.fn(),
  serviceListingCount: vi.fn(),
  orderCount: vi.fn(),
}));

vi.mock("@/repositories/conversation-repository", () => ({
  getUnreadConversationCount,
}));

vi.mock("@/repositories/notification-repository", () => ({
  getUnreadNotificationCount,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campus: {
      findMany: campusFindMany,
    },
    product: {
      findMany: productFindMany,
      count: productCount,
    },
    errandTask: {
      findMany: errandTaskFindMany,
      count: errandTaskCount,
    },
    serviceListing: {
      findMany: serviceListingFindMany,
      count: serviceListingCount,
    },
    order: {
      count: orderCount,
    },
  },
}));

import {
  getHomepageErrands,
  getHomepageProducts,
  getHomepageServices,
  getHomepageSummary,
} from "@/repositories/home-repository";

describe("home repository", () => {
  beforeEach(() => {
    getUnreadConversationCount.mockReset();
    getUnreadNotificationCount.mockReset();
    campusFindMany.mockReset();
    productFindMany.mockReset();
    errandTaskFindMany.mockReset();
    serviceListingFindMany.mockReset();
    productCount.mockReset();
    errandTaskCount.mockReset();
    serviceListingCount.mockReset();
    orderCount.mockReset();
  });

  it("returns the homepage summary and user summary for a logged-in user", async () => {
    campusFindMany.mockResolvedValue([
      { id: "campus-1", name: "主校区", schoolName: "校园大学" },
    ]);
    productCount.mockResolvedValue(21);
    errandTaskCount.mockResolvedValue(9);
    serviceListingCount.mockResolvedValue(6);
    getUnreadNotificationCount.mockResolvedValue(4);
    getUnreadConversationCount.mockResolvedValue(3);
    orderCount.mockResolvedValue(5);

    const result = await getHomepageSummary({ userId: "user-1" });

    expect(result).toEqual({
      productCount: 21,
      errandCount: 9,
      serviceCount: 6,
      campuses: [{ id: "campus-1", name: "主校区", schoolName: "校园大学" }],
      selectedCampusId: null,
      userSummary: {
        unreadNotifications: 4,
        unreadConversations: 3,
        activeOrders: 5,
      },
    });
    expect(orderCount).toHaveBeenCalledWith({
      where: {
        OR: [{ buyerId: "user-1" }, { sellerId: "user-1" }],
        status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS"] },
      },
    });
  });

  it("returns a null user summary when there is no logged-in user", async () => {
    campusFindMany.mockResolvedValue([]);
    productCount.mockResolvedValue(0);
    errandTaskCount.mockResolvedValue(0);
    serviceListingCount.mockResolvedValue(0);

    const result = await getHomepageSummary();

    expect(result.userSummary).toBeNull();
    expect(getUnreadNotificationCount).not.toHaveBeenCalled();
    expect(getUnreadConversationCount).not.toHaveBeenCalled();
    expect(orderCount).not.toHaveBeenCalled();
  });

  it("marks the selected campus only when it exists", async () => {
    campusFindMany.mockResolvedValue([
      { id: "campus-1", name: "主校区", schoolName: "校园大学" },
      { id: "campus-2", name: "东校区", schoolName: "校园大学" },
    ]);
    productCount.mockResolvedValue(0);
    errandTaskCount.mockResolvedValue(0);
    serviceListingCount.mockResolvedValue(0);

    const result = await getHomepageSummary({ campusId: "campus-2" });

    expect(result.selectedCampusId).toBe("campus-2");
    expect(productCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ campusId: "campus-2" }),
      }),
    );

    const unknownCampus = await getHomepageSummary({ campusId: "campus-404" });
    expect(unknownCampus.selectedCampusId).toBeNull();
  });

  it("maps the three product sections with the local placeholder fallback", async () => {
    productFindMany
      .mockResolvedValueOnce([
        {
          id: "product-1",
          title: "高数教材",
          locationText: "图书馆门口",
          price: { toString: () => "18" },
          images: [{ url: "https://example.com/product.jpg" }],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "product-2",
          title: "宿舍小风扇",
          locationText: "一号宿舍楼",
          price: { toString: () => "25" },
          images: [{ url: "https://example.com/fan.jpg" }],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "product-3",
          title: "二手耳机",
          locationText: "食堂门口",
          price: { toString: () => "12" },
          images: [],
        },
      ]);

    const result = await getHomepageProducts({ campusId: "campus-2" });

    expect(productFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ campusId: "campus-2" }),
      }),
    );
    expect(result.latestProducts[0]).toEqual({
      id: "product-1",
      href: "/products/product-1",
      title: "高数教材",
      subtitle: "图书馆门口",
      price: "￥18",
      meta: "二手商品",
      reason: "刚刚上新",
      imageUrl: "https://example.com/product.jpg",
    });
    expect(result.trendingProducts[0].reason).toBe("高热度推荐");
    expect(result.budgetProducts[0].imageUrl).toBe(
      "/uploads/placeholders/product-cover.svg",
    );
  });

  it("maps the two errand sections", async () => {
    errandTaskFindMany
      .mockResolvedValueOnce([
        {
          id: "errand-1",
          title: "帮我取快递",
          pickupLocation: "东区快递站",
          deliveryLocation: "6号宿舍楼",
          reward: { toString: () => "8" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "errand-2",
          title: "代买晚饭",
          pickupLocation: "一食堂",
          deliveryLocation: "教学楼",
          reward: { toString: () => "15" },
        },
      ]);

    const result = await getHomepageErrands({ campusId: "campus-2" });

    expect(errandTaskFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          campusId: "campus-2",
          status: "OPEN",
          deletedAt: null,
        }),
      }),
    );
    expect(result.urgentErrands[0]).toEqual({
      id: "errand-1",
      href: "/errands/errand-1",
      title: "帮我取快递",
      subtitle: "东区快递站 -> 6号宿舍楼",
      price: "￥8",
      meta: "跑腿任务",
      reason: "临近截止",
      imageUrl: null,
    });
    expect(result.highRewardErrands[0].reason).toBe("高赏金回报");
  });

  it("maps the two service sections with the local placeholder fallback", async () => {
    serviceListingFindMany
      .mockResolvedValueOnce([
        {
          id: "service-1",
          title: "高数辅导",
          locationText: "图书馆自习区",
          price: { toString: () => "50" },
          coverImageUrl: "https://example.com/tutor.jpg",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "service-2",
          title: "PPT排版",
          locationText: "线上沟通",
          price: { toString: () => "30" },
          coverImageUrl: null,
        },
      ]);

    const result = await getHomepageServices({ campusId: "campus-2" });

    expect(serviceListingFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          campusId: "campus-2",
          status: "ACTIVE",
          deletedAt: null,
          provider: { verificationStatus: "VERIFIED" },
        }),
      }),
    );
    expect(result.verifiedServices[0]).toEqual({
      id: "service-1",
      href: "/services/service-1",
      title: "高数辅导",
      subtitle: "图书馆自习区",
      price: "￥50",
      meta: "技能服务",
      reason: "认证服务者",
      imageUrl: "https://example.com/tutor.jpg",
    });
    expect(result.topServices[0].imageUrl).toBe(
      "/uploads/placeholders/product-cover.svg",
    );
  });
});
