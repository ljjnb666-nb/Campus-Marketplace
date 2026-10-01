import type { Prisma } from "@prisma/client";

import { DISPUTE_ACTIVE_STATUSES } from "@/lib/disputes/dispute-scope";
import {
  REVIEW_BLOCKING_DISPUTE_STATUSES,
  deriveReviewPublicationStatus,
  REVIEW_PUBLICATION_STATUS_LABELS,
} from "@/lib/reviews/review-integrity";
import { prisma } from "@/lib/prisma";

/**
 * Phase 8E Review Integrity：canonical visible 评价的查询层 policy（§8/§19）。
 *
 * visibility ≠ 存在性：评价行一经提交是 immutable 历史事实；只有满足
 * 「订单 COMPLETED + 无 active dispute + publication 条件」的评价才允许进入
 * 任何 counterparty / public / trust 读面。本文件的 where 片段是全部
 * visible 评价查询的唯一来源，禁止在读面发明第二套谓词。
 */

/** publication 条件（§6）：publishedAt != null OR blindUntil <= now */
export function publishedReviewCondition(now: Date) {
  return [{ publishedAt: { not: null } }, { blindUntil: { lte: now } }];
}

/** General Review canonical visible where（Review.order → Order.orderDisputes） */
export function visibleGeneralReviewCondition(options: {
  now: Date;
  targetUserId?: string;
}) {
  return {
    ...(options.targetUserId ? { targetUserId: options.targetUserId } : {}),
    order: {
      status: "COMPLETED",
      orderDisputes: { none: { status: { in: [...DISPUTE_ACTIVE_STATUSES] } } },
    },
    OR: publishedReviewCondition(options.now),
  } satisfies Prisma.ReviewWhereInput;
}

/** RentalReview canonical visible where（RentalReview.order → RentalOrder.disputes） */
export function visibleRentalReviewCondition(options: {
  now: Date;
  targetUserId?: string;
  /** 额外的 RentalOrder 过滤（如 rentalListingId），与 visibility 谓词合并 */
  orderWhere?: Prisma.RentalOrderWhereInput;
}) {
  return {
    ...(options.targetUserId ? { targetUserId: options.targetUserId } : {}),
    order: {
      ...(options.orderWhere ?? {}),
      status: "COMPLETED",
      disputes: { none: { status: { in: [...DISPUTE_ACTIVE_STATUSES] } } },
    },
    OR: publishedReviewCondition(options.now),
  } satisfies Prisma.RentalReviewWhereInput;
}

// ============================================================
// Published-only trust aggregation（§19：stored aggregate 不再是
// canonical truth——blindUntil 到期是纯 query-time 事件，无任何 mutation
// / scheduler 参与；因此公开 trust 统计必须查询时从 visible 评价推导）
// ============================================================

export type PublishedReviewStats = {
  /** canonical visible 的收到的评价数 */
  count: number;
  /** 0..1（general 原口径 = avg(rating)/5；rental 原口径 = 好评数/visible 总数） */
  positiveRate: number;
};

type QueryClient = Prisma.TransactionClient;

/** 事务客户端缺省回落到全局 prisma（soft-delete 扩展客户端结构兼容） */
function resolveClient(tx?: QueryClient): QueryClient {
  return tx ?? (prisma as unknown as QueryClient);
}

/**
 * canonical visible General Review 统计（原口径冻结 §18/§48：
 * positiveRate = avg(rating) / 5，无 visible 评价时 = 0）。
 */
export async function getPublishedGeneralReviewStats(
  userId: string,
  tx?: QueryClient,
): Promise<PublishedReviewStats> {
  const client = resolveClient(tx);
  const aggregate = await client.review.aggregate({
    where: visibleGeneralReviewCondition({ now: new Date(), targetUserId: userId }),
    _avg: { rating: true },
    _count: { rating: true },
  });
  const count = aggregate._count.rating ?? 0;
  const averageRating = aggregate._avg.rating ?? 0;
  return { count, positiveRate: count === 0 ? 0 : averageRating / 5 };
}

/**
 * canonical visible RentalReview 统计（原口径冻结：positiveRate =
 * overallRating >= 4 计数 / visible 总数，无 visible 评价时 = 0）。
 */
export async function getPublishedRentalReviewStats(
  userId: string,
  tx?: QueryClient,
): Promise<PublishedReviewStats> {
  const client = resolveClient(tx);
  const now = new Date();
  const visibilityWhere = visibleRentalReviewCondition({ now, targetUserId: userId });
  const [totalReviews, positiveReviews] = await Promise.all([
    client.rentalReview.count({ where: visibilityWhere }),
    client.rentalReview.count({ where: { ...visibilityWhere, overallRating: { gte: 4 } } }),
  ]);
  return {
    count: totalReviews,
    positiveRate: totalReviews > 0 ? positiveReviews / totalReviews : 0,
  };
}

/** 列表/搜索面批量版（单次 groupBy，避免 N+1）。缺失的用户 = { count: 0, positiveRate: 0 } */
export async function getPublishedGeneralReviewStatsBatch(
  userIds: string[],
  tx?: QueryClient,
): Promise<Map<string, PublishedReviewStats>> {
  const stats = new Map<string, PublishedReviewStats>();
  for (const userId of userIds) {
    stats.set(userId, { count: 0, positiveRate: 0 });
  }
  if (userIds.length === 0) {
    return stats;
  }

  const client = resolveClient(tx);
  const groups = await client.review.groupBy({
    by: ["targetUserId"],
    where: {
      targetUserId: { in: userIds },
      order: visibleGeneralReviewCondition({ now: new Date() }).order,
      OR: publishedReviewCondition(new Date()),
    },
    _avg: { rating: true },
    _count: { rating: true },
  });

  for (const group of groups) {
    const count = group._count.rating ?? 0;
    const averageRating = group._avg.rating ?? 0;
    stats.set(group.targetUserId, { count, positiveRate: count === 0 ? 0 : averageRating / 5 });
  }
  return stats;
}

// ============================================================
// /my/reviews 统一读模型（§26：written 全量（作者永远可见自己写出的内容）+
// received 仅 canonical visible；归一化 view DTO + 中文类型/状态文案）
// ============================================================

export const REVIEW_ORDER_TYPE_LABELS: Record<string, string> = {
  PRODUCT: "二手商品",
  SERVICE: "技能服务",
  ERRAND: "跑腿任务",
  RENTAL: "物品租赁",
};

export type MyReviewItem = {
  id: string;
  orderNo: string;
  orderTypeLabel: string;
  counterpartyName: string;
  rating: number;
  content: string | null;
  tags: string[];
  createdAt: Date;
  /** §27 UI projection：已公开 / 等待公开 / 纠纷隐藏（仅 written 有意义） */
  statusLabel: string | null;
};

function publicationStatusLabel(input: {
  publishedAt: Date | null;
  blindUntil: Date;
  orderStatus: string;
  hasActiveDispute: boolean;
}): string {
  return REVIEW_PUBLICATION_STATUS_LABELS[
    deriveReviewPublicationStatus(
      { publishedAt: input.publishedAt, blindUntil: input.blindUntil },
      {
        now: new Date(),
        orderStatus: input.orderStatus,
        hasActiveDispute: input.hasActiveDispute,
      },
    )
  ];
}

export type MyReviewsReadModel = {
  written: MyReviewItem[];
  received: MyReviewItem[];
};

export async function getMyReviewsReadModel(userId: string): Promise<MyReviewsReadModel> {
  const [writtenGeneral, receivedGeneral, writtenRental, receivedRental] = await Promise.all([
    // 我写出的 general 评价（作者全量可见；附 order 状态 + active dispute 供状态投影）
    prisma.review.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        rating: true,
        content: true,
        tags: true,
        createdAt: true,
        blindUntil: true,
        publishedAt: true,
        targetUser: { select: { name: true } },
        order: {
          select: {
            orderNo: true,
            type: true,
            status: true,
            orderDisputes: {
              where: { status: { in: [...REVIEW_BLOCKING_DISPUTE_STATUSES] } },
              select: { id: true },
            },
          },
        },
      },
    }),
    // 我收到的 general 评价：server query 层 canonical visible 过滤（§9，
    // 禁止先返回 row 再靠前端 CSS 隐藏）
    prisma.review.findMany({
      where: visibleGeneralReviewCondition({ now: new Date(), targetUserId: userId }),
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        rating: true,
        content: true,
        tags: true,
        createdAt: true,
        author: { select: { name: true } },
        order: { select: { orderNo: true, type: true, status: true } },
      },
    }),
    // 我写出的 rental 评价
    prisma.rentalReview.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        overallRating: true,
        content: true,
        tags: true,
        createdAt: true,
        blindUntil: true,
        publishedAt: true,
        targetUser: { select: { name: true } },
        order: {
          select: {
            orderNumber: true,
            status: true,
            disputes: {
              where: { status: { in: [...REVIEW_BLOCKING_DISPUTE_STATUSES] } },
              select: { id: true },
            },
          },
        },
      },
    }),
    // 我收到的 rental 评价：visible-only
    prisma.rentalReview.findMany({
      where: visibleRentalReviewCondition({ now: new Date(), targetUserId: userId }),
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        overallRating: true,
        content: true,
        tags: true,
        createdAt: true,
        author: { select: { name: true } },
        order: { select: { orderNumber: true, status: true } },
      },
    }),
  ]);

  const written: MyReviewItem[] = [
    ...writtenGeneral.map((review) => ({
      id: review.id,
      orderNo: review.order.orderNo,
      orderTypeLabel: REVIEW_ORDER_TYPE_LABELS[review.order.type] ?? review.order.type,
      counterpartyName: review.targetUser.name,
      rating: review.rating,
      content: review.content,
      tags: review.tags,
      createdAt: review.createdAt,
      statusLabel: publicationStatusLabel({
        publishedAt: review.publishedAt,
        blindUntil: review.blindUntil,
        orderStatus: review.order.status,
        hasActiveDispute: review.order.orderDisputes.length > 0,
      }),
    })),
    ...writtenRental.map((review) => ({
      id: review.id,
      orderNo: review.order.orderNumber,
      orderTypeLabel: REVIEW_ORDER_TYPE_LABELS.RENTAL,
      counterpartyName: review.targetUser.name,
      rating: review.overallRating,
      content: review.content,
      tags: review.tags,
      createdAt: review.createdAt,
      statusLabel: publicationStatusLabel({
        publishedAt: review.publishedAt,
        blindUntil: review.blindUntil,
        orderStatus: review.order.status,
        hasActiveDispute: review.order.disputes.length > 0,
      }),
    })),
  ];

  const received: MyReviewItem[] = [
    ...receivedGeneral.map((review) => ({
      id: review.id,
      orderNo: review.order.orderNo,
      orderTypeLabel: REVIEW_ORDER_TYPE_LABELS[review.order.type] ?? review.order.type,
      counterpartyName: review.author.name,
      rating: review.rating,
      content: review.content,
      tags: review.tags,
      createdAt: review.createdAt,
      // 收到的评价只在 canonical visible 时返回，无需状态投影
      statusLabel: null,
    })),
    ...receivedRental.map((review) => ({
      id: review.id,
      orderNo: review.order.orderNumber,
      orderTypeLabel: REVIEW_ORDER_TYPE_LABELS.RENTAL,
      counterpartyName: review.author.name,
      rating: review.overallRating,
      content: review.content,
      tags: review.tags,
      createdAt: review.createdAt,
      statusLabel: null,
    })),
  ];

  written.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  received.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return { written, received };
}
