import { prisma } from "@/lib/prisma";

export async function getAdminDashboardData() {
  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0));
  const [
    pendingVerifications,
    openReports,
    latestReports,
    latestVerifications,
    todayNewReports,
    todayNewVerifications,
    totalUsers,
    todayNewUsers,
    totalProducts,
    activeProducts,
    todayNewProducts,
    totalErrands,
    completedErrands,
    totalReports,
  ] = await Promise.all([
    prisma.userVerification.findMany({
      where: { status: "PENDING" },
      orderBy: { submittedAt: "asc" },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            schoolName: true,
          },
        },
      },
      take: 8,
    }),
    prisma.report.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "asc" },
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
      take: 8,
    }),
    prisma.report.count({
      where: {
        status: { in: ["OPEN", "IN_REVIEW"] },
      },
    }),
    prisma.userVerification.count({
      where: {
        status: "PENDING",
      },
    }),
    prisma.report.count({
      where: {
        createdAt: {
          gte: startOfToday,
        },
      },
    }),
    prisma.userVerification.count({
      where: {
        submittedAt: {
          gte: startOfToday,
        },
      },
    }),
    prisma.user.count({
      where: {
        deletedAt: null,
      },
    }),
    prisma.user.count({
      where: {
        deletedAt: null,
        createdAt: {
          gte: startOfToday,
        },
      },
    }),
    prisma.product.count({
      where: {
        deletedAt: null,
      },
    }),
    prisma.product.count({
      where: {
        deletedAt: null,
        status: "ACTIVE",
      },
    }),
    prisma.product.count({
      where: {
        deletedAt: null,
        createdAt: {
          gte: startOfToday,
        },
      },
    }),
    prisma.errandTask.count({
      where: {
        deletedAt: null,
      },
    }),
    prisma.errandTask.count({
      where: {
        deletedAt: null,
        status: "COMPLETED",
      },
    }),
    prisma.report.count(),
  ]);

  return {
    pendingVerifications,
    openReports,
    latestReports,
    latestVerifications,
    todayNewReports,
    todayNewVerifications,
    totalUsers,
    todayNewUsers,
    totalProducts,
    activeProducts,
    todayNewProducts,
    totalErrands,
    completedErrands,
    totalReports,
  };
}

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
