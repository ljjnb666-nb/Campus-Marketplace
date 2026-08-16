import { prisma } from "@/lib/prisma";

const myOrdersInclude = {
  buyer: { select: { id: true, name: true } },
  seller: { select: { id: true, name: true } },
  product: { select: { id: true, title: true } },
  errandTask: { select: { id: true, title: true } },
  serviceListing: { select: { id: true, title: true } },
  reviews: {
    select: {
      id: true,
      authorId: true,
      targetUserId: true,
      rating: true,
    },
  },
};

export async function getMyOrders(userId: string) {
  const [buyerOrders, sellerOrders] = await Promise.all([
    prisma.order.findMany({
      where: { buyerId: userId },
      orderBy: { createdAt: "desc" },
      // 个人订单历史仅保留最近 100 条，避免无界查询
      take: 100,
      include: myOrdersInclude,
    }),
    prisma.order.findMany({
      where: { sellerId: userId },
      orderBy: { createdAt: "desc" },
      // 个人订单历史仅保留最近 100 条，避免无界查询
      take: 100,
      include: myOrdersInclude,
    }),
  ]);

  return { buyerOrders, sellerOrders };
}

// 统一订单中心:用户作为买方或卖方参与的订单(含展示所需的对方/商品摘要字段)
export async function getOrdersInvolvingUser(userId: string) {
  return prisma.order.findMany({
    where: {
      OR: [{ buyerId: userId }, { sellerId: userId }],
    },
    include: {
      buyer: { select: { id: true, name: true, avatarUrl: true, schoolName: true } },
      seller: { select: { id: true, name: true, avatarUrl: true, schoolName: true } },
      product: { select: { id: true, title: true, images: { take: 1 } } },
      errandTask: { select: { id: true, title: true } },
      serviceListing: { select: { id: true, title: true, coverImageUrl: true } },
      reviews: { select: { authorId: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}
