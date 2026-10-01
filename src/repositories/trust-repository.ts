import { prisma } from "@/lib/prisma";
import { getMyReviewsReadModel } from "@/lib/reviews/review-query";

/**
 * Phase 8E：/my/reviews 读模型统一收敛到 canonical read model——
 * written = 作者全量可见（AUTHOR_CAN_ALWAYS_VIEW_OWN_REVIEW 冻结）；
 * received = server query 层 canonical visible 过滤（禁止先返回 row
 * 再靠前端隐藏）。评价状态投影见 review-query.ts。
 */
export async function getMyReviews(userId: string) {
  return getMyReviewsReadModel(userId);
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
