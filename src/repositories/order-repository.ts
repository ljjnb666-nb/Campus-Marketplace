import { prisma } from "@/lib/prisma";

export async function getMyOrders(userId: string) {
  const [buyerOrders, sellerOrders] = await Promise.all([
    prisma.order.findMany({
      where: { buyerId: userId },
      orderBy: { createdAt: "desc" },
      include: {
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
      },
    }),
    prisma.order.findMany({
      where: { sellerId: userId },
      orderBy: { createdAt: "desc" },
      include: {
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
      },
    }),
  ]);

  return { buyerOrders, sellerOrders };
}
