import { prisma } from "@/lib/prisma";

export async function getVerificationReviewQueue() {
  return prisma.userVerification.findMany({
    where: {
      status: { in: ["PENDING", "REJECTED"] },
    },
    orderBy: [{ status: "asc" }, { submittedAt: "asc" }],
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          schoolName: true,
          campus: {
            select: {
              name: true,
            },
          },
        },
      },
    },
    // 审核队列最多返回 50 条，与后台列表页的条数上限保持一致
    take: 50,
  });
}

export async function getReportReviewQueue() {
  return prisma.report.findMany({
    where: {
      status: { in: ["OPEN", "IN_REVIEW"] },
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    include: {
      reporter: {
        select: {
          id: true,
          name: true,
        },
      },
      product: {
        select: {
          id: true,
          title: true,
        },
      },
      errandTask: {
        select: {
          id: true,
          title: true,
        },
      },
      serviceListing: {
        select: {
          id: true,
          title: true,
        },
      },
      targetUser: {
        select: {
          id: true,
          name: true,
        },
      },
      message: {
        select: {
          id: true,
          content: true,
        },
      },
    },
    // 举报队列最多返回 50 条，与后台列表页的条数上限保持一致
    take: 50,
  });
}

export async function getAdminUserList() {
  return prisma.user.findMany({
    where: { deletedAt: null },
    include: {
      campus: true,
      _count: {
        select: {
          products: true,
          serviceListings: true,
          buyerOrders: true,
          createdErrandTasks: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function getAdminProductList() {
  return prisma.product.findMany({
    where: { deletedAt: null },
    include: {
      category: true,
      seller: { select: { id: true, name: true } },
      images: { orderBy: { sortOrder: "asc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function getAdminErrandList() {
  return prisma.errandTask.findMany({
    where: { deletedAt: null },
    include: {
      category: true,
      publisher: { select: { id: true, name: true } },
      accepter: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function getAdminServiceList() {
  return prisma.serviceListing.findMany({
    where: { deletedAt: null },
    include: {
      category: true,
      provider: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function getAdminCategoryList() {
  return prisma.productCategory.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      _count: {
        select: {
          products: true,
        },
      },
    },
  });
}

export async function getAdminErrandCategoryList() {
  return prisma.errandCategory.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      _count: {
        select: {
          errandTasks: true,
        },
      },
    },
  });
}

export async function getAdminServiceCategoryList() {
  return prisma.serviceCategory.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      _count: {
        select: {
          serviceListings: true,
        },
      },
    },
  });
}

export async function getAdminModerationKeywords() {
  return prisma.moderationKeyword.findMany({
    orderBy: [{ isEnabled: "desc" }, { createdAt: "desc" }],
  });
}
