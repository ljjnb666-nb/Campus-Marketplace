import type {
  DisputeResolutionAction,
  DisputeResolutionCode,
  Prisma,
  RentalOrderStatus,
} from "@prisma/client";

import { disputeError } from "@/lib/disputes/errors";
import { DISPUTE_REVIEW_PERMISSION } from "@/lib/disputes/dispute-access";
import { resolveDisputeScope } from "@/lib/disputes/dispute-scope";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { writeStatusLog } from "@/lib/rental-order-machine";
import {
  DATA_HOLD_SOURCE_TYPE_RENTAL_DISPUTE,
  releaseHoldsBySourceTxLocked,
} from "@/lib/privacy/data-hold-service";
import { withTransaction } from "@/lib/prisma";
import { rbacError } from "@/lib/rbac/errors";
import {
  loadAuthorizationContext,
  requirePermissionInContext,
} from "@/lib/rbac/service";
import { createNotifications } from "@/repositories/notification-repository";

/**
 * Phase 7G：纠纷运营 canonical 治理服务（claim / release / resolve / close）。
 *
 * v1：仅 self claim/release（无任意 assign-other UI），与 7E case 服务同构。
 *
 * 冻结合同：
 * - 锁序（与 initiateDisputeTx / role revoke / account suspend / erasure /
 *   membership enforcement / 其它 dispute 决策同一全序，禁止反序）：
 *     claim/release：USER:actor subject lock → RentalDispute 行 FOR UPDATE
 *       → racePoint → 锁后授权重读（dispute.review @ dispute.campusId）
 *     resolve/close：pre-read only for lock discovery → ONE COMPLETE SORTED SET
 *       （USER:actor + USER:owner + USER:renter）→ RentalDispute 行 FOR UPDATE
 *       → RentalOrder 行 FOR UPDATE → racePoint → 锁后授权重读
 * - 状态机（directive 冻结，禁止 reopen）：
 *     OPEN → IN_REVIEW（claim）；OPEN → RESOLVED / CLOSED；
 *     IN_REVIEW → RESOLVED / CLOSED；terminal（RESOLVED/CLOSED）不可再变更。
 * - claim：未领用 → assignedToId=actor ∧ OPEN→IN_REVIEW；已是自己 → 幂等
 *   no-op；他人领用 → DISPUTE_ALREADY_CLAIMED fail closed；dueAt 不重置。
 * - release：仅 assignee（他人 → DISPUTE_RELEASE_FORBIDDEN）；未领用 → 幂等；
 *   IN_REVIEW → OPEN，assignedToId=null；dueAt 不重置。
 * - resolution mutation 同一事务内完成：dispute 终局 → order 收敛动作
 *   （RESTORE_PREVIOUS：openedFromOrderStatus 为 null 时 DENY——绝不猜历史；
 *   CLOSE_ORDER：订单 → CLOSED）→ release 双方 source-linked holds → audit →
 *   通知。禁止自动 refund / 押金 / payout / payment 对账（金额字段零修改）。
 * - 本域绝不产生 EnforcementAction / RiskFlag（DISPUTE_AUTO_RISK_FLAG =
 *   DISABLED；需要处罚必须单独走 canonical enforcement service）。
 */

export type DisputeRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

type LockedDisputeRow = {
  id: string;
  campusId: string;
  scopeKey: string;
  status: string;
  assignedToId: string | null;
};

/**
 * claim/release 共享前段：USER:actor 锁 → dispute 行锁 → racePoint →
 * 锁后授权重读（exact campus）。返回锁内 dispute 现势。
 */
async function withDisputeAuthority(
  tx: Prisma.TransactionClient,
  input: { actorId: string; disputeId: string; racePoint?: DisputeRacePoint },
): Promise<LockedDisputeRow> {
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: input.actorId },
  ]);

  const rows = await tx.$queryRaw<
    { id: string; campusId: string; scopeKey: string; status: string; assignedToId: string | null }[]
  >`
    SELECT "id", "campusId", "scopeKey", "status", "assignedToId"
    FROM "RentalDispute"
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

  await requireDisputeReviewAuthorization(tx, input.actorId, {
    campusId: locked.campusId,
    scopeKey: locked.scopeKey,
  });

  return locked;
}

/** 锁后授权重读：dispute.review @ dispute campus exact（fail closed）。 */
async function requireDisputeReviewAuthorization(
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

/** 纠纷领用（self claim）。并发竞争：dispute 行锁下恰好一个 canonical winner。 */
export async function claimDispute(input: {
  actorId: string;
  disputeId: string;
  racePoint?: DisputeRacePoint;
}): Promise<{ disputeId: string; assignedToId: string | null; outcome: "CLAIMED" | "ALREADY_YOURS" }> {
  return withTransaction(async (tx) => {
    const locked = await withDisputeAuthority(tx, input);

    if (locked.status === "RESOLVED" || locked.status === "CLOSED") {
      throw disputeError("DISPUTE_TERMINAL");
    }
    if (locked.assignedToId === input.actorId) {
      return { disputeId: locked.id, assignedToId: locked.assignedToId, outcome: "ALREADY_YOURS" };
    }
    if (locked.assignedToId !== null) {
      throw disputeError("DISPUTE_ALREADY_CLAIMED");
    }

    await tx.rentalDispute.update({
      where: { id: locked.id },
      data: { assignedToId: input.actorId, status: "IN_REVIEW" },
      select: { id: true },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "DISPUTE_CLAIMED",
        targetType: "RENTAL_DISPUTE",
        targetId: locked.id,
        campusId: locked.campusId,
      },
      tx,
    );

    return { disputeId: locked.id, assignedToId: input.actorId, outcome: "CLAIMED" };
  });
}

/**
 * 纠纷释放（self release）。仅 assignee 可释放；IN_REVIEW → OPEN；
 * dueAt 不重置（时钟从创建起算）。
 */
export async function releaseDispute(input: {
  actorId: string;
  disputeId: string;
  racePoint?: DisputeRacePoint;
}): Promise<{ disputeId: string; assignedToId: string | null; outcome: "RELEASED" | "ALREADY_RELEASED" }> {
  return withTransaction(async (tx) => {
    const locked = await withDisputeAuthority(tx, input);

    if (locked.status === "RESOLVED" || locked.status === "CLOSED") {
      throw disputeError("DISPUTE_TERMINAL");
    }
    if (locked.assignedToId === null) {
      return { disputeId: locked.id, assignedToId: null, outcome: "ALREADY_RELEASED" };
    }
    if (locked.assignedToId !== input.actorId) {
      throw disputeError("DISPUTE_RELEASE_FORBIDDEN");
    }

    await tx.rentalDispute.update({
      where: { id: locked.id },
      data: { assignedToId: null, status: "OPEN" },
      select: { id: true },
    });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "DISPUTE_RELEASED",
        targetType: "RENTAL_DISPUTE",
        targetId: locked.id,
        campusId: locked.campusId,
      },
      tx,
    );

    return { disputeId: locked.id, assignedToId: null, outcome: "RELEASED" };
  });
}

export type ResolveDisputeInput = {
  actorId: string;
  disputeId: string;
  resolutionCode: DisputeResolutionCode;
  resolutionAction: DisputeResolutionAction;
  adminNote?: string | null;
  racePoint?: DisputeRacePoint;
};

export type ResolveDisputeResult = {
  disputeId: string;
  status: "RESOLVED" | "CLOSED";
  orderStatus: string;
  releasedHolds: number;
};

/**
 * 纠纷终局（RESOLVED / CLOSED 共享内核）。
 *
 * 冻结链（单个 locked transaction）：
 *   pre-read only for lock discovery（dispute → order 当事人）
 *   → ONE COMPLETE SORTED SET：USER:actor + USER:owner + USER:renter
 *   → RentalDispute FOR UPDATE → RentalOrder FOR UPDATE
 *   → racePoint → 锁后授权重读（dispute.review @ campus）
 *   → 状态机断言（OPEN|IN_REVIEW → terminal；terminal 再终局 = 幂等拒绝）
 *   → order 收敛动作（RESTORE_PREVIOUS / CLOSE_ORDER）
 *   → release 双方 source-linked holds（精确按 source，无关 hold 零触碰）
 *   → audit（DISPUTE_RESOLVED / DISPUTE_CLOSED）→ 双方通知。
 */
export async function resolveDispute(input: ResolveDisputeInput): Promise<ResolveDisputeResult> {
  return withTransaction(async (tx) =>
    resolveDisputeTxLocked(tx, input, async (innerTx) => {
      // pre-read only for lock discovery（dispute id → order 当事人锁键）
      const probe = await innerTx.rentalDispute.findUnique({
        where: { id: input.disputeId },
        select: { order: { select: { ownerId: true, renterId: true } } },
      });
      if (!probe) {
        throw disputeError("DISPUTE_NOT_FOUND");
      }
      return probe.order;
    }),
  );
}

/**
 * closeDispute = RESOLVED 的姊妹终局（不携带 resolutionCode；order 收敛动作
 * 仍为必填——每个 terminal transition 都必须收敛订单，绝不留 IN_DISPUTE 悬挂）。
 */
export async function closeDispute(input: {
  actorId: string;
  disputeId: string;
  resolutionAction: DisputeResolutionAction;
  adminNote?: string | null;
  racePoint?: DisputeRacePoint;
}): Promise<ResolveDisputeResult> {
  return withTransaction(async (tx) =>
    resolveDisputeTxLocked(tx, input, async (innerTx) => {
      const probe = await innerTx.rentalDispute.findUnique({
        where: { id: input.disputeId },
        select: { order: { select: { ownerId: true, renterId: true } } },
      });
      if (!probe) {
        throw disputeError("DISPUTE_NOT_FOUND");
      }
      return probe.order;
    }),
  );
}

/**
 * TxLocked 终局内核。前置条件：fullLockDiscovery 已在同一事务内取得
 * {USER:actor, USER:owner, USER:renter} 完整 sorted set 并返回当事人。
 */
async function resolveDisputeTxLocked(
  tx: Prisma.TransactionClient,
  input: {
    actorId: string;
    disputeId: string;
    resolutionAction: DisputeResolutionAction;
    resolutionCode?: DisputeResolutionCode | null;
    adminNote?: string | null;
    racePoint?: DisputeRacePoint;
  },
  fullLockDiscovery: (tx: Prisma.TransactionClient) => Promise<{ ownerId: string; renterId: string }>,
): Promise<ResolveDisputeResult> {
  const parties = await fullLockDiscovery(tx);

  // ONE COMPLETE SORTED SET：actor + owner + renter（与 erasure / role revoke /
  // 新 dispute 创建同锁序线性化；sorted 去重由 lock helper 保证）
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: input.actorId },
    { subjectType: "USER", subjectId: parties.ownerId },
    { subjectType: "USER", subjectId: parties.renterId },
  ]);

  // RentalDispute FOR UPDATE
  const disputeRows = await tx.$queryRaw<
    {
      id: string;
      campusId: string;
      scopeKey: string;
      status: string;
      assignedToId: string | null;
      openedFromOrderStatus: string | null;
    }[]
  >`
    SELECT "id", "campusId", "scopeKey", "status", "assignedToId", "openedFromOrderStatus"
    FROM "RentalDispute"
    WHERE "id" = ${input.disputeId}
    FOR UPDATE`;
  const dispute = disputeRows[0];
  if (!dispute) {
    throw disputeError("DISPUTE_NOT_FOUND");
  }

  // RentalOrder FOR UPDATE（dispute 先于 order，全仓 canonical 锁序）
  const orderRows = await tx.$queryRaw<{ id: string; ownerId: string; renterId: string; status: string }[]>`
    SELECT "id", "ownerId", "renterId", "status"
    FROM "RentalOrder"
    WHERE "id" = (
      SELECT "orderId" FROM "RentalDispute" WHERE "id" = ${input.disputeId}
    )
    FOR UPDATE`;
  const order = orderRows[0];
  if (!order) {
    throw disputeError("DISPUTE_NOT_FOUND");
  }

  // 当事人锁键与锁内现势不一致 → 取错了锁，fail closed（无 owner 转移路径，
  // 结构上不可达；防御 pre-read 与行锁之间的任何极端交错）
  if (order.ownerId !== parties.ownerId || order.renterId !== parties.renterId) {
    throw disputeError("DISPUTE_INVALID_TRANSITION");
  }

  if (input.racePoint) {
    await input.racePoint(tx);
  }

  // 锁后授权重读（must await——吞错即 fail-open）
  await requireDisputeReviewAuthorization(tx, input.actorId, {
    campusId: dispute.campusId,
    scopeKey: dispute.scopeKey,
  });

  // 状态机断言：OPEN|IN_REVIEW → terminal；terminal 不可再变更（禁止 reopen）
  if (dispute.status !== "OPEN" && dispute.status !== "IN_REVIEW") {
    throw disputeError("DISPUTE_TERMINAL");
  }
  // 订单必须仍在 IN_DISPUTE（dispute active ↔ order IN_DISPUTE 的合同不变量）
  if (order.status !== "IN_DISPUTE") {
    throw disputeError("DISPUTE_INVALID_TRANSITION");
  }

  // ---- order 收敛动作（金额字段零修改；refund/押金/payout 为冻结禁区）----
  let nextOrderStatus: RentalOrderStatus;
  if (input.resolutionAction === "RESTORE_PREVIOUS") {
    // openedFromOrderStatus 缺失 = 历史残缺：DENY，绝不猜历史状态
    if (dispute.openedFromOrderStatus === null) {
      throw disputeError("DISPUTE_RESTORE_UNAVAILABLE");
    }
    nextOrderStatus = dispute.openedFromOrderStatus as RentalOrderStatus;
  } else {
    nextOrderStatus = "CLOSED";
  }

  const now = new Date();
  const isResolved = input.resolutionCode !== undefined && input.resolutionCode !== null;

  await tx.rentalDispute.update({
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

  await tx.rentalOrder.update({
    where: { id: order.id },
    data: { status: nextOrderStatus },
    select: { id: true },
  });

  await writeStatusLog(tx, {
    orderId: order.id,
    fromStatus: "IN_DISPUTE",
    toStatus: nextOrderStatus,
    operatorId: input.actorId,
    note: `租赁纠纷终局：${isResolved ? "已解决" : "已关闭"}（${input.resolutionAction}）`,
  });

  // ---- release 双方 source-linked holds（精确按 source；无关 hold 零触碰）----
  const releasedHolds = await releaseHoldsBySourceTxLocked(tx, {
    sourceType: DATA_HOLD_SOURCE_TYPE_RENTAL_DISPUTE,
    sourceId: dispute.id,
    releasedById: input.actorId,
  });

  await recordAdminAudit(
    {
      actorId: input.actorId,
      action: isResolved ? "DISPUTE_RESOLVED" : "DISPUTE_CLOSED",
      targetType: "RENTAL_DISPUTE",
      targetId: dispute.id,
      campusId: dispute.campusId,
      metadata: {
        resolutionCode: input.resolutionCode ?? null,
        resolutionAction: input.resolutionAction,
        sourceType: DATA_HOLD_SOURCE_TYPE_RENTAL_DISPUTE,
        sourceId: dispute.id,
      },
    },
    tx,
  );

  await createNotifications(tx, [
    {
      userId: order.ownerId,
      type: "RENTAL",
      title: "订单纠纷已处理",
      content: `你的订单纠纷已${isResolved ? "解决" : "关闭"}，订单状态已更新。`,
    },
    {
      userId: order.renterId,
      type: "RENTAL",
      title: "订单纠纷已处理",
      content: `你的订单纠纷已${isResolved ? "解决" : "关闭"}，订单状态已更新。`,
    },
  ]);

  return {
    disputeId: dispute.id,
    status: isResolved ? "RESOLVED" : "CLOSED",
    orderStatus: nextOrderStatus,
    releasedHolds,
  };
}
