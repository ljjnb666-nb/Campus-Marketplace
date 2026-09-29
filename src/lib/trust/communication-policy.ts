import type { Prisma } from "@prisma/client";

/**
 * Phase 8A-03（P8-B03）：BlockedUser communication policy 的唯一权威规则集。
 *
 * 冻结合同（EXISTING_OBLIGATION_PRESERVATION，Phase 6）：
 *   BlockedUser ≠ 取消订单 ≠ 终止交易 ≠ 切断已有交易履约沟通。
 *
 * Policy matrix：
 *   PAIR_BLOCKED(A,B) = BlockedUser(A→B) OR BlockedUser(B→A)
 *   - BlockedUser 行保持 directional（单行 = canonical preference truth），
 *     effective communication block 一律读取时派生，绝不写镜像行。
 *   - PAIR_BLOCKED → 新 MARKETPLACE_LISTING contact DENY（无会话/无首条
 *     消息/无通知）。
 *   - PAIR_BLOCKED ∧ ¬ACTIVE_OBLIGATION → 双向新 DIRECT 消息 DENY。
 *   - PAIR_BLOCKED ∧ ACTIVE_OBLIGATION → 双向必要履约消息 ALLOW
 *     （临时沟通例外；block 不改变任何交易业务状态）。
 *   - 既有会话历史读取 / 举报 / 解除拉黑永远不受 block 影响（证据保留）。
 *
 * ACTIVE_EXISTING_OBLIGATION 一律由数据库 authoritative state 推导（禁止
 * 信任 client flag / conversation title / 前端 bizType），且必须 exact
 * participant pair —— 历史/他人订单不构成 bypass token：
 *   - Order（orderId 直连 / productId / serviceListingId 反查）：
 *     terminal = COMPLETED | CANCELLED | REFUNDED，其余（含 PENDING /
 *     ACCEPTED / IN_PROGRESS）= active。
 *   - RentalOrder（rentalOrderId 直连 / rentalListingId 反查）：
 *     terminal = COMPLETED | REJECTED | CANCELLED | CLOSED，其余真实履约 /
 *     异常态 = active。
 *   - ErrandTask（errandTaskId 直连）：active = CLAIMED | IN_PROGRESS |
 *     PENDING_CONFIRMATION | DISPUTED；OPEN/COMPLETED/CANCELLED 非义务。
 */

/** Order（PRODUCT / SERVICE / ERRAND 型共享 OrderStatus）terminal 状态集。 */
export const TERMINAL_ORDER_STATUSES = ["COMPLETED", "CANCELLED", "REFUNDED"] as const;

/** RentalOrder terminal 状态集（canonical rental lifecycle 冻结）。 */
export const TERMINAL_RENTAL_ORDER_STATUSES = [
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
  "CLOSED",
] as const;

/** ErrandTask active obligation 状态集（canonical errand lifecycle 冻结）。 */
export const ACTIVE_ERRAND_STATUSES = [
  "CLAIMED",
  "IN_PROGRESS",
  "PENDING_CONFIRMATION",
  "DISPUTED",
] as const;

export type CommunicationPolicyMode =
  | "NORMAL"
  | "BLOCKED"
  | "EXISTING_OBLIGATION_OVERRIDE";

export type CommunicationPolicy = {
  pairBlocked: boolean;
  activeObligation: boolean;
  canSendMessage: boolean;
  mode: CommunicationPolicyMode;
};

/**
 * 会话义务来源 refs（Conversation 的六个 nullable 业务外键快照）。
 * 结构化承载而非整行 Conversation，允许 EXISTING_OBLIGATION gate 在会话
 * 尚不存在的创建路径上复用同一 resolver。
 */
export type ConversationObligationRefs = {
  productId?: string | null;
  errandTaskId?: string | null;
  serviceListingId?: string | null;
  rentalListingId?: string | null;
  orderId?: string | null;
  rentalOrderId?: string | null;
};

/**
 * 与扩展 PrismaClient / Prisma.TransactionClient 均结构兼容的最小读取面
 * （方法双变；同 listing-moderation-query.ts 的 ModerationReader 约定）。
 * 只暴露本政策实际需要的只读 delegate 方法——绝不承接写路径。
 */
export type CommunicationPolicyReader = {
  blockedUser: {
    findUnique(args: {
      where: { blockerId_blockedUserId: { blockerId: string; blockedUserId: string } };
      select: { id: boolean };
    }): Promise<{ id: string } | null>;
  };
  order: {
    findUnique(args: {
      where: { id: string };
      select: { buyerId: boolean; sellerId: boolean; status: boolean };
    }): Promise<{ buyerId: string; sellerId: string; status: string } | null>;
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id: boolean };
    }): Promise<{ id: string } | null>;
  };
  rentalOrder: {
    findUnique(args: {
      where: { id: string };
      select: { ownerId: boolean; renterId: boolean; status: boolean };
    }): Promise<{ ownerId: string; renterId: string; status: string } | null>;
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id: boolean };
    }): Promise<{ id: string } | null>;
  };
  errandTask: {
    findUnique(args: {
      where: { id: string };
      select: { publisherId: boolean; accepterId: boolean; status: boolean };
    }): Promise<{ publisherId: string; accepterId: string | null; status: string } | null>;
  };
};

function samePair(a: string[], b: string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * 任意单向 BlockedUser 行 ⇒ pair blocked（读取时派生，双向对称；
 * 数据库仅可能存在 A→B 或 B→A 单行，本函数从不写入）。
 */
export async function resolvePairBlockStateTx(
  tx: CommunicationPolicyReader,
  userAId: string,
  userBId: string,
): Promise<{ pairBlocked: boolean; aBlocksB: boolean; bBlocksA: boolean }> {
  const [aBlocksB, bBlocksA] = await Promise.all([
    tx.blockedUser.findUnique({
      where: { blockerId_blockedUserId: { blockerId: userAId, blockedUserId: userBId } },
      select: { id: true },
    }),
    tx.blockedUser.findUnique({
      where: { blockerId_blockedUserId: { blockerId: userBId, blockedUserId: userAId } },
      select: { id: true },
    }),
  ]);

  return {
    pairBlocked: Boolean(aBlocksB || bBlocksA),
    aBlocksB: Boolean(aBlocksB),
    bBlocksA: Boolean(bBlocksA),
  };
}

/** PRODUCT Order（orderId 直连）是否构成 active obligation（exact pair）。 */
export async function hasActiveOrderObligationTx(
  tx: CommunicationPolicyReader,
  orderId: string,
  participantIds: string[],
): Promise<boolean> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { buyerId: true, sellerId: true, status: true },
  });
  if (!order) return false;
  if (samePair([order.buyerId, order.sellerId], participantIds) === false) return false;
  return !(TERMINAL_ORDER_STATUSES as readonly string[]).includes(order.status);
}

/** RentalOrder（rentalOrderId 直连）是否构成 active obligation（exact pair）。 */
export async function hasActiveRentalOrderObligationTx(
  tx: CommunicationPolicyReader,
  rentalOrderId: string,
  participantIds: string[],
): Promise<boolean> {
  const rentalOrder = await tx.rentalOrder.findUnique({
    where: { id: rentalOrderId },
    select: { ownerId: true, renterId: true, status: true },
  });
  if (!rentalOrder) return false;
  if (samePair([rentalOrder.ownerId, rentalOrder.renterId], participantIds) === false) {
    return false;
  }
  return !(TERMINAL_RENTAL_ORDER_STATUSES as readonly string[]).includes(rentalOrder.status);
}

/** ErrandTask canonical state 是否构成 active obligation（publisher/accepter exact pair）。 */
export async function hasActiveErrandObligationTx(
  tx: CommunicationPolicyReader,
  errandTaskId: string,
  participantIds: string[],
): Promise<boolean> {
  const errand = await tx.errandTask.findUnique({
    where: { id: errandTaskId },
    select: { publisherId: true, accepterId: true, status: true },
  });
  if (!errand) return false;
  if (!errand.accepterId) return false;
  if (samePair([errand.publisherId, errand.accepterId], participantIds) === false) return false;
  return (ACTIVE_ERRAND_STATUSES as readonly string[]).includes(errand.status);
}

/**
 * SERVICE listing 会话：两名 participants 之间、该 ServiceListing 对应的
 * SERVICE Order（exact buyer/seller pair）是否 active。
 */
export async function hasActiveServiceObligationTx(
  tx: CommunicationPolicyReader,
  serviceListingId: string,
  participantIds: string[],
): Promise<boolean> {
  const [first, second] = participantIds;
  if (!first || !second) return false;
  const order = await tx.order.findFirst({
    where: {
      type: "SERVICE",
      serviceListingId,
      status: { notIn: [...TERMINAL_ORDER_STATUSES] },
      OR: [
        { buyerId: first, sellerId: second },
        { buyerId: second, sellerId: first },
      ],
    },
    select: { id: true },
  });
  return order !== null;
}

/**
 * PRODUCT listing 会话：同一 Product 上两名 participants 之间的 PRODUCT
 * Order（exact buyer/seller pair）是否 active——已有商品咨询会话在成交后
 * 仍可用于必要交接，不强迫用户切换会话。
 */
export async function hasActiveProductListingObligationTx(
  tx: CommunicationPolicyReader,
  productId: string,
  participantIds: string[],
): Promise<boolean> {
  const [first, second] = participantIds;
  if (!first || !second) return false;
  const order = await tx.order.findFirst({
    where: {
      type: "PRODUCT",
      productId,
      status: { notIn: [...TERMINAL_ORDER_STATUSES] },
      OR: [
        { buyerId: first, sellerId: second },
        { buyerId: second, sellerId: first },
      ],
    },
    select: { id: true },
  });
  return order !== null;
}

/** RENTAL listing 会话：对应 RentalOrder（exact owner/renter pair）是否 active。 */
export async function hasActiveRentalListingObligationTx(
  tx: CommunicationPolicyReader,
  rentalListingId: string,
  participantIds: string[],
): Promise<boolean> {
  const [first, second] = participantIds;
  if (!first || !second) return false;
  const rentalOrder = await tx.rentalOrder.findFirst({
    where: {
      rentalListingId,
      status: { notIn: [...TERMINAL_RENTAL_ORDER_STATUSES] },
      OR: [
        { ownerId: first, renterId: second },
        { ownerId: second, renterId: first },
      ],
    },
    select: { id: true },
  });
  return rentalOrder !== null;
}

/**
 * 由会话业务 refs + exact participant pair 推导 ACTIVE_EXISTING_OBLIGATION。
 * 只信数据库 authoritative state；refs 全空（纯会话）恒为 false。
 */
export async function resolveActiveConversationObligationTx(
  tx: CommunicationPolicyReader,
  refs: ConversationObligationRefs,
  participantIds: string[],
): Promise<boolean> {
  if (refs.orderId) {
    if (await hasActiveOrderObligationTx(tx, refs.orderId, participantIds)) return true;
  }
  if (refs.rentalOrderId) {
    if (await hasActiveRentalOrderObligationTx(tx, refs.rentalOrderId, participantIds)) return true;
  }
  if (refs.errandTaskId) {
    if (await hasActiveErrandObligationTx(tx, refs.errandTaskId, participantIds)) return true;
  }
  if (refs.serviceListingId) {
    if (await hasActiveServiceObligationTx(tx, refs.serviceListingId, participantIds)) return true;
  }
  if (refs.productId) {
    if (await hasActiveProductListingObligationTx(tx, refs.productId, participantIds)) return true;
  }
  if (refs.rentalListingId) {
    if (await hasActiveRentalListingObligationTx(tx, refs.rentalListingId, participantIds)) {
      return true;
    }
  }
  return false;
}

/**
 * 中央沟通策略（one canonical rule set）：conversation detail UI、
 * sendMessage、conversation creation 三处共享，禁止各自复制判断。
 */
export async function resolveConversationCommunicationPolicyTx(
  tx: CommunicationPolicyReader,
  refs: ConversationObligationRefs,
  viewerId: string,
  counterpartId: string,
): Promise<CommunicationPolicy> {
  const blockState = await resolvePairBlockStateTx(tx, viewerId, counterpartId);

  if (!blockState.pairBlocked) {
    return { pairBlocked: false, activeObligation: false, canSendMessage: true, mode: "NORMAL" };
  }

  const activeObligation = await resolveActiveConversationObligationTx(tx, refs, [
    viewerId,
    counterpartId,
  ]);

  return {
    pairBlocked: true,
    activeObligation,
    canSendMessage: activeObligation,
    mode: activeObligation ? "EXISTING_OBLIGATION_OVERRIDE" : "BLOCKED",
  };
}
