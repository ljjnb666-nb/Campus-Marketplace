import { prisma } from "@/lib/prisma";

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
        status: "ACTIVE",
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
        status: { in: ["OPEN", "CLAIMED", "IN_PROGRESS", "PENDING_CONFIRMATION"] },
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
        status: "ACTIVE",
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
        positiveReviewRate: true,
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
              status: "ACTIVE",
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
              status: "OPEN",
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
              status: "ACTIVE",
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

  return {
    products,
    errands,
    services,
    users: users.map((user) => ({
      ...user,
      visibleCounts: {
        products: visibleProductMap.get(user.id) ?? 0,
        createdErrandTasks: visibleErrandMap.get(user.id) ?? 0,
        serviceListings: visibleServiceMap.get(user.id) ?? 0,
      },
    })),
  };
}
