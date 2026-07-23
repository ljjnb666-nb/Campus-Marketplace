import { prisma } from "@/lib/prisma";

export async function getMyReviews(userId: string) {
  const [writtenReviews, receivedReviews] = await Promise.all([
    prisma.review.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        targetUser: {
          select: { id: true, name: true },
        },
        order: {
          select: {
            id: true,
            orderNo: true,
            type: true,
          },
        },
      },
    }),
    prisma.review.findMany({
      where: { targetUserId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        author: {
          select: { id: true, name: true },
        },
        order: {
          select: {
            id: true,
            orderNo: true,
            type: true,
          },
        },
      },
    }),
  ]);

  return { writtenReviews, receivedReviews };
}

export async function getMyReports(userId: string) {
  return prisma.report.findMany({
    where: { reporterId: userId },
    orderBy: { createdAt: "desc" },
    include: {
      product: { select: { id: true, title: true } },
      errandTask: { select: { id: true, title: true } },
      serviceListing: { select: { id: true, title: true } },
      targetUser: { select: { id: true, name: true } },
      message: { select: { id: true, content: true } },
    },
  });
}
