import { notFound } from "next/navigation";
import { errandPublicExposureFilter } from "@/lib/listings/errand-exposure";
import { prisma } from "@/lib/prisma";
import { getPublishedGeneralReviewStats } from "@/lib/reviews/review-query";

export type ErrandListQuery = {
  q?: string;
  category?: string;
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
  // Phase 9C-02（§6/§7）：公开 list = canonical exposure contract（OPEN +
  // deadline > now + moderation）。now 在同一 query 内捕获一次，items 与
  // count 共用（deadline 跨界时 items/total 不漂移）。
  const now = new Date();
  const exposure = errandPublicExposureFilter(now);
  const deadlineFilter = getDeadlineFilter(query.deadline);
  const where = {
    ...exposure,
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
    ...(deadlineFilter
      ? // 用户筛选窗口叠加在 exposure 下界之上（gt now 保持 canonical 边界）
        { deadline: { ...exposure.deadline, ...deadlineFilter } }
      : {}),
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
          // Phase 8E：好评率由 getPublishedGeneralReviewStats canonical 覆写
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

  // Phase 9C-02（§6）：推荐池同属公开 discovery 面——过期（deadline 过去）
  // 的 OPEN 任务即使尚未被 worker materialize 也不得进入推荐。
  const recommendationPool = await prisma.errandTask.findMany({
    where: {
      ...errandPublicExposureFilter(new Date()),
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

  // Phase 8E（§19/§20）：PUBLIC 发布者好评率 = canonical visible 评价聚合
  const publisherReviewStats = await getPublishedGeneralReviewStats(errand.publisherId);
  return {
    errand: {
      ...errand,
      publisher: {
        ...errand.publisher,
        positiveReviewRate: publisherReviewStats.positiveRate,
        publishedReviewCount: publisherReviewStats.count,
      },
    },
    relatedErrands,
  };
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
      // Phase 7C OWNER 面：不过滤，但携带活跃治理状态供安全 badge 呈现
      moderations: {
        where: { resolvedAt: null },
        take: 1,
        select: { id: true, createdAt: true },
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
      // Phase 7C OWNER 面：接单方同样可见治理状态（履约上下文保留）
      moderations: {
        where: { resolvedAt: null },
        take: 1,
        select: { id: true, createdAt: true },
      },
    },
  });
}
