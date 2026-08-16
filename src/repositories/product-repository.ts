import { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export type ProductListQuery = {
  q?: string;
  category?: string;
  status?: "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE" | "ALL";
  minPrice?: string;
  maxPrice?: string;
  sort?: "latest" | "price_asc" | "price_desc" | "popular";
  page?: number;
  currentUserId?: string;
};

const PAGE_SIZE = 12;

function getProductOrderBy(sort: ProductListQuery["sort"]) {
  switch (sort) {
    case "price_asc":
      return [{ price: "asc" as const }, { createdAt: "desc" as const }];
    case "price_desc":
      return [{ price: "desc" as const }, { createdAt: "desc" as const }];
    case "popular":
      return [
        { favoriteCount: "desc" as const },
        { viewCount: "desc" as const },
        { createdAt: "desc" as const },
      ];
    case "latest":
    default:
      return [{ createdAt: "desc" as const }];
  }
}

function getPriceFilter(minPrice?: string, maxPrice?: string) {
  const min = minPrice ? Number(minPrice) : undefined;
  const max = maxPrice ? Number(maxPrice) : undefined;

  if ((min !== undefined && Number.isNaN(min)) || (max !== undefined && Number.isNaN(max))) {
    return undefined;
  }

  if (min === undefined && max === undefined) {
    return undefined;
  }

  return {
    ...(min !== undefined ? { gte: new Prisma.Decimal(min) } : {}),
    ...(max !== undefined ? { lte: new Prisma.Decimal(max) } : {}),
  };
}

function getProductRecommendationScore(
  item: {
    campusId: string;
    categoryId: string;
    seller: { verificationStatus: string };
    favoriteCount: number;
    viewCount: number;
    createdAt: Date;
  },
  target: {
    campusId: string;
    categoryId: string;
  },
) {
  let score = 0;

  if (item.campusId === target.campusId) {
    score += 40;
  }

  if (item.categoryId === target.categoryId) {
    score += 35;
  }

  if (item.seller.verificationStatus === "VERIFIED") {
    score += 10;
  }

  score += Math.min(item.favoriteCount, 20);
  score += Math.min(Math.floor(item.viewCount / 5), 15);

  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
  );
  score += Math.max(0, 10 - ageDays);

  return score;
}

function getProductRecommendationReason(
  item: {
    campusId: string;
    categoryId: string;
    seller: { verificationStatus: string };
    favoriteCount: number;
  },
  target: {
    campusId: string;
    categoryId: string;
  },
) {
  if (item.campusId === target.campusId && item.categoryId === target.categoryId) {
    return "同校区同分类";
  }

  if (item.categoryId === target.categoryId) {
    return "同分类推荐";
  }

  if (item.campusId === target.campusId) {
    return "同校区推荐";
  }

  if (item.seller.verificationStatus === "VERIFIED") {
    return "认证卖家";
  }

  if (item.favoriteCount >= 5) {
    return "人气较高";
  }

  return "为你推荐";
}

export async function getProductList(query: ProductListQuery = {}) {
  const priceFilter = getPriceFilter(query.minPrice, query.maxPrice);
  const where = {
    deletedAt: null,
    ...(query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: "insensitive" as const } },
            { description: { contains: query.q, mode: "insensitive" as const } },
            { locationText: { contains: query.q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(query.category ? { categoryId: query.category } : {}),
    ...(query.status && query.status !== "ALL" ? { status: query.status } : {}),
    ...(priceFilter ? { price: priceFilter } : {}),
  };

  const page = Math.max(1, query.page ?? 1);
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: getProductOrderBy(query.sort),
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        category: true,
        seller: {
          select: {
            id: true,
            name: true,
            verificationStatus: true,
            schoolName: true,
          },
        },
        images: {
          orderBy: { sortOrder: "asc" },
          take: 1,
        },
        favorites: query.currentUserId
          ? {
              where: { userId: query.currentUserId },
              select: { id: true },
              take: 1,
            }
          : false,
      },
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getProductFormMeta() {
  const campuses = await prisma.campus.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, schoolName: true },
  });

  const categories = await prisma.productCategory.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, slug: true },
  });

  return { campuses, categories };
}

export async function getProductDetail(
  productId: string,
  currentUserId?: string,
  options?: { countView?: boolean },
) {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    include: {
      category: true,
      campus: true,
      seller: {
        select: {
          id: true,
          name: true,
          schoolName: true,
          verificationStatus: true,
          completedOrdersCount: true,
          positiveReviewRate: true,
          createdAt: true,
        },
      },
      images: {
        orderBy: { sortOrder: "asc" },
      },
      favorites: currentUserId
        ? {
            where: { userId: currentUserId },
            select: { id: true },
            take: 1,
          }
        : false,
    },
  });

  if (!product) {
    notFound();
  }

  // generateMetadata 等只读调用传 countView: false，避免浏览量被重复计数
  if (options?.countView !== false) {
    await prisma.product.update({
      where: { id: product.id },
      data: { viewCount: { increment: 1 } },
    });
  }

  const recommendationPool = await prisma.product.findMany({
    where: {
      deletedAt: null,
      status: "ACTIVE",
      id: { not: product.id },
      OR: [{ campusId: product.campusId }, { categoryId: product.categoryId }],
    },
    take: 18,
    include: {
      category: true,
      images: {
        orderBy: { sortOrder: "asc" },
        take: 1,
      },
      seller: {
        select: {
          name: true,
          verificationStatus: true,
        },
      },
      favorites: currentUserId
        ? {
            where: { userId: currentUserId },
            select: { id: true },
            take: 1,
          }
        : false,
    },
  });

  const relatedProducts = recommendationPool
    .sort((a, b) => {
      return (
        getProductRecommendationScore(b, {
          campusId: product.campusId,
          categoryId: product.categoryId,
        }) -
        getProductRecommendationScore(a, {
          campusId: product.campusId,
          categoryId: product.categoryId,
        })
      );
    })
    .slice(0, 3)
    .map((item) => ({
      ...item,
      reason: getProductRecommendationReason(item, {
        campusId: product.campusId,
        categoryId: product.categoryId,
      }),
    }));

  return { product, relatedProducts };
}

export async function getProductForEdit(productId: string, userId: string) {
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      sellerId: userId,
      deletedAt: null,
    },
    include: {
      images: {
        orderBy: { sortOrder: "asc" },
      },
    },
  });

  if (!product) {
    notFound();
  }

  return product;
}

export async function getMyProducts(userId: string) {
  return prisma.product.findMany({
    where: {
      sellerId: userId,
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    // 个人商品列表仅保留最近 100 条，避免无界查询
    take: 100,
    include: {
      category: true,
      images: {
        orderBy: { sortOrder: "asc" },
        take: 1,
      },
    },
  });
}

export async function getMyFavoriteProducts(userId: string) {
  return prisma.favorite.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    // 收藏列表仅保留最近 100 条，避免无界查询
    take: 100,
    include: {
      product: {
        include: {
          category: true,
          seller: {
            select: {
              name: true,
            },
          },
          images: {
            orderBy: { sortOrder: "asc" },
            take: 1,
          },
        },
      },
    },
  });
}
