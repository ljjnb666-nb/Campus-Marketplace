import type { Prisma } from "@prisma/client";

import {
  assertActiveAccountMutationAllowed,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { disputeCampusScopeKey, DISPUTE_ACTIVE_STATUSES } from "@/lib/disputes/dispute-scope";
import { computeDisputeDueAt } from "@/lib/disputes/dispute-sla";
import {
  createHoldTxLocked,
  DATA_HOLD_SOURCE_TYPE_ORDER_DISPUTE,
  ORDER_DISPUTE_HOLD_REASON_CODE,
} from "@/lib/privacy/data-hold-service";
import { emitNotificationsTx } from "@/lib/notifications/notification-service";
import { ORDER_DISPUTE_OPENED_KIND } from "@/lib/notifications/notification-registry";

/**
 * Phase 8C-01：General OrderDispute initiation 的唯一领域 authority
 * （PRODUCT / SERVICE / ERRAND）。
 *
 * 领域边界（冻结）：Report != Dispute；SupportTicket != Dispute；
 * RentalDispute != General OrderDispute——普通 Order 挂独立 OrderDispute
 * 聚合，不进 RentalDispute（deposit/pickup/return/damage claim/extension
 * 为 rental 专属语义）。
 *
 * 权威锁序（与 errand-lifecycle / product lifecycle / erasure / dispute
 * resolution 同一全局全序，禁止反序）：
 *   PRODUCT / SERVICE：
 *     candidate discovery（仅锁键发现，非权威）
 *     → sorted {USER:buyer, USER:seller} advisory locks（一次性完整取得）
 *     → initiator ACTIVE account mutation contract（counterparty 状态不阻止
 *       对历史交易的合法 dispute；active DataHold 保护后续 erasure）
 *     → Order FOR UPDATE（participants/type/type-FK/disputable fresh 权威）
 *     → 标的 campus snapshot 读（immutable 业务事实，无需行锁）
 *   ERRAND（服从既有 canonical ErrandTask → Order 方向，禁止 Order → ErrandTask）：
 *     candidate discovery → sorted USER pair → initiator ACTIVE
 *     → ErrandTask FOR UPDATE → Order FOR UPDATE → canonical pair 校验
 *
 * Disputable states（冻结，无时间窗口——filing window 留给未来产品政策）：
 *   PRODUCT：ACCEPTED / COMPLETED（PENDING 属 reservation lifecycle，禁入）
 *   SERVICE：ACCEPTED / IN_PROGRESS / COMPLETED
 *   ERRAND：canonical pair（Order ↔ ErrandTask）：
 *     ACCEPTED↔CLAIMED、IN_PROGRESS↔IN_PROGRESS、
 *     IN_PROGRESS↔PENDING_CONFIRMATION、COMPLETED↔COMPLETED；其余 fail closed
 *
 * COMPLETED 不是永久禁入：完成后可 dispute（提交 review ≠ 弃权，与
 * Rental Phase 8A-04 原则一致）。
 *
 * 创建写入（单事务原子，禁止部分提交）：
 *   OrderDispute OPEN（campus/scopeKey/openedFrom snapshots + dueAt = 48h SLA）
 *   → DataHold buyer + seller（source-linked，TxLocked seam——本事务已持有
 *     双方 USER 锁；partial unique 兜底并发重复）
 *   → Order IN_DISPUTE（ERRAND 另 ErrandTask DISPUTED）
 *   → generic 通知（system copy，禁止 user-authored 内容）
 *
 * 本域零 RiskFlag / EnforcementAction / credit/trust penalty / payment 语义
 * （bilateral transaction dispute ≠ confirmed misconduct）。
 *
 * 已知并发（记录为 Phase 8E debt，本阶段不顺手扩大）：general Review 与
 * OrderDispute initiation 的强 serialization（review 的 COMPLETED check 在
 * IN_DISPUTE 下自然失败，但两者无共享 row-lock serialization point）。
 */

export type OrderDisputeRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

export type OrderDisputeSeams = ActiveAccountMutationSeams & {
  /** fresh 谓词 + active-dispute 检查之后、首个写入之前（生产不传）。 */
  afterFreshChecks?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/** 各 type 合法 dispute 发起源状态（RESTORE_PREVIOUS 校验共用）。 */
export const DISPUTABLE_PRODUCT_STATUSES: readonly string[] = ["ACCEPTED", "COMPLETED"];
export const DISPUTABLE_SERVICE_STATUSES: readonly string[] = [
  "ACCEPTED",
  "IN_PROGRESS",
  "COMPLETED",
];

/** ERRAND 合法 initiation canonical pair（Order.status ↔ ErrandTask.status）。 */
export const DISPUTABLE_ERRAND_PAIRS: readonly (readonly [
  orderStatus: string,
  taskStatus: string,
])[] = [
  ["ACCEPTED", "CLAIMED"],
  ["IN_PROGRESS", "IN_PROGRESS"],
  ["IN_PROGRESS", "PENDING_CONFIRMATION"],
  ["COMPLETED", "COMPLETED"],
];

/** RESTORE_PREVIOUS 时校验 snapshot 是该 type 合法 dispute 源（§41）。 */
export function isOpenedFromLegalDisputableSource(input: {
  orderType: string;
  openedFromOrderStatus: string;
  openedFromErrandStatus: string | null;
}): boolean {
  if (input.orderType === "PRODUCT") {
    return DISPUTABLE_PRODUCT_STATUSES.includes(input.openedFromOrderStatus);
  }
  if (input.orderType === "SERVICE") {
    return DISPUTABLE_SERVICE_STATUSES.includes(input.openedFromOrderStatus);
  }
  if (input.orderType === "ERRAND") {
    return (
      input.openedFromErrandStatus !== null &&
      DISPUTABLE_ERRAND_PAIRS.some(
        ([orderStatus, taskStatus]) =>
          orderStatus === input.openedFromOrderStatus &&
          taskStatus === input.openedFromErrandStatus,
      )
    );
  }
  return false;
}

type CandidateRow = {
  type: string;
  buyerId: string;
  sellerId: string;
  productId: string | null;
  serviceListingId: string | null;
  errandTaskId: string | null;
};

type LockedOrderRow = {
  id: string;
  type: string;
  status: string;
  buyerId: string;
  sellerId: string;
  productId: string | null;
  serviceListingId: string | null;
  errandTaskId: string | null;
};

type LockedErrandRow = {
  id: string;
  status: string;
  campusId: string;
  publisherId: string;
  accepterId: string | null;
};

export type LockedOrderDisputeContext = {
  /** 锁内 fresh 权威 Order 行（调用方已 FOR UPDATE 并完成全部 fresh 谓词） */
  order: LockedOrderRow;
  /** ERRAND canonical Task 行（PRODUCT / SERVICE 恒 null） */
  lockedErrand: LockedErrandRow | null;
  initiatorId: string;
  reason: string;
  evidencePhotos: string[];
  /** 测试 seam：campus/active-dispute 检查之后、首个写入之前（生产不传） */
  racePoint?: OrderDisputeRacePoint;
  afterFreshChecks?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/**
 * createOrderDisputeFromLockedOrderTx：锁后 dispute 创建的共享内核
 * （Phase 8D-01 refactor 自 initiateOrderDisputeTx 原步骤 6-8 抽出，语义
 * 100% 不变——同一 campus snapshot / active dispute 检查 / dispute + holds +
 * Order IN_DISPUTE + 通知写入序列，禁止任何调用方复制第二套该逻辑）。
 *
 * 合同：调用方必须已持有完整 sorted participant USER 锁集 + Order
 * FOR UPDATE（ERRAND 另 ErrandTask 先序行锁），并完成参与者 / type-FK /
 * disputable 状态 fresh 校验。本函数只做：
 *   campus snapshot（交易标的归属，§immutable）→ active dispute 检查
 *   → dispute + 双方 DataHold + Order IN_DISPUTE（+ ERRAND DISPUTED）+ 通知。
 */
export async function createOrderDisputeFromLockedOrderTx(
  tx: Prisma.TransactionClient,
  context: LockedOrderDisputeContext,
): Promise<
  | { error: string }
  | {
      success: true;
      disputeId: string;
      productId: string | null;
      serviceListingId: string | null;
      errandTaskId: string | null;
    }
> {
  const { order, lockedErrand } = context;

  // ---- campus scope immutable snapshot（§15：来源唯一 = 交易标的
  // 归属 campus；User.campusId / initiator current campus 禁用。campusId 为
  // immutable 业务事实，无写路径，plain read 足够，不加行锁）----
  let campusId: string | null = null;
  if (order.type === "PRODUCT" && order.productId) {
    const product = await tx.product.findUnique({
      where: { id: order.productId },
      select: { campusId: true },
    });
    campusId = product?.campusId ?? null;
  } else if (order.type === "SERVICE" && order.serviceListingId) {
    const service = await tx.serviceListing.findUnique({
      where: { id: order.serviceListingId },
      select: { campusId: true },
    });
    campusId = service?.campusId ?? null;
  } else if (order.type === "ERRAND" && lockedErrand) {
    campusId = lockedErrand.campusId;
  }
  if (!campusId) {
    return { error: "无效请求" };
  }

  // ---- active dispute 检查（§29；DB partial unique 继续兜底）----
  const activeDispute = await tx.orderDispute.findFirst({
    where: { orderId: order.id, status: { in: [...DISPUTE_ACTIVE_STATUSES] } },
    select: { id: true },
  });
  if (activeDispute) {
    return { error: "该订单已有进行中的纠纷" };
  }

  if (context.racePoint) {
    await context.racePoint(tx);
  }
  if (context.afterFreshChecks) {
    await context.afterFreshChecks(tx);
  }

  // ---- dispute + holds + order/errand 状态 + 通知（原子）----
  const now = new Date();
  const dispute = await tx.orderDispute.create({
    data: {
      orderId: order.id,
      initiatorId: context.initiatorId,
      reason: context.reason,
      evidencePhotos: context.evidencePhotos,
      status: "OPEN",
      campusId,
      scopeKey: disputeCampusScopeKey(campusId),
      openedFromOrderStatus: order.status as never,
      openedFromErrandStatus:
        order.type === "ERRAND" && lockedErrand
          ? (lockedErrand.status as never)
          : null,
      dueAt: computeDisputeDueAt(now),
      createdAt: now,
    },
    select: { id: true },
  });

  // buyer + seller 各一条 source-linked DISPUTE hold（TxLocked seam：本事务
  // 已持有双方 subject 锁；partial unique 兜底并发重复 → 幂等收敛）
  await createHoldTxLocked(tx, {
    type: "DISPUTE",
    subjectType: "USER",
    subjectId: order.buyerId,
    reasonCode: ORDER_DISPUTE_HOLD_REASON_CODE,
    sourceType: DATA_HOLD_SOURCE_TYPE_ORDER_DISPUTE,
    sourceId: dispute.id,
  });
  await createHoldTxLocked(tx, {
    type: "DISPUTE",
    subjectType: "USER",
    subjectId: order.sellerId,
    reasonCode: ORDER_DISPUTE_HOLD_REASON_CODE,
    sourceType: DATA_HOLD_SOURCE_TYPE_ORDER_DISPUTE,
    sourceId: dispute.id,
  });

  await tx.order.update({
    where: { id: order.id },
    data: { status: "IN_DISPUTE" },
  });

  if (order.type === "ERRAND" && lockedErrand) {
    await tx.errandTask.update({
      where: { id: lockedErrand.id },
      data: { status: "DISPUTED" },
    });
  }

  // generic system copy（§35：禁止 reason / title / meetingLocation / note）；
  // Phase 9B：canonical notification domain（角色化文案由 registry 渲染）。
  // dedupe 以 disputeId 为聚合（同单可在旧纠纷关闭后再次开纠纷）。
  await emitNotificationsTx(tx, [
    {
      kind: ORDER_DISPUTE_OPENED_KIND,
      recipientUserId: order.buyerId,
      orderId: order.id,
      dedupeKey: `${ORDER_DISPUTE_OPENED_KIND}:${dispute.id}:${order.buyerId}`,
      payload: { orderId: order.id, disputeId: dispute.id, initiatorUserId: context.initiatorId },
    },
    {
      kind: ORDER_DISPUTE_OPENED_KIND,
      recipientUserId: order.sellerId,
      orderId: order.id,
      dedupeKey: `${ORDER_DISPUTE_OPENED_KIND}:${dispute.id}:${order.sellerId}`,
      payload: { orderId: order.id, disputeId: dispute.id, initiatorUserId: context.initiatorId },
    },
  ]);

  return {
    success: true,
    disputeId: dispute.id,
    productId: order.productId,
    serviceListingId: order.serviceListingId,
    errandTaskId: order.errandTaskId,
  };
}

/**
 * initiateOrderDisputeTx：General Order dispute 创建的唯一权威。
 *
 * 成功结果携带 locked authoritative Order 的 type-FK 上下文
 * （Phase 8C-02：仅供 action 层 revalidate 用户视图，禁止以此做任何
 * 事务外二次 authority read——最终裁决仍是本服务锁内 fresh check）。
 * 返回 { error }（统一 SAFE 文案，不泄漏治理/参与方状态）。任何 DENY
 * 零写入零通知。
 */
export async function initiateOrderDisputeTx(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    userId: string;
    reason: string;
    /** Phase 8C-01：生产入口尚未开放，恒传 []；字段保留与 RentalDispute 对齐 */
    evidencePhotos: string[];
    /** 测试 seam：锁 + 复查之后、首个写入之前（waiter 注入；生产不传） */
    racePoint?: OrderDisputeRacePoint;
    /** 测试 seam：sorted participant USER locks 取得之前（生产不传） */
    beforeSubjectLocks?: OrderDisputeRacePoint;
  },
  seams?: OrderDisputeSeams,
): Promise<
  | { error: string }
  | {
      success: true;
      disputeId: string;
      productId: string | null;
      serviceListingId: string | null;
      errandTaskId: string | null;
    }
> {
  // ---- 步骤 1：candidate pre-read（无锁，仅锁键发现；§22 不得信任 status /
  // campus / business state）----
  const candidateRow = await tx.order.findUnique({
    where: { id: input.orderId },
    select: {
      type: true,
      buyerId: true,
      sellerId: true,
      productId: true,
      serviceListingId: true,
      errandTaskId: true,
    },
  });
  const candidate: CandidateRow | null = candidateRow;
  if (!candidate) {
    return { error: "无效请求" };
  }

  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }
  if (input.beforeSubjectLocks) {
    await input.beforeSubjectLocks(tx);
  }

  // ---- 步骤 2：ONE sorted set：USER:buyer + USER:seller（§23 全局锁序）----
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.buyerId },
    { subjectType: "USER", subjectId: candidate.sellerId },
  ]);

  // ---- 步骤 3：initiator lifecycle 复核（checks-only——完整 pair 锁已持有；
  // counterparty SUSPENDED/erasure pending/risk restricted 不阻止对历史交易
  // 的合法 dispute；active DataHold 保护后续 erasure）（§24）----
  await assertActiveAccountMutationAllowed(tx, input.userId);

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  // ---- 步骤 4：行锁（type 决定 ErrandTask → Order 或 Order 权威）----
  let lockedErrand: LockedErrandRow | null = null;
  if (candidate.type === "ERRAND") {
    // §26：ERRAND 服从既有 canonical（USER → ErrandTask → Order），
    // 禁止 Order → ErrandTask 反序（与 errand-lifecycle 成 deadlock surface）
    const errandRows = await tx.$queryRaw<LockedErrandRow[]>`
      SELECT "id", "status", "campusId", "publisherId", "accepterId"
      FROM "ErrandTask"
      WHERE "id" = ${candidate.errandTaskId}
      FOR UPDATE
    `;
    lockedErrand = errandRows[0] ?? null;
  }

  const orderRows = await tx.$queryRaw<LockedOrderRow[]>`
    SELECT "id", "type", "status", "buyerId", "sellerId", "productId", "serviceListingId", "errandTaskId"
    FROM "Order"
    WHERE "id" = ${input.orderId}
    FOR UPDATE
  `;
  const order = orderRows[0];
  if (!order) {
    return { error: "无效请求" };
  }

  // ---- 步骤 5：locked fresh revalidate（fail closed，不信任 pre-read）----
  // participants 未漂移（§27）
  if (order.buyerId !== candidate.buyerId || order.sellerId !== candidate.sellerId) {
    return { error: "订单状态已变化，请重试" };
  }
  if (order.type !== candidate.type) {
    return { error: "订单状态已变化，请重试" };
  }
  // initiator 仍是 buyer OR seller
  if (order.buyerId !== input.userId && order.sellerId !== input.userId) {
    return { error: "无效请求" };
  }

  // type-FK consistency（§28 fail closed；不加全表 CHECK，service 层拒绝）
  if (
    (order.type === "PRODUCT" &&
      (order.productId === null || order.serviceListingId !== null || order.errandTaskId !== null)) ||
    (order.type === "SERVICE" &&
      (order.serviceListingId === null || order.productId !== null || order.errandTaskId !== null)) ||
    (order.type === "ERRAND" &&
      (order.errandTaskId === null || order.productId !== null || order.serviceListingId !== null))
  ) {
    return { error: "无效请求" };
  }

  // ERRAND canonical pair 校验（§18；ERRAND 需 Task 行存在且参与者与 Order 一致）
  if (order.type === "ERRAND") {
    if (
      !lockedErrand ||
      lockedErrand.id !== order.errandTaskId ||
      lockedErrand.publisherId !== order.buyerId ||
      lockedErrand.accepterId !== order.sellerId
    ) {
      return { error: "无效请求" };
    }
    const pairLegal = DISPUTABLE_ERRAND_PAIRS.some(
      ([orderStatus, taskStatus]) =>
        orderStatus === order.status && taskStatus === lockedErrand!.status,
    );
    if (!pairLegal) {
      return { error: "状态不允许纠纷" };
    }
  } else if (order.type === "PRODUCT") {
    if (!DISPUTABLE_PRODUCT_STATUSES.includes(order.status)) {
      return { error: "状态不允许纠纷" };
    }
  } else if (order.type === "SERVICE") {
    if (!DISPUTABLE_SERVICE_STATUSES.includes(order.status)) {
      return { error: "状态不允许纠纷" };
    }
  } else {
    return { error: "无效请求" };
  }

  // ---- 步骤 6-11（Phase 8D-01 refactor：共享内核，语义 100% 不变）----
  // campus snapshot → active dispute 检查 → dispute + holds + Order
  // IN_DISPUTE（+ ERRAND DISPUTED）+ 通知，全部委托唯一内核
  // createOrderDisputeFromLockedOrderTx（racePoint / afterFreshChecks seam
  // 时序原样保留：均在 campus/active-dispute 检查之后、首个写入之前）。
  return createOrderDisputeFromLockedOrderTx(tx, {
    order,
    lockedErrand,
    initiatorId: input.userId,
    reason: input.reason,
    evidencePhotos: input.evidencePhotos,
    racePoint: input.racePoint,
    afterFreshChecks: seams?.afterFreshChecks,
  });
}
