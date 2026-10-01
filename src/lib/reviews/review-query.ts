import type { Prisma } from "@prisma/client";

import { DISPUTE_ACTIVE_STATUSES } from "@/lib/disputes/dispute-scope";

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
}) {
  return {
    ...(options.targetUserId ? { targetUserId: options.targetUserId } : {}),
    order: {
      status: "COMPLETED",
      disputes: { none: { status: { in: [...DISPUTE_ACTIVE_STATUSES] } } },
    },
    OR: publishedReviewCondition(options.now),
  } satisfies Prisma.RentalReviewWhereInput;
}
