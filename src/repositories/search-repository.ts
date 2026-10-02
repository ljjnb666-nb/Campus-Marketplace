import { ERRAND_PUBLIC_EXPOSURE_STATUS, PRODUCT_PUBLIC_EXPOSURE_STATUS, SERVICE_PUBLIC_EXPOSURE_STATUS } from "@/lib/listings/listing-lifecycle";
import { listingModerationPublicFilter } from "@/lib/moderation/listing-moderation-query";
import { prisma } from "@/lib/prisma";
import { getPublishedGeneralReviewStatsBatch } from "@/lib/reviews/review-query";

export async function getSearchResults(keyword: string) {
  const q = keyword.trim();

  if (!q) {
    return {
      products: [],
      errands: [],
      services: [],
      users: [],
    };
  }

  const contains = { contains: q, mode: "insensitive" as const };

  const [products, errands, services, users] = await Promise.all([
    prisma.product.findMany({
      where: {
        deletedAt: null,
        // Phase 8F：search = public discovery surface，exposure state only
        status: PRODUCT_PUBLIC_EXPOSURE_STATUS,
        ...listingModerationPublicFilter(),
        OR: [{ title: contains }, { description: contains }, { locationText: contains }],
      },
      include: {
        category: true,
        seller: { select: { id: true, name: true } },
        images: { orderBy: { sortOrder: "asc" }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
    prisma.errandTask.findMany({
      where: {
        deletedAt: null,
        // Phase 8F（§56）：search 只暴露 OPEN（此前的 CLAIMED/IN_PROGRESS/
        // PENDING_CONFIRMATION 属履约中 workflow 态，不是公开发现面）
        status: ERRAND_PUBLIC_EXPOSURE_STATUS,
        ...listingModerationPublicFilter(),
        OR: [{ title: contains }, { description: contains }, { pickupLocation: contains }, { deliveryLocation: contains }],
      },
      include: {
        publisher: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
    prisma.serviceListing.findMany({
      where: {
        deletedAt: null,
        status: SERVICE_PUBLIC_EXPOSURE_STATUS,
        ...listingModerationPublicFilter(),
        OR: [{ title: contains }, { description: contains }, { locationText: contains }],
      },
      include: {
        provider: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
    prisma.user.findMany({
      where: {
        deletedAt: null,
        status: "ACTIVE",
        OR: [{ name: contains }, { schoolName: contains }, { college: contains }, { bio: contains }],
      },
      select: {
        id: true,
        name: true,
        bio: true,
        schoolName: true,
        // Phase 8E：好评率由 getPublishedGeneralReviewStatsBatch canonical 覆写
        completedOrdersCount: true,
        campus: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { completedOrdersCount: "desc" },
      take: 12,
    }),
  ]);

  const userIds = users.map((user) => user.id);

  const [visibleProductGroups, visibleErrandGroups, visibleServiceGroups] =
    userIds.length > 0
      ? await Promise.all([
          prisma.product.groupBy({
            by: ["sellerId"],
            where: {
              sellerId: { in: userIds },
              deletedAt: null,
              status: PRODUCT_PUBLIC_EXPOSURE_STATUS,
              ...listingModerationPublicFilter(),
            },
            _count: {
              sellerId: true,
            },
          }),
          prisma.errandTask.groupBy({
            by: ["publisherId"],
            where: {
              publisherId: { in: userIds },
              deletedAt: null,
              status: ERRAND_PUBLIC_EXPOSURE_STATUS,
              ...listingModerationPublicFilter(),
            },
            _count: {
              publisherId: true,
            },
          }),
          prisma.serviceListing.groupBy({
            by: ["providerId"],
            where: {
              providerId: { in: userIds },
              deletedAt: null,
              status: SERVICE_PUBLIC_EXPOSURE_STATUS,
              ...listingModerationPublicFilter(),
            },
            _count: {
              providerId: true,
            },
          }),
        ])
      : [[], [], []];

  const visibleProductMap = new Map(
    visibleProductGroups.map((item) => [item.sellerId, item._count.sellerId]),
  );
  const visibleErrandMap = new Map(
    visibleErrandGroups.map((item) => [item.publisherId, item._count.publisherId]),
  );
  const visibleServiceMap = new Map(
    visibleServiceGroups.map((item) => [item.providerId, item._count.providerId]),
  );

  // Phase 8E（§19/§20）：搜索结果的用户好评率 = canonical visible 聚合（批量）
  const reviewStatsMap = await getPublishedGeneralReviewStatsBatch(users.map((user) => user.id));

  return {
    products,
    errands,
    services,
    users: users.map((user) => {
      const stats = reviewStatsMap.get(user.id) ?? { count: 0, positiveRate: 0 };
      return {
        ...user,
        positiveReviewRate: stats.positiveRate,
        publishedReviewCount: stats.count,
        visibleCounts: {
          products: visibleProductMap.get(user.id) ?? 0,
          createdErrandTasks: visibleErrandMap.get(user.id) ?? 0,
          serviceListings: visibleServiceMap.get(user.id) ?? 0,
        },
      };
    }),
  };
}
