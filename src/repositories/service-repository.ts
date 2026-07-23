import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export type ServiceListQuery = {
  q?: string;
  status?: "ACTIVE" | "PAUSED" | "OFFLINE" | "ALL";
  pricingUnit?: "PER_SESSION" | "PER_HOUR" | "PER_ORDER" | "NEGOTIABLE" | "ALL";
  categorySlug?: string;
  verifiedOnly?: boolean;
  sort?: "latest" | "price_asc" | "price_desc" | "orders_desc";
  page?: number;
};

const PAGE_SIZE = 12;

function getServiceOrderBy(sort: ServiceListQuery["sort"]) {
  switch (sort) {
    case "price_asc":
      return [{ price: "asc" as const }, { createdAt: "desc" as const }];
    case "price_desc":
      return [{ price: "desc" as const }, { createdAt: "desc" as const }];
    case "orders_desc":
      return [{ completedOrderCount: "desc" as const }, { createdAt: "desc" as const }];
    case "latest":
    default:
      return [{ createdAt: "desc" as const }];
  }
}

function getServiceRecommendationScore(
  item: {
    campusId: string;
    pricingUnit: string;
    categoryId: string;
    completedOrderCount: number;
    provider: { verificationStatus: string };
    createdAt: Date;
  },
  target: {
    campusId: string;
    pricingUnit: string;
    categoryId: string;
  },
) {
  let score = 0;

  if (item.campusId === target.campusId) {
    score += 30;
  }

  if (item.categoryId === target.categoryId) {
    score += 30;
  }

  if (item.pricingUnit === target.pricingUnit) {
    score += 20;
  }

  if (item.provider.verificationStatus === "VERIFIED") {
    score += 10;
  }

  score += Math.min(item.completedOrderCount * 2, 20);

  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
  );
  score += Math.max(0, 10 - ageDays);

  return score;
}

function getServiceRecommendationReason(
  item: {
    campusId: string;
    pricingUnit: string;
    categoryId: string;
    completedOrderCount: number;
    provider: { verificationStatus: string };
  },
  target: {
    campusId: string;
    pricingUnit: string;
    categoryId: string;
  },
) {
  if (item.categoryId === target.categoryId && item.campusId === target.campusId) {
    return "同校区同分类";
  }

  if (item.categoryId === target.categoryId) {
    return "同类服务";
  }

  if (item.provider.verificationStatus === "VERIFIED") {
    return "认证服务者";
  }

  if (item.completedOrderCount >= 3) {
    return "高完成度";
  }

  if (item.pricingUnit === target.pricingUnit) {
    return "同计费方式";
  }

  return "为你推荐";
}

export async function getServiceFormMeta() {
  const categories = await prisma.serviceCategory.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      slug: true,
    },
  });

  return { categories };
}

export async function getServiceList(query: ServiceListQuery = {}) {
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
    ...(query.status && query.status !== "ALL" ? { status: query.status } : {}),
    ...(query.pricingUnit && query.pricingUnit !== "ALL" ? { pricingUnit: query.pricingUnit } : {}),
    ...(query.categorySlug ? { category: { slug: query.categorySlug } } : {}),
    ...(query.verifiedOnly ? { provider: { verificationStatus: "VERIFIED" as const } } : {}),
  };

  const page = Math.max(1, query.page ?? 1);
  const [items, total, categories] = await Promise.all([
    prisma.serviceListing.findMany({
      where,
      orderBy: getServiceOrderBy(query.sort),
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        provider: {
          select: {
            id: true,
            name: true,
            schoolName: true,
            verificationStatus: true,
          },
        },
      },
    }),
    prisma.serviceListing.count({ where }),
    prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        slug: true,
      },
    }),
  ]);

  return {
    items,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    categories,
  };
}

export async function getServiceDetail(serviceId: string) {
  const service = await prisma.serviceListing.findFirst({
    where: { id: serviceId, deletedAt: null },
    include: {
      campus: true,
      category: true,
      provider: {
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
    },
  });

  if (!service) {
    notFound();
  }

  const recommendationPool = await prisma.serviceListing.findMany({
    where: {
      deletedAt: null,
      status: "ACTIVE",
      id: { not: service.id },
      OR: [
        { campusId: service.campusId },
        { categoryId: service.categoryId },
        { pricingUnit: service.pricingUnit },
        { provider: { verificationStatus: "VERIFIED" } },
      ],
    },
    take: 18,
    include: {
      category: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
      provider: {
        select: {
          name: true,
          verificationStatus: true,
        },
      },
    },
  });

  const relatedServices = recommendationPool
    .sort((a, b) => {
      return (
        getServiceRecommendationScore(b, {
          campusId: service.campusId,
          pricingUnit: service.pricingUnit,
          categoryId: service.categoryId,
        }) -
        getServiceRecommendationScore(a, {
          campusId: service.campusId,
          pricingUnit: service.pricingUnit,
          categoryId: service.categoryId,
        })
      );
    })
    .slice(0, 4)
    .map((item) => ({
      ...item,
      reason: getServiceRecommendationReason(item, {
        campusId: service.campusId,
        pricingUnit: service.pricingUnit,
        categoryId: service.categoryId,
      }),
    }));

  return { service, relatedServices };
}

export async function getServiceForEdit(serviceId: string, userId: string) {
  const [service, categories] = await Promise.all([
    prisma.serviceListing.findFirst({
      where: {
        id: serviceId,
        providerId: userId,
        deletedAt: null,
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    }),
    prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        slug: true,
      },
    }),
  ]);

  if (!service) {
    notFound();
  }

  return { service, categories };
}

export async function getMyServices(userId: string) {
  return prisma.serviceListing.findMany({
    where: {
      providerId: userId,
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    include: {
      campus: true,
      category: true,
    },
  });
}
