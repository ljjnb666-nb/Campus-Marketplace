import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export type ErrandListQuery = {
  q?: string;
  category?: string;
  status?:
    | "OPEN"
    | "CLAIMED"
    | "IN_PROGRESS"
    | "PENDING_CONFIRMATION"
    | "COMPLETED"
    | "CANCELLED"
    | "ALL";
  deadline?: "today" | "3days" | "7days" | "all";
  sort?: "latest" | "reward_desc" | "reward_asc" | "deadline_asc";
  page?: number;
  currentUserId?: string;
};

const PAGE_SIZE = 12;

function getErrandOrderBy(sort: ErrandListQuery["sort"]) {
  switch (sort) {
    case "reward_desc":
      return [{ reward: "desc" as const }, { createdAt: "desc" as const }];
    case "reward_asc":
      return [{ reward: "asc" as const }, { createdAt: "desc" as const }];
    case "deadline_asc":
      return [{ deadline: "asc" as const }, { createdAt: "desc" as const }];
    case "latest":
    default:
      return [{ createdAt: "desc" as const }];
  }
}

function getDeadlineFilter(deadline?: ErrandListQuery["deadline"]) {
  if (!deadline || deadline === "all") {
    return undefined;
  }

  const now = new Date();
  const end = new Date(now);

  if (deadline === "today") {
    end.setHours(23, 59, 59, 999);
  } else if (deadline === "3days") {
    end.setDate(end.getDate() + 3);
  } else if (deadline === "7days") {
    end.setDate(end.getDate() + 7);
  }

  return {
    gte: now,
    lte: end,
  };
}

function isSimilarLocation(source: string, target: string) {
  return source.includes(target) || target.includes(source);
}

function getErrandRecommendationScore(
  item: {
    campusId: string;
    categoryId: string;
    pickupLocation: string;
    deliveryLocation: string;
    reward: { toString(): string };
    deadline: Date;
    publisher: { verificationStatus: string };
    createdAt: Date;
  },
  target: {
    campusId: string;
    categoryId: string;
    pickupLocation: string;
    deliveryLocation: string;
  },
) {
  let score = 0;

  if (item.campusId === target.campusId) {
    score += 35;
  }

  if (item.categoryId === target.categoryId) {
    score += 25;
  }

  if (isSimilarLocation(item.pickupLocation, target.pickupLocation)) {
    score += 15;
  }

  if (isSimilarLocation(item.deliveryLocation, target.deliveryLocation)) {
    score += 15;
  }

  if (item.publisher.verificationStatus === "VERIFIED") {
    score += 10;
  }

  score += Math.min(Number(item.reward.toString()), 20);

  const hoursLeft = Math.max(0, (new Date(item.deadline).getTime() - Date.now()) / (1000 * 60 * 60));
  score += Math.max(0, 12 - Math.floor(hoursLeft / 12));

  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
  );
  score += Math.max(0, 8 - ageDays);

  return score;
}

function getErrandRecommendationReason(
  item: {
    campusId: string;
    categoryId: string;
    pickupLocation: string;
    deliveryLocation: string;
    reward: { toString(): string };
    publisher: { verificationStatus: string };
  },
  target: {
    campusId: string;
    categoryId: string;
    pickupLocation: string;
    deliveryLocation: string;
  },
) {
  if (item.campusId === target.campusId && item.categoryId === target.categoryId) {
    return "同校区同分类";
  }

  if (item.categoryId === target.categoryId) {
    return "同分类任务";
  }

  if (isSimilarLocation(item.pickupLocation, target.pickupLocation)) {
    return "取件点相近";
  }

  if (isSimilarLocation(item.deliveryLocation, target.deliveryLocation)) {
    return "送达点相近";
  }

  if (item.publisher.verificationStatus === "VERIFIED") {
    return "认证发布者";
  }

  if (Number(item.reward.toString()) >= 20) {
    return "高赏金任务";
  }

  return "为你推荐";
}

export async function getErrandFormMeta() {
  const categories = await prisma.errandCategory.findMany({
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

export async function getErrandList(query: ErrandListQuery = {}) {
  const deadlineFilter = getDeadlineFilter(query.deadline);
  const where = {
    deletedAt: null,
    ...(query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: "insensitive" as const } },
            { description: { contains: query.q, mode: "insensitive" as const } },
            { pickupLocation: { contains: query.q, mode: "insensitive" as const } },
            { deliveryLocation: { contains: query.q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(query.category ? { categoryId: query.category } : {}),
    ...(query.status && query.status !== "ALL" ? { status: query.status } : {}),
    ...(deadlineFilter ? { deadline: deadlineFilter } : {}),
  };

  const page = Math.max(1, query.page ?? 1);
  const [items, total, categories] = await Promise.all([
    prisma.errandTask.findMany({
      where,
      orderBy: getErrandOrderBy(query.sort),
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        category: true,
        publisher: {
          select: {
            id: true,
            name: true,
            schoolName: true,
            verificationStatus: true,
          },
        },
        accepter: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),
    prisma.errandTask.count({ where }),
    prisma.errandCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  return {
    items,
    total,
    categories,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getErrandDetail(errandId: string) {
  const errand = await prisma.errandTask.findFirst({
    where: { id: errandId, deletedAt: null },
    include: {
      campus: true,
      category: true,
      publisher: {
        select: {
          id: true,
          name: true,
          schoolName: true,
          completedOrdersCount: true,
          positiveReviewRate: true,
          verificationStatus: true,
          createdAt: true,
        },
      },
      accepter: {
        select: {
          id: true,
          name: true,
          schoolName: true,
        },
      },
    },
  });

  if (!errand) {
    notFound();
  }

  const recommendationPool = await prisma.errandTask.findMany({
    where: {
      deletedAt: null,
      status: "OPEN",
      id: { not: errand.id },
      OR: [
        { campusId: errand.campusId },
        { categoryId: errand.categoryId },
        { pickupLocation: { contains: errand.pickupLocation, mode: "insensitive" } },
        { deliveryLocation: { contains: errand.deliveryLocation, mode: "insensitive" } },
      ],
    },
    take: 18,
    include: {
      category: true,
      publisher: {
        select: {
          name: true,
          verificationStatus: true,
        },
      },
    },
  });

  const relatedErrands = recommendationPool
    .sort((a, b) => {
      return (
        getErrandRecommendationScore(b, {
          campusId: errand.campusId,
          categoryId: errand.categoryId,
          pickupLocation: errand.pickupLocation,
          deliveryLocation: errand.deliveryLocation,
        }) -
        getErrandRecommendationScore(a, {
          campusId: errand.campusId,
          categoryId: errand.categoryId,
          pickupLocation: errand.pickupLocation,
          deliveryLocation: errand.deliveryLocation,
        })
      );
    })
    .slice(0, 4)
    .map((item) => ({
      ...item,
      reason: getErrandRecommendationReason(item, {
        campusId: errand.campusId,
        categoryId: errand.categoryId,
        pickupLocation: errand.pickupLocation,
        deliveryLocation: errand.deliveryLocation,
      }),
    }));

  return { errand, relatedErrands };
}

export async function getErrandForEdit(errandId: string, userId: string) {
  const errand = await prisma.errandTask.findFirst({
    where: {
      id: errandId,
      publisherId: userId,
      deletedAt: null,
    },
  });

  if (!errand) {
    notFound();
  }

  return errand;
}

export async function getMyPublishedErrands(userId: string) {
  return prisma.errandTask.findMany({
    where: {
      publisherId: userId,
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    include: {
      category: true,
      accepter: {
        select: { name: true },
      },
    },
  });
}

export async function getMyAcceptedErrands(userId: string) {
  return prisma.errandTask.findMany({
    where: {
      accepterId: userId,
      deletedAt: null,
    },
    orderBy: { updatedAt: "desc" },
    include: {
      category: true,
      publisher: {
        select: { name: true },
      },
    },
  });
}
