import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
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

  const [unreadNotifications, unreadConversations] = await Promise.all([
    getUnreadNotificationCount(userId),
    getUnreadConversationCount(userId),
  ]);

  return { user, unreadNotifications, unreadConversations };
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
      positiveReviewRate: true,
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

  const [productCount, errandCount, serviceCount] = await Promise.all([
    prisma.product.count({
      where: {
        sellerId: userId,
        deletedAt: null,
        status: "ACTIVE",
      },
    }),
    prisma.errandTask.count({
      where: {
        publisherId: userId,
        deletedAt: null,
        status: "OPEN",
      },
    }),
    prisma.serviceListing.count({
      where: {
        providerId: userId,
        deletedAt: null,
        status: "ACTIVE",
      },
    }),
  ]);

  return {
    ...user,
    visibleCounts: {
      products: productCount,
      createdErrandTasks: errandCount,
      serviceListings: serviceCount,
    },
  };
}
