import { prisma } from "@/lib/prisma";
import { listingModerationPublicFilter } from "@/lib/moderation/listing-moderation-query";
import { cachedPublicRead, PUBLIC_LISTING_TTL_MS } from "@/lib/public-cache";
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

// 服务卡片没有专属占位图,复用本地上传目录中的商品占位图,避免依赖远程图床。
const SERVICE_COVER_PLACEHOLDER = "/uploads/placeholders/product-cover.svg";

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
    imageUrl: item.coverImageUrl ?? SERVICE_COVER_PLACEHOLDER,
  };
}

// 首页各区块拆分为独立查询函数,配合 Suspense 流式渲染:
// 页面外壳先行输出,各区块数据到齐后逐段流入,互不阻塞。

/** 登录用户的私有摘要（未读数/进行中订单）——身份相关，绝不进入公开缓存。 */
async function getUserSummary(userId: string) {
  const [unreadNotifications, unreadConversations, activeOrders] = await Promise.all([
    getUnreadNotificationCount(userId),
    getUnreadConversationCount(userId),
    prisma.order.count({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS"] },
      },
    }),
  ]);
  return { unreadNotifications, unreadConversations, activeOrders };
}

// FINAL REPAIR A（LR-011）：公开共享读接入进程内 TTL 缓存（key 仅 campusId
// 低基数维度，SLA 见 src/lib/public-cache.ts）；userSummary 保持每请求实时。
export async function getHomepageSummary(query: HomepageQuery = {}) {
  const campusId = query.campusId;

  const [summary, userSummary] = await Promise.all([
    cachedPublicRead(`homepage-summary:${campusId ?? "all"}`, PUBLIC_LISTING_TTL_MS, async () => {
      const campusWhere = campusId ? { campusId } : {};
      const [campuses, productCount, errandCount, serviceCount] = await Promise.all([
        prisma.campus.findMany({
          where: { isActive: true },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            schoolName: true,
          },
        }),
        prisma.product.count({ where: { deletedAt: null, status: "ACTIVE", ...campusWhere, ...listingModerationPublicFilter() } }),
        prisma.errandTask.count({ where: { deletedAt: null, status: "OPEN", ...campusWhere, ...listingModerationPublicFilter() } }),
        prisma.serviceListing.count({ where: { deletedAt: null, status: "ACTIVE", ...campusWhere, ...listingModerationPublicFilter() } }),
      ]);
      return {
        productCount,
        errandCount,
        serviceCount,
        campuses,
        selectedCampusId: campuses.some((item) => item.id === campusId) ? campusId ?? null : null,
      };
    }),
    query.userId ? getUserSummary(query.userId) : Promise.resolve(null),
  ]);

  return {
    ...summary,
    userSummary,
  };
}

// 三个区块的原始查询体保持原样提取为 load* 函数，导出侧统一接入公开 TTL 缓存。

async function loadHomepageProducts(query: { campusId?: string } = {}) {
  const campusWhere = query.campusId ? { campusId: query.campusId } : {};

  const [latestProducts, trendingProducts, budgetProducts] = await Promise.all([
    prisma.product.findMany({
      where: { deletedAt: null, status: "ACTIVE", ...campusWhere, ...listingModerationPublicFilter() },
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
      where: { deletedAt: null, status: "ACTIVE", ...campusWhere, ...listingModerationPublicFilter() },
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
      where: { deletedAt: null, status: "ACTIVE", ...campusWhere, ...listingModerationPublicFilter() },
      orderBy: [{ price: "asc" }, { favoriteCount: "desc" }, { createdAt: "desc" }],
      take: 6,
      include: {
        images: {
          orderBy: { sortOrder: "asc" },
          take: 1,
        },
      },
    }),
  ]);

  return {
    latestProducts: latestProducts.map((item) => mapProductCard(item, "刚刚上新")),
    trendingProducts: trendingProducts.map((item) => mapProductCard(item, "高热度推荐")),
    budgetProducts: budgetProducts.map((item) => mapProductCard(item, "低价优先")),
  };
}

export async function getHomepageProducts(query: { campusId?: string } = {}) {
  return cachedPublicRead(`homepage-products:${query.campusId ?? "all"}`, PUBLIC_LISTING_TTL_MS, () =>
    loadHomepageProducts(query),
  );
}

async function loadHomepageErrands(query: { campusId?: string } = {}) {
  const campusWhere = query.campusId ? { campusId: query.campusId } : {};
  const now = new Date();

  const [urgentErrands, highRewardErrands] = await Promise.all([
    prisma.errandTask.findMany({
      where: { deletedAt: null, status: "OPEN", deadline: { gte: now }, ...campusWhere, ...listingModerationPublicFilter() },
      orderBy: [{ deadline: "asc" }, { reward: "desc" }],
      take: 6,
    }),
    prisma.errandTask.findMany({
      where: { deletedAt: null, status: "OPEN", deadline: { gte: now }, ...campusWhere, ...listingModerationPublicFilter() },
      orderBy: [{ reward: "desc" }, { deadline: "asc" }],
      take: 6,
    }),
  ]);

  return {
    urgentErrands: urgentErrands.map((item) => mapErrandCard(item, "临近截止")),
    highRewardErrands: highRewardErrands.map((item) => mapErrandCard(item, "高赏金回报")),
  };
}

export async function getHomepageErrands(query: { campusId?: string } = {}) {
  return cachedPublicRead(`homepage-errands:${query.campusId ?? "all"}`, PUBLIC_LISTING_TTL_MS, () =>
    loadHomepageErrands(query),
  );
}

async function loadHomepageServices(query: { campusId?: string } = {}) {
  const campusWhere = query.campusId ? { campusId: query.campusId } : {};

  const [verifiedServices, topServices] = await Promise.all([
    prisma.serviceListing.findMany({
      where: {
        deletedAt: null,
        status: "ACTIVE",
        ...campusWhere,
        ...listingModerationPublicFilter(),
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
      where: { deletedAt: null, status: "ACTIVE", ...campusWhere, ...listingModerationPublicFilter() },
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
  ]);

  return {
    verifiedServices: verifiedServices.map((item) => mapServiceCard(item, "认证服务者")),
    topServices: topServices.map((item) => mapServiceCard(item, "高完成度")),
  };
}

export async function getHomepageServices(query: { campusId?: string } = {}) {
  return cachedPublicRead(`homepage-services:${query.campusId ?? "all"}`, PUBLIC_LISTING_TTL_MS, () =>
    loadHomepageServices(query),
  );
}
