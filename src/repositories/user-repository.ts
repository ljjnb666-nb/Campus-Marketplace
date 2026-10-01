import { notFound } from "next/navigation";
import { listingModerationPublicFilter } from "@/lib/moderation/listing-moderation-query";
import { prisma } from "@/lib/prisma";
import { getPublishedGeneralReviewStats } from "@/lib/reviews/review-query";
import { getUnreadConversationCount } from "@/repositories/conversation-repository";
import { getUnreadNotificationCount } from "@/repositories/notification-repository";

// 注册页:列出启用中的校区(按创建时间升序)
export async function listActiveCampuses() {
  return prisma.campus.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, schoolName: true },
  });
}

// Phase 7G：用户 ACTIVE membership 的校区（/support 创建表单校区下拉用，
// 仅呈现；scope 授权真相由 canonical 服务在锁内独立复核）
export async function listActiveMembershipCampuses(userId: string) {
  return prisma.campusMembership.findMany({
    where: { userId, status: "ACTIVE" },
    select: { campus: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function getProfileDashboard(userId: string) {
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
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

  if (!user) {
    notFound();
  }

  const [unreadNotifications, unreadConversations, publishedGeneralStats] = await Promise.all([
    getUnreadNotificationCount(userId),
    getUnreadConversationCount(userId),
    // Phase 8E：好评率 = canonical visible 评价（blind/纠纷隐藏评价不进入）
    getPublishedGeneralReviewStats(userId),
  ]);

  return {
    user,
    unreadNotifications,
    unreadConversations,
    publishedReviewCount: publishedGeneralStats.count,
    publishedPositiveReviewRate: publishedGeneralStats.positiveRate,
  };
}

export async function getPublicUserProfile(userId: string) {
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
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
      // Phase 8E（§21）：好评率不再读 User.positiveReviewRate（stale
      // denormalized cache）——返回 canonical visible 评价统计
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
          ...listingModerationPublicFilter(),
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
          ...listingModerationPublicFilter(),
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
          ...listingModerationPublicFilter(),
        },
        orderBy: { createdAt: "desc" },
        take: 6,
        include: {
          category: true,
        },
      },
    },
  });

  if (!user) {
    notFound();
  }

  const [productCount, errandCount, serviceCount, publishedGeneralStats] = await Promise.all([
    prisma.product.count({
      where: {
        sellerId: userId,
        deletedAt: null,
        status: "ACTIVE",
        ...listingModerationPublicFilter(),
      },
    }),
    prisma.errandTask.count({
      where: {
        publisherId: userId,
        deletedAt: null,
        status: "OPEN",
        ...listingModerationPublicFilter(),
      },
    }),
    prisma.serviceListing.count({
      where: {
        providerId: userId,
        deletedAt: null,
        status: "ACTIVE",
        ...listingModerationPublicFilter(),
      },
    }),
    getPublishedGeneralReviewStats(userId),
  ]);

  return {
    ...user,
    // Phase 8E：公开评价信号 = published-only（§21：publishedReviewCount == 0
    // → 暂无评价；禁止再用 completedOrdersCount 猜测"是否有评价"）
    publishedReviewCount: publishedGeneralStats.count,
    publishedPositiveReviewRate: publishedGeneralStats.positiveRate,
    visibleCounts: {
      products: productCount,
      createdErrandTasks: errandCount,
      serviceListings: serviceCount,
    },
  };
}
