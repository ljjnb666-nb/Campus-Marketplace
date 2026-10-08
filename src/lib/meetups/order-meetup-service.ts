import type { Prisma } from "@prisma/client";

import { requireNewActivityAllowed } from "@/lib/feature-flags/feature-flag-guard";
import { createOrderDisputeFromLockedOrderTx } from "@/lib/order-dispute-machine";
import { assertActiveAccountMutationAllowed } from "@/lib/governance/active-account-mutation";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import type { MeetupErrorCode } from "@/lib/meetups/errors";
import {
  ACTIVE_MEETUP_STATUSES,
  isMeetupArrivalWindowOpen,
  isMeetupCancelWindowOpen,
  isMeetupConfirmTimeValid,
  isMeetupCustomLocationValid,
  isMeetupNoShowWindowOpen,
  isMeetupProposalTimeValid,
} from "@/lib/meetups/meetup-policy";

/**
 * Phase 8D-01：General Order meetup / no-show 的唯一状态 mutation authority
 * （PRODUCT / SERVICE 专属）。
 *
 * 领域边界（冻结）：
 *   - Meetup domain 只支持 PRODUCT / SERVICE General Order（两类均有
 *     meetingLocation 下单快照 + 真实面对面履约语义）。ERRAND（已有
 *     pickupLocation / deliveryLocation + 独立 ErrandTask lifecycle）与
 *     RENTAL（已有 RentalHandoverRecord / RentalReturnRecord）不进入本域，
 *     不同 aggregate 不得复用 Meetup 改写既有履约事实。
 *   - Order.meetingLocation 只是下单时初始偏好快照；正式见面约定 authority
 *     = OrderMeetup（locationTextSnapshot 在 proposal 创建时固化，查询绝不
 *     重新 join MeetupPoint 生成历史地点；MeetupPoint 改名/停用不改写历史）。
 *   - OrderMeetup.campusId 权威来源唯一 = 交易标的归属 campus（PRODUCT →
 *     Product.campusId / SERVICE → ServiceListing.campusId），禁止来自
 *     User.campusId / 客户端字段；campus 缺失 FAIL CLOSED。
 *   - OrderMeetup.COMPLETED 只表示双方 self-arrival 到场，绝不自动
 *     Order.COMPLETED / Product.SOLD / completedOrdersCount 累加——既有
 *     Order completion authority（updateOrderStatusTx）保持不变。
 *   - No-show 不是平台判责：只是 allegation + OrderDispute trigger。报告成功
 *     必须与 OrderDispute OPEN + Order IN_DISPUTE 同事务原子提交（复用
 *     createOrderDisputeFromLockedOrderTx 共享内核，禁止复制第二套 dispute
 *     创建逻辑；固定 system-authored reason，禁止拼接用户备注/地点）。
 *
 * 权威锁序（全局全序，禁止反序/追加）：
 *   candidate discovery（仅锁键发现，非权威）
 *   → sorted {USER:buyer, USER:seller} advisory locks（一次性完整取得；
 *     禁止先 actor 锁再发现 counterparty 再追加）
 *   → actor ACTIVE account mutation contract（checks-only，完整 pair 锁已持有）
 *   → Order FOR UPDATE（participants/type/type-FK/status fresh 权威）
 *   → OrderMeetup FOR UPDATE（status/scheduledAt/arrival fresh 权威）
 *   No-show 与 OrderDispute composition 服从同一顺序（内核不再取锁，
 *   campus/active-dispute 检查为锁内 plain read + 唯一性兜底）。
 *
 * 并发合同：active meetup 唯一性由 DB partial unique
 * OrderMeetup_order_active_key 兜底——并发 double propose 恰一个 winner；
 * 应用层 findFirst 检查只是提前失败体验。
 *
 * 时间策略全部来自 meetup-policy.ts（单一权威）；seams 仅测试注入，
 * 生产一律不传。Phase 8D-02 Server Action 只允许
 * validate → requireUser → withTransaction → 本文件 canonical service
 * → revalidate，禁止复制任何领域判断。本阶段（8D-01）无任何 UI/Action。
 */

export type OrderMeetupSeams = {
  /** sorted participant USER locks 取得之前（测试注入；生产不传） */
  beforeSubjectLocks?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** 全部锁 + fresh 谓词之后、首个写入之前（waiter 注入；生产不传） */
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/** no-show dispute 的固定 system-authored reason（§冻结：不拼接用户自由文本） */
export const MEETUP_NO_SHOW_DISPUTE_REASON =
  "线下见面爽约：交易一方报告对方未按约到场";

/** Meetup domain 支持的 General Order type（冻结：PRODUCT / SERVICE） */
const MEETUP_SUPPORTED_ORDER_TYPES: readonly string[] = ["PRODUCT", "SERVICE"];

type MeetupCandidateRow = {
  buyerId: string;
  sellerId: string;
};

type MeetupLockedOrderRow = {
  id: string;
  type: string;
  status: string;
  buyerId: string;
  sellerId: string;
  productId: string | null;
  serviceListingId: string | null;
  errandTaskId: string | null;
};

type LockedMeetupRow = {
  id: string;
  orderId: string;
  campusId: string;
  meetupPointId: string | null;
  locationTextSnapshot: string;
  scheduledAt: Date;
  status: string;
  proposedById: string;
  confirmedById: string | null;
  buyerArrivedAt: Date | null;
  sellerArrivedAt: Date | null;
};

type MeetupMutationContext = {
  order: MeetupLockedOrderRow;
  meetup: LockedMeetupRow;
};

export type ProposeOrderMeetupInput = {
  orderId: string;
  proposerId: string;
  scheduledAt: Date;
  /** catalog 来源（与 custom location 二选一；锁内 fresh 校验） */
  meetupPointId?: string | null;
  /** custom location（meetupPointId 为空时必填；trim 后 2..80） */
  locationText?: string | null;
};

export type ProposeOrderMeetupResult =
  | { error: MeetupErrorCode }
  | {
      success: true;
      meetupId: string;
      campusId: string;
      locationTextSnapshot: string;
      status: "PROPOSED";
    };

export type ConfirmOrderMeetupInput = {
  orderId: string;
  meetupId: string;
  confirmerId: string;
};

export type CancelOrderMeetupInput = {
  orderId: string;
  meetupId: string;
  actorId: string;
};

export type ArrivalOrderMeetupInput = {
  orderId: string;
  meetupId: string;
  actorId: string;
};

export type NoShowOrderMeetupInput = {
  orderId: string;
  meetupId: string;
  reporterId: string;
};

function meetupErrorResult(code: MeetupErrorCode): { error: MeetupErrorCode } {
  return { error: code };
}

/**
 * proposeOrderMeetupTx：创建 PROPOSED meetup（正式见面约定的唯一入口）。
 *
 * 允许：PRODUCT ACCEPTED / SERVICE ACCEPTED 的 buyer 或 seller。ERRAND /
 * 其他状态 DENY；已有任何 non-CANCELLED meetup DENY（恰一个 winner 由 DB
 * partial unique 兜底并发 double propose）。DENY 零写入。
 */
export async function proposeOrderMeetupTx(
  tx: Prisma.TransactionClient,
  input: ProposeOrderMeetupInput,
  seams?: OrderMeetupSeams,
): Promise<ProposeOrderMeetupResult> {
  // ---- 步骤 1：candidate pre-read（无锁，仅锁键发现；非权威）----
  const candidateRow = await tx.order.findUnique({
    where: { id: input.orderId },
    select: { buyerId: true, sellerId: true },
  });
  const candidate: MeetupCandidateRow | null = candidateRow;
  if (!candidate) {
    return meetupErrorResult("MEETUP_NOT_FOUND");
  }

  if (seams?.beforeSubjectLocks) {
    await seams.beforeSubjectLocks(tx);
  }

  // ---- 步骤 2：ONE sorted set：USER:buyer + USER:seller ----
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.buyerId },
    { subjectType: "USER", subjectId: candidate.sellerId },
  ]);

  // ---- 步骤 3：actor lifecycle 复核（checks-only；完整 pair 锁已持有）----
  await assertActiveAccountMutationAllowed(tx, input.proposerId);

  // ---- 步骤 4：Order FOR UPDATE + locked fresh revalidate ----
  const order = await lockMeetupOrder(tx, input.orderId);
  const orderError = validateMeetupOrder(order, candidate, input.proposerId);
  if (orderError || !order) {
    return meetupErrorResult(orderError ?? "MEETUP_NOT_FOUND");
  }

  // ---- 步骤 5：campus 权威快照（交易标的归属；缺失 FAIL CLOSED）----
  const campusId = await resolveMeetupCampusId(tx, order);
  if (!campusId) {
    return meetupErrorResult("MEETUP_INVALID_TRANSITION");
  }

  // ---- 步骤 6：location authority 固化（proposal 创建时定死 snapshot 与
  // 来源 provenance；RB01：来源语义 immutable，MeetupPoint 删除后
  // MEETUP_POINT 不降级为 CUSTOM）----
  let locationTextSnapshot: string;
  let locationSource: "CUSTOM" | "MEETUP_POINT";
  let resolvedMeetupPointId: string | null = null;
  if (input.meetupPointId) {
    // catalog 来源：锁内 fresh 校验存在 + isActive + campus 匹配；
    // 客户端不能提交 locationText 覆盖 catalog point
    const point = await tx.meetupPoint.findUnique({
      where: { id: input.meetupPointId },
      select: { campusId: true, isActive: true, locationText: true },
    });
    if (!point || !point.isActive || point.campusId !== campusId) {
      return meetupErrorResult("MEETUP_POINT_INVALID");
    }
    locationTextSnapshot = point.locationText;
    locationSource = "MEETUP_POINT";
    resolvedMeetupPointId = input.meetupPointId;
  } else {
    // custom location：与既有 meetingLocation UX 同级（trim 2..80）
    if (!input.locationText || !isMeetupCustomLocationValid(input.locationText)) {
      return meetupErrorResult("MEETUP_LOCATION_INVALID");
    }
    locationTextSnapshot = input.locationText.trim();
    locationSource = "CUSTOM";
  }

  if (!isMeetupProposalTimeValid(input.scheduledAt, new Date())) {
    return meetupErrorResult("MEETUP_TIME_WINDOW");
  }

  // ---- 步骤 7：active meetup 检查（DB partial unique 兜底并发 winner）----
  const activeMeetup = await tx.orderMeetup.findFirst({
    where: { orderId: input.orderId, status: { in: [...ACTIVE_MEETUP_STATUSES] } },
    select: { id: true },
  });
  if (activeMeetup) {
    return meetupErrorResult("MEETUP_ACTIVE_EXISTS");
  }

  if (seams?.racePoint) {
    await seams.racePoint(tx);
  }

  const now = new Date();
  await requireNewActivityAllowed(tx, { kind: "MEETUP", campusId });

  const created = await tx.orderMeetup.create({
    data: {
      orderId: input.orderId,
      campusId,
      meetupPointId: resolvedMeetupPointId,
      locationTextSnapshot,
      locationSource,
      scheduledAt: input.scheduledAt,
      status: "PROPOSED",
      proposedById: input.proposerId,
      createdAt: now,
    },
    select: { id: true },
  });

  return {
    success: true,
    meetupId: created.id,
    campusId,
    locationTextSnapshot,
    status: "PROPOSED",
  };
}

/**
 * confirmOrderMeetupTx：counterparty 确认 proposal（PROPOSED → CONFIRMED）。
 * proposer 不得自确认；已过期的 proposal DENY（不自动改状态）。
 */
export async function confirmOrderMeetupTx(
  tx: Prisma.TransactionClient,
  input: ConfirmOrderMeetupInput,
  seams?: OrderMeetupSeams,
): Promise<{ error: MeetupErrorCode } | { success: true; status: "CONFIRMED" }> {
  const context = await lockMeetupMutationContext(
    tx,
    { orderId: input.orderId, meetupId: input.meetupId, actorId: input.confirmerId },
    seams,
  );
  if ("error" in context) {
    return context;
  }
  const { meetup } = context;

  if (meetup.status !== "PROPOSED") {
    return meetupErrorResult("MEETUP_INVALID_TRANSITION");
  }
  // 只有 counterparty 可以确认（proposer 自确认 DENY）
  if (meetup.proposedById === input.confirmerId) {
    return meetupErrorResult("MEETUP_FORBIDDEN");
  }
  if (!isMeetupConfirmTimeValid(meetup.scheduledAt, new Date())) {
    return meetupErrorResult("MEETUP_TIME_WINDOW");
  }

  if (seams?.racePoint) {
    await seams.racePoint(tx);
  }

  const updated = await tx.orderMeetup.updateMany({
    where: { id: meetup.id, status: "PROPOSED" },
    data: {
      status: "CONFIRMED",
      confirmedById: input.confirmerId,
      confirmedAt: new Date(),
    },
  });
  if (updated.count === 0) {
    return meetupErrorResult("MEETUP_INVALID_TRANSITION");
  }

  return { success: true, status: "CONFIRMED" };
}

/**
 * cancelOrderMeetupTx：参与方取消 PROPOSED / CONFIRMED meetup。仅限
 * now < scheduledAt（约定时间到了之后不能用 CANCEL 绕过 no-show / dispute）。
 * Meetup cancellation != Order cancellation：不取消 Order、不释放 Product、
 * 不修改 ServiceListing。CANCELLED 之后允许重新发起新 meetup。
 */
export async function cancelOrderMeetupTx(
  tx: Prisma.TransactionClient,
  input: CancelOrderMeetupInput,
  seams?: OrderMeetupSeams,
): Promise<{ error: MeetupErrorCode } | { success: true; status: "CANCELLED" }> {
  const context = await lockMeetupMutationContext(tx, input, seams);  if ("error" in context) {
    return context;
  }
  const { meetup } = context;

  if (meetup.status !== "PROPOSED" && meetup.status !== "CONFIRMED") {
    return meetupErrorResult("MEETUP_INVALID_TRANSITION");
  }
  if (!isMeetupCancelWindowOpen(meetup.scheduledAt, new Date())) {
    return meetupErrorResult("MEETUP_TIME_WINDOW");
  }

  if (seams?.racePoint) {
    await seams.racePoint(tx);
  }

  const updated = await tx.orderMeetup.updateMany({
    where: { id: meetup.id, status: { in: ["PROPOSED", "CONFIRMED"] } },
    data: {
      status: "CANCELLED",
      cancelledById: input.actorId,
      cancelledAt: new Date(),
    },
  });
  if (updated.count === 0) {
    return meetupErrorResult("MEETUP_INVALID_TRANSITION");
  }

  return { success: true, status: "CANCELLED" };
}

/**
 * markOrderMeetupArrivalTx：self-arrival attestation（买家只能写
 * buyerArrivedAt / 卖家只能写 sellerArrivedAt，绝不接受指定 target）。
 * 仅 now >= scheduledAt 接受（提前 self-check-in 不接受）。重复 self-arrival
 * 幂等返回 alreadyArrived（绝不重写时间）。双方齐 → COMPLETED（只表示到场，
 * 不动 Order 状态 / Product / 计数）。
 */
export async function markOrderMeetupArrivalTx(
  tx: Prisma.TransactionClient,
  input: ArrivalOrderMeetupInput,
  seams?: OrderMeetupSeams,
): Promise<
  | { error: MeetupErrorCode }
  | { success: true; status: "CONFIRMED" | "COMPLETED"; alreadyArrived: boolean }
> {
  const context = await lockMeetupMutationContext(tx, input, seams);
  if ("error" in context) {
    return context;
  }
  const { order, meetup } = context;

  if (meetup.status !== "CONFIRMED") {
    return meetupErrorResult("MEETUP_INVALID_TRANSITION");
  }
  if (!isMeetupArrivalWindowOpen(meetup.scheduledAt, new Date())) {
    return meetupErrorResult("MEETUP_TIME_WINDOW");
  }

  const isBuyer = order.buyerId === input.actorId;
  const selfArrived = isBuyer ? meetup.buyerArrivedAt !== null : meetup.sellerArrivedAt !== null;
  if (selfArrived) {
    // 幂等：不重写时间
    return {
      success: true,
      status: meetup.status as "CONFIRMED",
      alreadyArrived: true,
    };
  }

  if (seams?.racePoint) {
    await seams.racePoint(tx);
  }

  const counterpartArrived = isBuyer
    ? meetup.sellerArrivedAt !== null
    : meetup.buyerArrivedAt !== null;
  const nextStatus = counterpartArrived ? "COMPLETED" : "CONFIRMED";
  const now = new Date();

  const updated = await tx.orderMeetup.updateMany({
    where: { id: meetup.id, status: "CONFIRMED" },
    data: isBuyer
      ? { buyerArrivedAt: now, status: nextStatus }
      : { sellerArrivedAt: now, status: nextStatus },
  });
  if (updated.count === 0) {
    return meetupErrorResult("MEETUP_INVALID_TRANSITION");
  }

  return { success: true, status: nextStatus, alreadyArrived: false };
}

/**
 * reportOrderMeetupNoShowTx：报告对方爽约（严格前提：meetup CONFIRMED、
 * Order ACCEPTED、now >= scheduledAt + grace、reporter 已 self-arrival、
 * target 未到场）。
 *
 * 成功 = 同一事务原子提交：Meetup NO_SHOW_REPORTED（终局，不可重开）+
 * OrderDispute OPEN + Order IN_DISPUTE + 双方 source-linked DataHold +
 * 通知（经 createOrderDisputeFromLockedOrderTx 唯一内核；固定
 * system-authored reason，meetup provenance 不进通用通知）。
 * triggeredDisputeId 指向本次产生的 canonical dispute（手动 dispute 恒 null）。
 * 任何前提不满足 → 零 mutation。
 */
export async function reportOrderMeetupNoShowTx(
  tx: Prisma.TransactionClient,
  input: NoShowOrderMeetupInput,
  seams?: OrderMeetupSeams,
): Promise<
  | { error: MeetupErrorCode }
  | { success: true; disputeId: string; status: "NO_SHOW_REPORTED" }
> {
  const context = await lockMeetupMutationContext(
    tx,
    { orderId: input.orderId, meetupId: input.meetupId, actorId: input.reporterId },
    seams,
  );
  if ("error" in context) {
    return context;
  }
  const { order, meetup } = context;

  if (meetup.status !== "CONFIRMED") {
    return meetupErrorResult("MEETUP_INVALID_TRANSITION");
  }
  if (!isMeetupNoShowWindowOpen(meetup.scheduledAt, new Date())) {
    return meetupErrorResult("MEETUP_TIME_WINDOW");
  }

  const isBuyer = order.buyerId === input.reporterId;
  const reporterArrived = isBuyer
    ? meetup.buyerArrivedAt !== null
    : meetup.sellerArrivedAt !== null;
  // 自己都没有签到 → 不能报告别人爽约
  if (!reporterArrived) {
    return meetupErrorResult("MEETUP_INVALID_TRANSITION");
  }
  const targetArrived = isBuyer
    ? meetup.sellerArrivedAt !== null
    : meetup.buyerArrivedAt !== null;
  if (targetArrived) {
    return meetupErrorResult("MEETUP_INVALID_TRANSITION");
  }
  const noShowTargetId = isBuyer ? order.sellerId : order.buyerId;

  if (seams?.racePoint) {
    await seams.racePoint(tx);
  }

  // ---- OrderDispute composition（唯一内核；锁序不变：本事务已持有完整
  // USER pair + Order 行锁，内核只做 campus snapshot / active dispute
  // 检查 + 写入。任何 error → 本事务零 mutation（尚未写 meetup））----
  const disputeOutcome = await createOrderDisputeFromLockedOrderTx(tx, {
    order: {
      id: order.id,
      type: order.type,
      status: order.status,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      productId: order.productId,
      serviceListingId: order.serviceListingId,
      errandTaskId: order.errandTaskId,
    },
    lockedErrand: null,
    initiatorId: input.reporterId,
    reason: MEETUP_NO_SHOW_DISPUTE_REASON,
    evidencePhotos: [],
  });
  if ("error" in disputeOutcome) {
    // 理论不可达（Order ACCEPTED 与 active dispute 互斥；防御性 fail closed）
    return meetupErrorResult("MEETUP_INVALID_TRANSITION");
  }

  const now = new Date();
  const updated = await tx.orderMeetup.updateMany({
    where: { id: meetup.id, status: "CONFIRMED" },
    data: {
      status: "NO_SHOW_REPORTED",
      noShowReportedById: input.reporterId,
      noShowTargetId,
      noShowReportedAt: now,
      triggeredDisputeId: disputeOutcome.disputeId,
    },
  });
  if (updated.count === 0) {
    // 理论不可达（OrderMeetup FOR UPDATE 行锁 + fresh CONFIRMED 之间不存在
    // 并发写者）；fail closed：throw 使调用方 withTransaction 整体 abort，
    // 绝不允许 dispute 已写而 meetup 停留 CONFIRMED 的部分提交。
    throw new Error("meetup no-show state changed under lock");
  }

  return {
    success: true,
    disputeId: disputeOutcome.disputeId,
    status: "NO_SHOW_REPORTED",
  };
}

// ============================================================
// 内部共享：锁内 Order 权威行 + 校验
// ============================================================

async function lockMeetupOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<MeetupLockedOrderRow | null> {
  const orderRows = await tx.$queryRaw<MeetupLockedOrderRow[]>`
    SELECT "id", "type", "status", "buyerId", "sellerId", "productId", "serviceListingId", "errandTaskId"
    FROM "Order"
    WHERE "id" = ${orderId}
    FOR UPDATE
  `;
  return orderRows[0] ?? null;
}

/**
 * locked fresh revalidate（fail closed，不信任 pre-read）：participants /
 * type 未漂移；actor 是 buyer OR seller；type ∈ {PRODUCT, SERVICE}（ERRAND
 * DENY）；type-FK consistency；Order.status == ACCEPTED。
 */
function validateMeetupOrder(
  order: MeetupLockedOrderRow | null,
  candidate: MeetupCandidateRow,
  actorId: string,
): MeetupErrorCode | null {
  if (!order) {
    return "MEETUP_NOT_FOUND";
  }
  if (order.buyerId !== candidate.buyerId || order.sellerId !== candidate.sellerId) {
    return "MEETUP_INVALID_TRANSITION";
  }
  if (order.buyerId !== actorId && order.sellerId !== actorId) {
    return "MEETUP_FORBIDDEN";
  }
  if (!MEETUP_SUPPORTED_ORDER_TYPES.includes(order.type)) {
    // ERRAND / 未知 type：不进入 meetup domain（RENTAL 不是 General Order，
    // 结构上不可能出现在 Order.type）
    return "MEETUP_INVALID_TRANSITION";
  }
  if (
    (order.type === "PRODUCT" &&
      (order.productId === null || order.serviceListingId !== null || order.errandTaskId !== null)) ||
    (order.type === "SERVICE" &&
      (order.serviceListingId === null || order.productId !== null || order.errandTaskId !== null))
  ) {
    return "MEETUP_INVALID_TRANSITION";
  }
  if (order.status !== "ACCEPTED") {
    return "MEETUP_INVALID_TRANSITION";
  }
  return null;
}

/**
 * campus 权威快照：来源唯一 = 交易标的归属 campus（PRODUCT → Product.campusId
 * / SERVICE → ServiceListing.campusId）。campusId 为 immutable 业务事实，
 * plain read 足够（与 dispute campus snapshot 同语义）。
 */
async function resolveMeetupCampusId(
  tx: Prisma.TransactionClient,
  order: MeetupLockedOrderRow,
): Promise<string | null> {
  if (order.type === "PRODUCT" && order.productId) {
    const product = await tx.product.findUnique({
      where: { id: order.productId },
      select: { campusId: true },
    });
    return product?.campusId ?? null;
  }
  if (order.type === "SERVICE" && order.serviceListingId) {
    const service = await tx.serviceListing.findUnique({
      where: { id: order.serviceListingId },
      select: { campusId: true },
    });
    return service?.campusId ?? null;
  }
  return null;
}

/**
 * confirm / cancel / arrival / no-show 共享锁内上下文：
 * sorted USER pair → Order FOR UPDATE + fresh 校验 → OrderMeetup FOR UPDATE
 * + orderId 配对校验。pre-read 仅锁键发现，非权威。
 */
async function lockMeetupMutationContext(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    meetupId: string;
  } & { actorId: string },
  seams?: OrderMeetupSeams,
): Promise<{ error: MeetupErrorCode } | MeetupMutationContext> {
  // ---- 步骤 1：candidate pre-read（仅锁键发现；非权威）----
  const candidateMeetup = await tx.orderMeetup.findUnique({
    where: { id: input.meetupId },
    select: { orderId: true },
  });
  if (!candidateMeetup) {
    return meetupErrorResult("MEETUP_NOT_FOUND");
  }
  const candidateRow = await tx.order.findUnique({
    where: { id: candidateMeetup.orderId },
    select: { buyerId: true, sellerId: true },
  });
  const candidate: MeetupCandidateRow | null = candidateRow;
  if (!candidate) {
    return meetupErrorResult("MEETUP_NOT_FOUND");
  }

  if (seams?.beforeSubjectLocks) {
    await seams.beforeSubjectLocks(tx);
  }

  // ---- 步骤 2：ONE sorted set：USER:buyer + USER:seller ----
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.buyerId },
    { subjectType: "USER", subjectId: candidate.sellerId },
  ]);

  // ---- 步骤 3：actor lifecycle 复核（checks-only）----
  await assertActiveAccountMutationAllowed(tx, input.actorId);

  // ---- 步骤 4：Order FOR UPDATE + fresh 校验 ----
  const order = await lockMeetupOrder(tx, input.orderId);
  const orderError = validateMeetupOrder(order, candidate, input.actorId);
  if (orderError || !order) {
    return meetupErrorResult(orderError ?? "MEETUP_NOT_FOUND");
  }

  // ---- 步骤 5：OrderMeetup FOR UPDATE + orderId 配对 ----
  const meetupRows = await tx.$queryRaw<LockedMeetupRow[]>`
    SELECT "id", "orderId", "campusId", "meetupPointId", "locationTextSnapshot",
           "scheduledAt", "status", "proposedById", "confirmedById",
           "buyerArrivedAt", "sellerArrivedAt"
    FROM "OrderMeetup"
    WHERE "id" = ${input.meetupId}
    FOR UPDATE
  `;
  const meetup = meetupRows[0];
  if (!meetup || meetup.orderId !== input.orderId) {
    return meetupErrorResult("MEETUP_NOT_FOUND");
  }

  return { order, meetup };
}
