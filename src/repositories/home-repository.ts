import { prisma } from "@/lib/prisma";
import { getUnreadConversationCount } from "@/repositories/conversation-repository";
import { getUnreadNotificationCount } from "@/repositories/notification-repository";

type HomepageCard = {
  id: string;
  href: string;
  title: string;
  subtitle: string;
  price: string;
  meta: string;
  reason: string;
  imageUrl?: string | null;
};

type HomepageQuery = {
  userId?: string;
  campusId?: string;
};

function formatPrice(value: { toString(): string }) {
  return `￥${value.toString()}`;
}

function mapProductCard(
  item: {
    id: string;
    title: string;
    locationText: string;
    price: { toString(): string };
    images: { url: string }[];
  },
  reason: string,
): HomepageCard {
  return {
    id: item.id,
    href: `/products/${item.id}`,
    title: item.title,
    subtitle: item.locationText,
    price: formatPrice(item.price),
    meta: "二手商品",
    reason,
    imageUrl: item.images[0]?.url ?? "/uploads/placeholders/product-cover.svg",
  };
}

function mapErrandCard(
  item: {
    id: string;
    title: string;
    pickupLocation: string;
    deliveryLocation: string;
    reward: { toString(): string };
  },
  reason: string,
): HomepageCard {
  return {
    id: item.id,
    href: `/errands/${item.id}`,
    title: item.title,
    subtitle: `${item.pickupLocation} -> ${item.deliveryLocation}`,
    price: formatPrice(item.reward),
    meta: "跑腿任务",
    reason,
    imageUrl: null,
  };
}

function mapServiceCard(
  item: {
    id: string;
    title: string;
    locationText: string;
    price: { toString(): string };
    coverImageUrl: string | null;
  },
  reason: string,
): HomepageCard {
  return {
    id: item.id,
    href: `/services/${item.id}`,
    title: item.title,
    subtitle: item.locationText,
    price: formatPrice(item.price),
    meta: "技能服务",
    reason,
    imageUrl:
      item.coverImageUrl ??
      "https://images.unsplash.com/photo-1521791136064-7986c2920216?auto=format&fit=crop&w=1200&q=80",
  };
}

export async function getHomepageData(query: HomepageQuery = {}) {
  const now = new Date();
  const campusWhere = query.campusId ? { campusId: query.campusId } : {};

  const [
    campuses,
    latestProducts,
    trendingProducts,
    budgetProducts,
    urgentErrands,
    highRewardErrands,
    verifiedServices,
    topServices,
    productCount,
    errandCount,
    serviceCount,
    userSummary,
  ] = await Promise.all([
    prisma.campus.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        schoolName: true,
      },
    }),
    prisma.product.findMany({
      where: { deletedAt: null, status: "ACTIVE", ...campusWhere },
      orderBy: { createdAt: "desc" },
      take: 6,
      include: {
        images: {
          orderBy: { sortOrder: "asc" },
          take: 1,
        },
      },
    }),
    prisma.product.findMany({
      where: { deletedAt: null, status: "ACTIVE", ...campusWhere },
      orderBy: [{ favoriteCount: "desc" }, { viewCount: "desc" }, { createdAt: "desc" }],
      take: 6,
      include: {
        images: {
          orderBy: { sortOrder: "asc" },
          take: 1,
        },
      },
    }),
    prisma.product.findMany({
      where: { deletedAt: null, status: "ACTIVE", ...campusWhere },
      orderBy: [{ price: "asc" }, { favoriteCount: "desc" }, { createdAt: "desc" }],
      take: 6,
      include: {
        images: {
          orderBy: { sortOrder: "asc" },
          take: 1,
        },
      },
    }),
    prisma.errandTask.findMany({
      where: { deletedAt: null, status: "OPEN", deadline: { gte: now }, ...campusWhere },
      orderBy: [{ deadline: "asc" }, { reward: "desc" }],
      take: 6,
    }),
    prisma.errandTask.findMany({
      where: { deletedAt: null, status: "OPEN", deadline: { gte: now }, ...campusWhere },
      orderBy: [{ reward: "desc" }, { deadline: "asc" }],
      take: 6,
    }),
    prisma.serviceListing.findMany({
      where: {
        deletedAt: null,
        status: "ACTIVE",
        ...campusWhere,
        provider: {
          verificationStatus: "VERIFIED",
        },
      },
      orderBy: [{ completedOrderCount: "desc" }, { createdAt: "desc" }],
      take: 6,
      select: {
        id: true,
        title: true,
        locationText: true,
        price: true,
        coverImageUrl: true,
      },
    }),
    prisma.serviceListing.findMany({
      where: { deletedAt: null, status: "ACTIVE", ...campusWhere },
      orderBy: [{ completedOrderCount: "desc" }, { createdAt: "desc" }],
      take: 6,
      select: {
        id: true,
        title: true,
        locationText: true,
        price: true,
        coverImageUrl: true,
      },
    }),
    prisma.product.count({ where: { deletedAt: null, status: "ACTIVE", ...campusWhere } }),
    prisma.errandTask.count({ where: { deletedAt: null, status: "OPEN", ...campusWhere } }),
    prisma.serviceListing.count({ where: { deletedAt: null, status: "ACTIVE", ...campusWhere } }),
    query.userId
      ? Promise.all([
          getUnreadNotificationCount(query.userId),
          getUnreadConversationCount(query.userId),
          prisma.order.count({
            where: {
              OR: [{ buyerId: query.userId }, { sellerId: query.userId }],
              status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS"] },
            },
          }),
        ]).then(([unreadNotifications, unreadConversations, activeOrders]) => ({
          unreadNotifications,
          unreadConversations,
          activeOrders,
        }))
      : Promise.resolve(null),
  ]);

  return {
    summary: {
      productCount,
      errandCount,
      serviceCount,
      campuses,
      selectedCampusId: campuses.some((item) => item.id === query.campusId) ? query.campusId ?? null : null,
      userSummary,
    },
    latestProducts: latestProducts.map((item) => mapProductCard(item, "刚刚上新")),
    trendingProducts: trendingProducts.map((item) => mapProductCard(item, "高热度推荐")),
    budgetProducts: budgetProducts.map((item) => mapProductCard(item, "低价优先")),
    urgentErrands: urgentErrands.map((item) => mapErrandCard(item, "临近截止")),
    highRewardErrands: highRewardErrands.map((item) => mapErrandCard(item, "高赏金回报")),
    verifiedServices: verifiedServices.map((item) => mapServiceCard(item, "认证服务者")),
    topServices: topServices.map((item) => mapServiceCard(item, "高完成度")),
  };
}
