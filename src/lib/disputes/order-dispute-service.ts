import type {
  DisputeResolutionAction,
  DisputeResolutionCode,
  OrderStatus,
  Prisma,
} from "@prisma/client";

import { disputeError } from "@/lib/disputes/errors";
import { DISPUTE_REVIEW_PERMISSION } from "@/lib/disputes/dispute-access";
import { resolveDisputeScope } from "@/lib/disputes/dispute-scope";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import {
  isOpenedFromLegalDisputableSource,
} from "@/lib/order-dispute-machine";
import {
  DATA_HOLD_SOURCE_TYPE_ORDER_DISPUTE,
  releaseHoldsBySourceTxLocked,
} from "@/lib/privacy/data-hold-service";
import { withTransaction } from "@/lib/prisma";
import { rbacError } from "@/lib/rbac/errors";
import {
  loadAuthorizationContext,
  requirePermissionInContext,
} from "@/lib/rbac/service";
import { projectProductAfterReservationRelease } from "@/lib/product-order-lifecycle";
import { createNotifications } from "@/repositories/notification-repository";

/**
 * Phase 8C-01：General OrderDispute 运营 canonical 治理服务
 * （claim / release / resolve / close）——与 RentalDispute 的
 * disputes/dispute-service.ts 平行同构，但不迁移、不改写 RentalDispute。
 *
 * 权限复用（冻结）：dispute.review（CAMPUS_DISPUTE_REVIEWER /
 * PLATFORM_ADMIN 语义覆盖两类 dispute），不新增 order-dispute.review。
 *
 * 锁序（全局全序扩展，禁止反序）：
 *   claim/release：USER:reviewer → OrderDispute FOR UPDATE → 锁后授权重读
 *     （dispute.review @ dispute.campusId exact pair）
 *   resolve/close：pre-read only for lock discovery → ONE COMPLETE SORTED SET
 *     （USER:reviewer + USER:buyer + USER:seller）→ OrderDispute FOR UPDATE
 *     → Order FOR UPDATE（ERRAND：OrderDispute → ErrandTask → Order，服从
 *     errand-lifecycle 的 ErrandTask → Order 方向）→ 锁后授权重读
 *
 * 状态机（冻结，禁止 reopen）：
 *   OPEN → IN_REVIEW（claim）/ OPEN | IN_REVIEW → RESOLVED | CLOSED；
 *   claim：self claim / already yours 幂等 / 他人领用 DENY；dueAt 不重置。
 *   release：仅 assignee；未领用幂等；IN_REVIEW → OPEN。
 *
 * 终局收敛动作（单 locked transaction 原子；金额字段零修改）：
 *   RESTORE_PREVIOUS：Order.IN_DISPUTE → openedFromOrderStatus；snapshot 必须是
 *     该 type 合法 dispute 源（ERRAND 另校验 Task pair snapshot），缺失/非法 →
 *     DISPUTE_RESTORE_UNAVAILABLE（绝不猜历史）；ERRAND 原子恢复
 *     ErrandTask.DISPUTED → openedFromErrandStatus。
 *   CLOSE_ORDER：Order.IN_DISPUTE → CLOSED（ERRAND 另 ErrandTask.DISPUTED →
 *     CLOSED 成 canonical terminal pair）；PRODUCT 追加共享 release projection
 *     （RESERVED + 无其它 active order + seller capability → ACTIVE / FAIL →
 *     OFFLINE；SOLD/OFFLINE/deleted 不穿越）；SERVICE 不得修改 ServiceListing。
 *   → release 双方 source-linked holds（精确按 ORDER_DISPUTE source；LEGAL /
 *     RENTAL_DISPUTE / 其它 OrderDispute hold 零触碰）→ audit → generic 通知。
 *
 * 冻结禁区：本域零 refund / payout / deposit / fee / paymentStatus / amount
 * 修改；零 completedOrdersCount / completedOrderCount 倒扣（不做 counter
 * compensation）；零 RiskFlag / EnforcementAction。
 */

export type OrderDisputeRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

type LockedDisputeRow = {
  id: string;
  campusId: string;
  scopeKey: string;
  status: string;
  assignedToId: string | null;
};

/** 锁后授权重读：dispute.review @ dispute campus exact（fail closed）。 */
async function requireOrderDisputeReviewAuthorization(
  tx: Prisma.TransactionClient,
  actorId: string,
  scope: { campusId: string; scopeKey: string },
): Promise<void> {
  const canonical = resolveDisputeScope(scope);
  if (!canonical) {
    // malformed pair：fail closed（DB CHECK 下结构不可达，纵深防御）
    throw rbacError("AUTH_PERMISSION_DENIED");
  }
  const context = await loadAuthorizationContext(actorId, tx);
  if (!context || !context.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  await requirePermissionInContext(context, DISPUTE_REVIEW_PERMISSION, canonical.campusId);
}

/**
 * claim/release 共享前段：USER:reviewer 锁 → OrderDispute 行锁 → racePoint →
 * 锁后授权重读（exact campus）。返回锁内 dispute 现势。
 */
async function withOrderDisputeAuthority(
  tx: Prisma.TransactionClient,
  input: { actorId: string; disputeId: string; racePoint?: OrderDisputeRacePoint },
): Promise<LockedDisputeRow> {
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: input.actorId },
  ]);

  const rows = await tx.$queryRaw<
    { id: string; campusId: string; scopeKey: string; status: string; assignedToId: string | null }[]
  >`
    SELECT "id", "campusId", "scopeKey", "status", "assignedToId"
    FROM "OrderDispute"
    WHERE "id" = ${input.disputeId}
    FOR UPDATE`;
  const locked = rows[0];
  if (!locked) {
    // 反 oracle：missing 与越权统一安全文案（action 层不区分）
    throw disputeError("DISPUTE_NOT_FOUND");
  }

  if (input.racePoint) {
    await input.racePoint(tx);
  }

  await requireOrderDisputeReviewAuthorization(tx, input.actorId, {
    campusId: locked.campusId,
    scopeKey: locked.scopeKey,
  });

  return locked;
}

/** 纠纷领用（self claim）。并发竞争：dispute 行锁下恰好一个 canonical winner。 */
export async function claimOrderDispute(input: {
  actorId: string;
  disputeId: string;
  racePoint?: OrderDisputeRacePoint;
}): Promise<{ disputeId: string; assignedToId: string | null; outcome: "CLAIMED" | "ALREADY_YOURS" }> {
  return withTransaction(async (tx) => {
    const locked = await withOrderDisputeAuthority(tx, input);

    if (locked.status === "RESOLVED" || locked.status === "CLOSED") {
      throw disputeError("DISPUTE_TERMINAL");
    }
    if (locked.assignedToId === input.actorId) {
      return { disputeId: locked.id, assignedToId: locked.assignedToId, outcome: "ALREADY_YOURS" };
    }
    if (locked.assignedToId !== null) {
      throw disputeError("DISPUTE_ALREADY_CLAIMED");
    }

    await tx.orderDispute.update({
      where: { id: locked.id },
      data: { assignedToId: input.actorId, status: "IN_REVIEW" },
      select: { id: true },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "ORDER_DISPUTE_CLAIMED",
        targetType: "ORDER_DISPUTE",
        targetId: locked.id,
        campusId: locked.campusId,
      },
      tx,
    );

    return { disputeId: locked.id, assignedToId: input.actorId, outcome: "CLAIMED" };
  });
}

/** 纠纷释放（self release）。仅 assignee；IN_REVIEW → OPEN；dueAt 不重置。 */
export async function releaseOrderDispute(input: {
  actorId: string;
  disputeId: string;
  racePoint?: OrderDisputeRacePoint;
}): Promise<{ disputeId: string; assignedToId: string | null; outcome: "RELEASED" | "ALREADY_RELEASED" }> {
  return withTransaction(async (tx) => {
    const locked = await withOrderDisputeAuthority(tx, input);

    if (locked.status === "RESOLVED" || locked.status === "CLOSED") {
      throw disputeError("DISPUTE_TERMINAL");
    }
    if (locked.assignedToId === null) {
      return { disputeId: locked.id, assignedToId: null, outcome: "ALREADY_RELEASED" };
    }
    if (locked.assignedToId !== input.actorId) {
      throw disputeError("DISPUTE_RELEASE_FORBIDDEN");
    }

    await tx.orderDispute.update({
      where: { id: locked.id },
      data: { assignedToId: null, status: "OPEN" },
      select: { id: true },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "ORDER_DISPUTE_RELEASED",
        targetType: "ORDER_DISPUTE",
        targetId: locked.id,
        campusId: locked.campusId,
      },
      tx,
    );

    return { disputeId: locked.id, assignedToId: null, outcome: "RELEASED" };
  });
}

export type ResolveOrderDisputeInput = {
  actorId: string;
  disputeId: string;
  resolutionCode: DisputeResolutionCode;
  resolutionAction: DisputeResolutionAction;
  adminNote?: string | null;
  racePoint?: OrderDisputeRacePoint;
};

export type ResolveOrderDisputeResult = {
  disputeId: string;
  status: "RESOLVED" | "CLOSED";
  orderStatus: string;
  errandStatus: string | null;
  releasedHolds: number;
};

/**
 * 纠纷终局（RESOLVED / CLOSED 共享内核）。
 *
 * 冻结链（单个 locked transaction）：
 *   pre-read only for lock discovery（dispute → order 当事人）
 *   → ONE COMPLETE SORTED SET：USER:reviewer + USER:buyer + USER:seller
 *   → OrderDispute FOR UPDATE → Order FOR UPDATE（ERRAND：先 ErrandTask）
 *   → racePoint → 锁后授权重读（dispute.review @ campus）
 *   → 状态机断言（OPEN|IN_REVIEW → terminal；terminal 再终局 = 幂等拒绝）
 *   → order 收敛动作（RESTORE_PREVIOUS / CLOSE_ORDER）→ Product release 投影
 *   → release 双方 source-linked holds → audit → 双方通知。
 */
export async function resolveOrderDispute(input: ResolveOrderDisputeInput): Promise<ResolveOrderDisputeResult> {
  return withTransaction(async (tx) =>
    resolveOrderDisputeTxLocked(tx, input, async (innerTx) => {
      const probe = await innerTx.orderDispute.findUnique({
        where: { id: input.disputeId },
        select: { order: { select: { buyerId: true, sellerId: true } } },
      });
      if (!probe) {
        throw disputeError("DISPUTE_NOT_FOUND");
      }
      return probe.order;
    }),
  );
}

/**
 * closeOrderDispute = RESOLVED 的姊妹终局（不携带 resolutionCode；收敛动作
 * 仍为必填——每个 terminal transition 都必须收敛订单，绝不留 IN_DISPUTE 悬挂）。
 */
export async function closeOrderDispute(input: {
  actorId: string;
  disputeId: string;
  resolutionAction: DisputeResolutionAction;
  adminNote?: string | null;
  racePoint?: OrderDisputeRacePoint;
}): Promise<ResolveOrderDisputeResult> {
  return withTransaction(async (tx) =>
    resolveOrderDisputeTxLocked(tx, input, async (innerTx) => {
      const probe = await innerTx.orderDispute.findUnique({
        where: { id: input.disputeId },
        select: { order: { select: { buyerId: true, sellerId: true } } },
      });
      if (!probe) {
        throw disputeError("DISPUTE_NOT_FOUND");
      }
      return probe.order;
    }),
  );
}

type TerminalOrderRow = {
  id: string;
  type: string;
  status: string;
  buyerId: string;
  sellerId: string;
  productId: string | null;
  errandTaskId: string | null;
};

type TerminalErrandRow = {
  id: string;
  status: string;
};

async function resolveOrderDisputeTxLocked(
  tx: Prisma.TransactionClient,
  input: {
    actorId: string;
    disputeId: string;
    resolutionAction: DisputeResolutionAction;
    resolutionCode?: DisputeResolutionCode | null;
    adminNote?: string | null;
    racePoint?: OrderDisputeRacePoint;
  },
  fullLockDiscovery: (tx: Prisma.TransactionClient) => Promise<{ buyerId: string; sellerId: string }>,
): Promise<ResolveOrderDisputeResult> {
  const parties = await fullLockDiscovery(tx);

  // ONE COMPLETE SORTED SET：reviewer + buyer + seller（与 initiate / erasure /
  // rental dispute 决策同锁域、同全局锁序；sorted 去重由 lock helper 保证）
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: input.actorId },
    { subjectType: "USER", subjectId: parties.buyerId },
    { subjectType: "USER", subjectId: parties.sellerId },
  ]);

  // OrderDispute FOR UPDATE
  const disputeRows = await tx.$queryRaw<
    {
      id: string;
      orderId: string;
      campusId: string;
      scopeKey: string;
      status: string;
      assignedToId: string | null;
      openedFromOrderStatus: string;
      openedFromErrandStatus: string | null;
    }[]
  >`
    SELECT "id", "orderId", "campusId", "scopeKey", "status", "assignedToId",
           "openedFromOrderStatus", "openedFromErrandStatus"
    FROM "OrderDispute"
    WHERE "id" = ${input.disputeId}
    FOR UPDATE`;
  const dispute = disputeRows[0];
  if (!dispute) {
    throw disputeError("DISPUTE_NOT_FOUND");
  }

  // ERRAND：先 ErrandTask 后 Order（服从 errand-lifecycle 全序，禁止反序）；
  // PRODUCT/SERVICE：仅 Order 行锁。
  const errandRows = dispute.openedFromErrandStatus !== null
    ? await tx.$queryRaw<TerminalErrandRow[]>`
        SELECT "id", "status"
        FROM "ErrandTask"
        WHERE "id" = (
          SELECT "errandTaskId" FROM "Order" WHERE "id" = ${dispute.orderId}
        )
        FOR UPDATE`
    : [];
  const lockedErrand = errandRows[0] ?? null;

  const orderRows = await tx.$queryRaw<TerminalOrderRow[]>`
    SELECT "id", "type", "status", "buyerId", "sellerId", "productId", "errandTaskId"
    FROM "Order"
    WHERE "id" = ${dispute.orderId}
    FOR UPDATE`;
  const order = orderRows[0];
  if (!order) {
    throw disputeError("DISPUTE_NOT_FOUND");
  }

  // 当事人锁键与锁内现势不一致 → 取错了锁，fail closed（无参与者转移路径，
  // 结构上不可达；防御 pre-read 与行锁之间的任何极端交错）
  if (order.buyerId !== parties.buyerId || order.sellerId !== parties.sellerId) {
    throw disputeError("DISPUTE_INVALID_TRANSITION");
  }

  if (input.racePoint) {
    await input.racePoint(tx);
  }

  // 锁后授权重读（must await——吞错即 fail-open）
  await requireOrderDisputeReviewAuthorization(tx, input.actorId, {
    campusId: dispute.campusId,
    scopeKey: dispute.scopeKey,
  });

  // 状态机断言：OPEN|IN_REVIEW → terminal；terminal 不可再变更（禁止 reopen）
  if (dispute.status !== "OPEN" && dispute.status !== "IN_REVIEW") {
    throw disputeError("DISPUTE_TERMINAL");
  }
  // 订单必须仍在 IN_DISPUTE（active dispute ↔ Order IN_DISPUTE 的合同不变量）
  if (order.status !== "IN_DISPUTE") {
    throw disputeError("DISPUTE_INVALID_TRANSITION");
  }
  if (dispute.openedFromErrandStatus !== null && order.type !== "ERRAND") {
    throw disputeError("DISPUTE_INVALID_TRANSITION");
  }

  // ---- order 收敛动作（金额字段零修改；payment 语义为冻结禁区）----
  let nextOrderStatus: OrderStatus;
  let nextErrandStatus: string | null = null;
  if (input.resolutionAction === "RESTORE_PREVIOUS") {
    // snapshot 必须存在且是该 type 的合法 dispute 源；缺失/非法 → DENY，
    // 绝不猜历史（§41）
    const legalSource = isOpenedFromLegalDisputableSource({
      orderType: order.type,
      openedFromOrderStatus: dispute.openedFromOrderStatus,
      openedFromErrandStatus: dispute.openedFromErrandStatus,
    });
    if (!legalSource) {
      throw disputeError("DISPUTE_RESTORE_UNAVAILABLE");
    }
    nextOrderStatus = dispute.openedFromOrderStatus as OrderStatus;
    if (order.type === "ERRAND") {
      if (!lockedErrand || lockedErrand.status !== "DISPUTED") {
        throw disputeError("DISPUTE_INVALID_TRANSITION");
      }
      nextErrandStatus = dispute.openedFromErrandStatus;
    }
  } else {
    nextOrderStatus = "CLOSED";
    if (order.type === "ERRAND") {
      if (!lockedErrand || lockedErrand.status !== "DISPUTED") {
        throw disputeError("DISPUTE_INVALID_TRANSITION");
      }
      nextErrandStatus = "CLOSED";
    }
  }

  const now = new Date();
  const isResolved = input.resolutionCode !== undefined && input.resolutionCode !== null;

  await tx.orderDispute.update({
    where: { id: dispute.id },
    data: {
      status: isResolved ? "RESOLVED" : "CLOSED",
      resolutionCode: input.resolutionCode ?? undefined,
      resolutionAction: input.resolutionAction,
      resolvedById: input.actorId,
      resolvedAt: now,
      adminNote: input.adminNote || undefined,
    },
    select: { id: true },
  });

  await tx.order.update({
    where: { id: order.id },
    data: { status: nextOrderStatus },
    select: { id: true },
  });

  if (order.type === "ERRAND" && nextErrandStatus !== null && lockedErrand) {
    await tx.errandTask.update({
      where: { id: lockedErrand.id },
      data: { status: nextErrandStatus as never },
      select: { id: true },
    });
  }

  // PRODUCT CLOSE_ORDER：共享 release projection（§43）——不复制第二套
  // release algorithm。COMPLETED 源（Product SOLD）由 CASE C 天然 no-op。
  if (order.type === "PRODUCT" && order.productId && input.resolutionAction === "CLOSE_ORDER") {
    await projectProductAfterReservationRelease(tx, order.id, {
      productId: order.productId,
      sellerId: order.sellerId,
    });
  }
  // SERVICE：ServiceListing 不拥有单订单 reservation——CLOSE 不得修改
  // ServiceListing.status（§46，无操作即正确）。

  // ---- release 双方 source-linked holds（精确按 source；无关 hold 零触碰）----
  const releasedHolds = await releaseHoldsBySourceTxLocked(tx, {
    sourceType: DATA_HOLD_SOURCE_TYPE_ORDER_DISPUTE,
    sourceId: dispute.id,
    releasedById: input.actorId,
  });

  await recordAdminAudit(
    {
      actorId: input.actorId,
      action: isResolved ? "ORDER_DISPUTE_RESOLVED" : "ORDER_DISPUTE_CLOSED",
      targetType: "ORDER_DISPUTE",
      targetId: dispute.id,
      campusId: dispute.campusId,
      metadata: {
        resolutionCode: input.resolutionCode ?? null,
        resolutionAction: input.resolutionAction,
        sourceType: DATA_HOLD_SOURCE_TYPE_ORDER_DISPUTE,
        sourceId: dispute.id,
      },
    },
    tx,
  );

  await createNotifications(tx, [
    {
      userId: order.buyerId,
      orderId: order.id,
      type: "ORDER",
      title: "订单纠纷已处理",
      content: `你的订单纠纷已${isResolved ? "解决" : "关闭"}，订单状态已更新。`,
    },
    {
      userId: order.sellerId,
      orderId: order.id,
      type: "ORDER",
      title: "订单纠纷已处理",
      content: `你的订单纠纷已${isResolved ? "解决" : "关闭"}，订单状态已更新。`,
    },
  ]);

  return {
    disputeId: dispute.id,
    status: isResolved ? "RESOLVED" : "CLOSED",
    orderStatus: nextOrderStatus,
    errandStatus: nextErrandStatus,
    releasedHolds,
  };
}
