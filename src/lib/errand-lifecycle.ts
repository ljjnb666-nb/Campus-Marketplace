import type { ErrandTaskStatus, Prisma } from "@prisma/client";

import { requireMarketplaceCapability } from "@/lib/enforcement/capability-gate";
import { completeErrandOrderTx } from "@/lib/errand-completion";
import {
  assertActiveAccountMutationAllowed,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { createNotifications } from "@/repositories/notification-repository";

/**
 * AUDIT2-RB02（ERRAND LIFECYCLE AUTHORITY CLOSURE）：
 *
 * 冻结不变量：ErrandTask + 其当前 active ERRAND Order 组成一个业务生命
 * 周期 aggregate，状态转换必须由 ONE CANONICAL AUTHORITY 同时决定——
 * 禁止 ErrandTask / Order 各自拥有同一业务 transition 的独立写入口。
 *
 * canonical state pairs（合法主要组合）：
 *   OPEN                 ↔ 无 active ERRAND Order（历史 CANCELLED 允许）
 *   CLAIMED              ↔ Order ACCEPTED
 *   IN_PROGRESS          ↔ Order IN_PROGRESS
 *   PENDING_CONFIRMATION ↔ Order IN_PROGRESS
 *   COMPLETED            ↔ Order COMPLETED
 *
 * 权威锁序（全局唯一，禁止反序；与 claimErrandTx 的 participant 锁 →
 * ErrandTask 行锁兼容，与 cancelProductOrderTx 的 USER → Order → Product
 * 无环）：
 *   sorted USER participant advisory locks（一次性完整取得，禁止 actor 锁后追加）
 *   → ErrandTask FOR UPDATE（fresh 谓词权威）
 *   → active Order FOR UPDATE（exact cardinality）
 *   → capability / predicates
 *   → writes
 *
 * 参与方资格语义：transition 属既有义务 wind-down/progression，仅要求
 * actor 满足 ACTIVE account mutation contract（checks-only，锁已持有）；
 * counterparty suspended/restricted 不阻断。唯一例外：CLAIMED → OPEN 属
 * 重新暴露（EXPOSURE_INCREASING），publisher 必须通过
 * START_NEW_MARKETPLACE_ACTIVITY capability（既有 taxonomy，不改变）。
 *
 * 异常数据 fail closed：CLAIMED/IN_PROGRESS/PENDING_CONFIRMATION 必须恰好
 * 匹配 1 个 active ERRAND Order（buyer=publisher / seller=accepter），0 或
 * >1 一律拒绝，绝不猜 latest；OPEN 存在 active Order 视为异常，edit /
 * delete / cancel-open 一律拒绝，不得扩大矛盾。
 */

/** 占用 active obligation 的 ERRAND Order 状态（COMPLETED/CANCELLED 不属于）。 */
export const ACTIVE_ERRAND_ORDER_STATUSES: readonly ["ACCEPTED", "IN_PROGRESS"] = [
  "ACCEPTED",
  "IN_PROGRESS",
];

/**
 * seams 仅测试注入（生产一律不传）。beforeLock / afterCheck 与
 * ActiveAccountMutationSeams 语义对齐；afterErrandRowLock / afterOrderRowLock
 * 供竞态测试在权威齐备后受控暂停（生产路径不传）。
 */
export type ErrandLifecycleSeams = ActiveAccountMutationSeams & {
  afterErrandRowLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  afterOrderRowLock?: (tx: Prisma.TransactionClient) => Promise<void>;
};

type ErrandCandidateRow = {
  id: string;
  publisherId: string;
  accepterId: string | null;
};

type LockedErrandRow = {
  id: string;
  campusId: string;
  status: string;
  publisherId: string;
  accepterId: string | null;
  deletedAt: Date | null;
};

type LockedActiveOrderRow = {
  id: string;
  status: string;
  buyerId: string;
  sellerId: string;
};

/** 事务开始阶段的 candidate 发现（§11）：仅用于确定参与者锁集，不是
 * status / role / order 权威——锁后必须以 FOR UPDATE fresh row 重验。 */
async function discoverErrandCandidate(
  tx: Prisma.TransactionClient,
  errandId: string,
): Promise<ErrandCandidateRow | null> {
  const rows = await tx.$queryRaw<ErrandCandidateRow[]>`
    SELECT id, "publisherId", "accepterId"
    FROM "ErrandTask"
    WHERE id = ${errandId}
      AND "deletedAt" IS NULL
  `;
  return rows[0] ?? null;
}

/** participant 锁集（§12/§13）：candidate 有 accepter → 双方 sorted；
 * OPEN（accepterId null）→ 仅 publisher（claimErrandTx 共享 publisher 锁，
 * claim vs edit/delete/cancel 由此线性化）。 */
function errandParticipantSubjects(
  candidate: ErrandCandidateRow,
): Array<{ subjectType: string; subjectId: string }> {
  const subjects = [{ subjectType: "USER", subjectId: candidate.publisherId }];
  if (candidate.accepterId) {
    subjects.push({ subjectType: "USER", subjectId: candidate.accepterId });
  }
  return subjects;
}

/** ErrandTask 行权威（§16）：锁后 fresh 重验 id/deletedAt/publisherId/
 * accepterId/status/campusId。 */
async function lockErrandTaskRow(
  tx: Prisma.TransactionClient,
  errandId: string,
): Promise<LockedErrandRow | null> {
  const rows = await tx.$queryRaw<LockedErrandRow[]>`
    SELECT id, "campusId", status, "publisherId", "accepterId", "deletedAt"
    FROM "ErrandTask"
    WHERE id = ${errandId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** active ERRAND Order 解析（§17/§18）：type=ERRAND + errandTaskId 命中 +
 * status ∈ active，逐行 FOR UPDATE。返回全部匹配行——调用方按状态要求
 * 恰好 0 / 1 个，绝不按 createdAt 猜 latest。 */
async function resolveActiveErrandOrderRows(
  tx: Prisma.TransactionClient,
  errandTaskId: string,
): Promise<LockedActiveOrderRow[]> {
  return tx.$queryRaw<LockedActiveOrderRow[]>`
    SELECT id, status, "buyerId", "sellerId"
    FROM "Order"
    WHERE type = 'ERRAND'
      AND "errandTaskId" = ${errandTaskId}
      AND status IN ('ACCEPTED', 'IN_PROGRESS')
    FOR UPDATE
  `;
}

/** active order 必须属于该任务的双参与方（§17：buyer=publisher / seller=accepter）。 */
function isOwnedByParticipants(
  order: LockedActiveOrderRow,
  errand: { publisherId: string; accepterId: string | null },
): boolean {
  return (
    order.buyerId === errand.publisherId &&
    errand.accepterId !== null &&
    order.sellerId === errand.accepterId
  );
}

function getErrandStatusLabel(
  status: "OPEN" | "CLAIMED" | "IN_PROGRESS" | "PENDING_CONFIRMATION" | "COMPLETED" | "CANCELLED",
) {
  switch (status) {
    case "OPEN":
      return "待接单";
    case "CLAIMED":
      return "已接单";
    case "IN_PROGRESS":
      return "进行中";
    case "PENDING_CONFIRMATION":
      return "待确认完成";
    case "COMPLETED":
      return "已完成";
    case "CANCELLED":
      return "已取消";
  }
}

/** canonical 通知（§30）：同一 transition 无论来自详情页还是订单中心，
 * 通知集合完全一致；由唯一实现产生，禁止入口各自组装。DISPUTED 属 dispute
 * 域 authority，不经本 lifecycle 产生通知。 */
async function notifyErrandStatusChange(
  tx: Prisma.TransactionClient,
  input: {
    publisherId: string;
    accepterId: string;
    orderId: string;
    status: "OPEN" | "IN_PROGRESS" | "PENDING_CONFIRMATION" | "CANCELLED";
  },
): Promise<void> {
  const statusLabel = getErrandStatusLabel(input.status);

  await createNotifications(tx, [
    {
      userId: input.publisherId,
      orderId: input.orderId,
      type: "ORDER",
      title: `跑腿任务状态更新：${statusLabel}`,
      content: `当前跑腿任务状态已更新为“${statusLabel}”，请前往订单中心查看。`,
    },
    {
      userId: input.accepterId,
      orderId: input.orderId,
      type: "ORDER",
      title: `跑腿任务状态更新：${statusLabel}`,
      content: `当前跑腿任务状态已更新为“${statusLabel}”，请前往订单中心查看。`,
    },
  ]);
}

/** CLAIMED → IN_PROGRESS 的 pair 写入（Task + Order 同事务，§22）：
 * 条件 updateMany 保留为最终谓词安全带（行锁下恒真）；Order 侧落空属于
 * 数据异常防御分支，抛错整体回滚，禁止留下半程状态。 */
async function applyErrandStartWrites(
  tx: Prisma.TransactionClient,
  errand: { id: string },
  order: { id: string },
): Promise<void> {
  const startResult = await tx.errandTask.updateMany({
    where: { id: errand.id, status: "CLAIMED" },
    data: { status: "IN_PROGRESS" },
  });

  if (startResult.count === 0) {
    throw new Error("ERRAND_START_CONFLICT");
  }

  const orderResult = await tx.order.updateMany({
    where: { id: order.id, status: "ACCEPTED" },
    data: { status: "IN_PROGRESS" },
  });

  if (orderResult.count === 0) {
    throw new Error("ERRAND_START_CONFLICT");
  }
}

/**
 * 跑腿详情页状态 transition 的唯一权威实现（updateErrandStatusTx 同一实现）。
 *
 * 返回 false = 无真实 transition（任务缺失/软删除/candidate 参与者失配/
 * 角色不符/fresh 状态不符/active order 缺失或多余/capability 之外的任何
 * 谓词失败）——零写入零通知。AUTH_ACCOUNT_INACTIVE / MARKETPLACE_RESTRICTED
 * 等能力错误按既有 taxonomy 抛出。
 */
export async function transitionErrandTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  errandId: string,
  requestedStatus: ErrandTaskStatus,
  seams?: ErrandLifecycleSeams,
): Promise<boolean> {
  // 无任何入口允许把任务写回 CLAIMED（claim 之外的路径一律拒绝）
  if (requestedStatus === "CLAIMED") {
    return false;
  }

  // ---- candidate 发现（仅锁键用途；authority 在锁后 fresh row）----
  const candidate = await discoverErrandCandidate(tx, errandId);
  if (!candidate) {
    return false;
  }

  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  // ---- 一次性取得完整 participant USER 锁集（禁止 actor 锁后追加）----
  await acquireGovernanceSubjectLocks(tx, errandParticipantSubjects(candidate));

  // 仅 actor 要求 ACTIVE account mutation contract（checks-only，锁已持有）
  await assertActiveAccountMutationAllowed(tx, actorUserId);

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  // ---- ErrandTask 行权威 + candidate 参与者复核（失配 fail closed）----
  const errand = await lockErrandTaskRow(tx, errandId);
  if (!errand || errand.deletedAt !== null) {
    return false;
  }
  if (errand.publisherId !== candidate.publisherId || errand.accepterId !== candidate.accepterId) {
    return false;
  }

  if (seams?.afterErrandRowLock) {
    await seams.afterErrandRowLock(tx);
  }

  // ---- 既有 transition table（fresh 重算，不扩大状态机）----
  const isPublisher = errand.publisherId === actorUserId;
  const isAccepter = errand.accepterId === actorUserId;

  const canTransition =
    (requestedStatus === "OPEN" && isPublisher && errand.status === "CLAIMED") ||
    (requestedStatus === "IN_PROGRESS" && isAccepter && errand.status === "CLAIMED") ||
    (requestedStatus === "PENDING_CONFIRMATION" &&
      isAccepter &&
      errand.status === "IN_PROGRESS") ||
    (requestedStatus === "COMPLETED" &&
      isPublisher &&
      errand.status === "PENDING_CONFIRMATION") ||
    (requestedStatus === "CANCELLED" && isPublisher && errand.status === "OPEN");

  if (!canTransition) {
    return false;
  }

  // ---- active order 解析（§18）：唯一 active obligation 权威 ----
  const activeOrders = await resolveActiveErrandOrderRows(tx, errand.id);

  // CLAIMED → OPEN：重新暴露为可接单（EXPOSURE_INCREASING）
  if (requestedStatus === "OPEN") {
    await requireMarketplaceCapability(
      tx,
      actorUserId,
      errand.campusId,
      "START_NEW_MARKETPLACE_ACTIVITY",
    );

    // canonical pair：CLAIMED ↔ Order ACCEPTED；0 / >1 / 失配 → fail closed
    if (
      activeOrders.length !== 1 ||
      activeOrders[0]!.status !== "ACCEPTED" ||
      !isOwnedByParticipants(activeOrders[0]!, errand)
    ) {
      return false;
    }
    const order = activeOrders[0]!;

    if (seams?.afterOrderRowLock) {
      await seams.afterOrderRowLock(tx);
    }

    const reopenResult = await tx.errandTask.updateMany({
      where: { id: errand.id, status: "CLAIMED" },
      data: { status: "OPEN", accepterId: null },
    });

    if (reopenResult.count === 0) {
      return false;
    }

    // CLAIMED → OPEN 对应 active Order：ACCEPTED → CANCELLED（§21）
    const cancelResult = await tx.order.updateMany({
      where: { id: order.id, status: "ACCEPTED" },
      data: { status: "CANCELLED", cancelReason: "发布者撤销接单" },
    });

    if (cancelResult.count === 0) {
      throw new Error("ERRAND_REOPEN_CONFLICT");
    }

    await notifyErrandStatusChange(tx, {
      publisherId: errand.publisherId,
      accepterId: order.sellerId,
      orderId: order.id,
      status: "OPEN",
    });

    return true;
  }

  // CLAIMED → IN_PROGRESS：accepter 开始履约（Task + Order 同事务）
  if (requestedStatus === "IN_PROGRESS") {
    if (
      activeOrders.length !== 1 ||
      activeOrders[0]!.status !== "ACCEPTED" ||
      !isOwnedByParticipants(activeOrders[0]!, errand)
    ) {
      return false;
    }
    const order = activeOrders[0]!;

    if (seams?.afterOrderRowLock) {
      await seams.afterOrderRowLock(tx);
    }

    await applyErrandStartWrites(tx, errand, order);

    await notifyErrandStatusChange(tx, {
      publisherId: errand.publisherId,
      accepterId: order.sellerId,
      orderId: order.id,
      status: "IN_PROGRESS",
    });

    return true;
  }

  // IN_PROGRESS → PENDING_CONFIRMATION：accepter 提交完成（Order 保持 IN_PROGRESS）
  if (requestedStatus === "PENDING_CONFIRMATION") {
    if (
      activeOrders.length !== 1 ||
      activeOrders[0]!.status !== "IN_PROGRESS" ||
      !isOwnedByParticipants(activeOrders[0]!, errand)
    ) {
      return false;
    }
    const order = activeOrders[0]!;

    if (seams?.afterOrderRowLock) {
      await seams.afterOrderRowLock(tx);
    }

    const submitResult = await tx.errandTask.updateMany({
      where: { id: errand.id, status: "IN_PROGRESS" },
      data: { status: "PENDING_CONFIRMATION" },
    });

    if (submitResult.count === 0) {
      return false;
    }

    await notifyErrandStatusChange(tx, {
      publisherId: errand.publisherId,
      accepterId: order.sellerId,
      orderId: order.id,
      status: "PENDING_CONFIRMATION",
    });

    return true;
  }

  // PENDING_CONFIRMATION → COMPLETED：publisher 确认完成；exactly-once
  // 终局副作用（计数/通知/completedAt）仍由唯一 completeErrandOrderTx 承担
  if (requestedStatus === "COMPLETED") {
    if (
      activeOrders.length !== 1 ||
      activeOrders[0]!.status !== "IN_PROGRESS" ||
      !isOwnedByParticipants(activeOrders[0]!, errand)
    ) {
      return false;
    }
    const order = activeOrders[0]!;

    if (seams?.afterOrderRowLock) {
      await seams.afterOrderRowLock(tx);
    }

    const completion = await completeErrandOrderTx(tx, {
      orderId: order.id,
      errandTaskId: errand.id,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
    });

    return completion.completed;
  }

  // OPEN → CANCELLED：canonical pair 要求不存在 active order（§25）
  if (activeOrders.length > 0) {
    return false;
  }

  if (seams?.afterOrderRowLock) {
    await seams.afterOrderRowLock(tx);
  }

  const cancelResult = await tx.errandTask.updateMany({
    where: { id: errand.id, status: "OPEN" },
    data: { status: "CANCELLED" },
  });

  if (cancelResult.count === 0) {
    return false;
  }

  // 通知挂载点仅为历史订单（最新一条；非业务权威）——从未被接单的任务无
  // 通知（Notification.orderId 可空，但既有行为为零通知，保持不变）
  const historicalOrder = await tx.order.findFirst({
    where: { errandTaskId: errand.id, type: "ERRAND" },
    orderBy: { createdAt: "desc" },
    select: { id: true, sellerId: true },
  });

  if (historicalOrder) {
    await notifyErrandStatusChange(tx, {
      publisherId: errand.publisherId,
      accepterId: historicalOrder.sellerId,
      orderId: historicalOrder.id,
      status: "CANCELLED",
    });
  }

  return true;
}

/** 订单中心委派用 candidate（§26）：锁键 + fresh 复核基准，非状态权威。 */
export type ErrandOrderTransitionCandidate = {
  errandTaskId: string;
  buyerId: string;
  sellerId: string;
};

/**
 * 订单中心（updateOrderStatusTx）对 ERRAND IN_PROGRESS / COMPLETED 的唯一
 * 委派入口（§26/§27）：与详情页共享同一 canonical authority——同一套
 * participant locks、同一 fresh Task/Order 角色权威、同一通知集合。
 *
 * 返回 null = 无真实 transition（零写入零通知）；成功返回 { isBuyer }。
 */
export async function transitionErrandOrderTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  orderId: string,
  candidate: ErrandOrderTransitionCandidate,
  requestedStatus: "IN_PROGRESS" | "COMPLETED",
  seams?: ErrandLifecycleSeams,
): Promise<{ isBuyer: boolean } | null> {
  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  // 锁集取自 order candidate（ERRAND order buyer=publisher / seller=accepter）；
  // 一次性完整取得，禁止 actor 锁后追加
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.buyerId },
    { subjectType: "USER", subjectId: candidate.sellerId },
  ]);

  await assertActiveAccountMutationAllowed(tx, actorUserId);

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  // ---- ErrandTask 行权威；order candidate 参与者必须与任务参与者一致 ----
  const errand = await lockErrandTaskRow(tx, candidate.errandTaskId);
  if (!errand || errand.deletedAt !== null) {
    return null;
  }
  if (errand.publisherId !== candidate.buyerId || errand.accepterId !== candidate.sellerId) {
    return null;
  }

  if (seams?.afterErrandRowLock) {
    await seams.afterErrandRowLock(tx);
  }

  const isBuyer = errand.publisherId === actorUserId;
  const isAccepter = errand.accepterId === actorUserId;

  // 仅两个委派 transition；ERRAND 其余状态流转不属于订单中心权限
  const canTransition =
    (requestedStatus === "IN_PROGRESS" && isAccepter && errand.status === "CLAIMED") ||
    (requestedStatus === "COMPLETED" && isBuyer && errand.status === "PENDING_CONFIRMATION");

  if (!canTransition) {
    return null;
  }

  const activeOrders = await resolveActiveErrandOrderRows(tx, errand.id);

  // §18：恰 1 个 active order，且必须就是请求进入的这张 order
  if (
    activeOrders.length !== 1 ||
    activeOrders[0]!.id !== orderId ||
    !isOwnedByParticipants(activeOrders[0]!, errand)
  ) {
    return null;
  }
  const order = activeOrders[0]!;

  if (seams?.afterOrderRowLock) {
    await seams.afterOrderRowLock(tx);
  }

  if (requestedStatus === "IN_PROGRESS") {
    // canonical pair：CLAIMED ↔ Order ACCEPTED
    if (order.status !== "ACCEPTED") {
      return null;
    }

    await applyErrandStartWrites(tx, errand, order);

    await notifyErrandStatusChange(tx, {
      publisherId: errand.publisherId,
      accepterId: order.sellerId,
      orderId: order.id,
      status: "IN_PROGRESS",
    });

    return { isBuyer };
  }

  // COMPLETED：canonical pair（PENDING_CONFIRMATION ↔ Order IN_PROGRESS），
  // exactly-once 终局副作用仍由唯一 completeErrandOrderTx 承担
  if (order.status !== "IN_PROGRESS") {
    return null;
  }

  const completion = await completeErrandOrderTx(tx, {
    orderId: order.id,
    errandTaskId: errand.id,
    buyerId: order.buyerId,
    sellerId: order.sellerId,
  });

  if (!completion.completed) {
    return null;
  }

  return { isBuyer };
}

export type ErrandContentUpdateInput = {
  title: string;
  description: string;
  categoryId: string;
  reward: Prisma.Decimal;
  pickupLocation: string;
  deliveryLocation: string;
  deadline: Date;
  contactNote: string | null;
  needsAdvancePay: boolean;
  advanceAmount: Prisma.Decimal | null;
};

export type ErrandContentUpdateOutcome = "UPDATED" | "MISSING" | "NOT_OPEN";

/**
 * 编辑跑腿任务内容的唯一权威实现（§32-§34）：关闭 stale OPEN snapshot——
 * 事务外 pre-read 只能 discovery，最终写权威 = USER:publisher 锁 +
 * ErrandTask FOR UPDATE fresh 谓词（publisherId == actor / deletedAt null /
 * status == OPEN / accepterId null）。
 *
 * claim 先提交时 fresh row 已是 CLAIMED → NOT_OPEN（NO WRITE，零内容变更）。
 * MISSING 覆盖缺失 / 软删除 / 非发布者（同形，不泄漏存在性）。
 */
export async function updateErrandContentTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  errandId: string,
  content: ErrandContentUpdateInput,
  seams?: ErrandLifecycleSeams,
): Promise<ErrandContentUpdateOutcome> {
  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  // OPEN 编辑只需 USER:publisher（§13）：claimErrandTx 共享 publisher 锁，
  // edit vs claim 线性化
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: actorUserId },
  ]);

  await assertActiveAccountMutationAllowed(tx, actorUserId);

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  const errand = await lockErrandTaskRow(tx, errandId);
  if (!errand || errand.deletedAt !== null || errand.publisherId !== actorUserId) {
    return "MISSING";
  }

  // fresh OPEN 权威（§34）：edit-after-claim 在此被拒，绝不返回成功
  if (errand.status !== "OPEN" || errand.accepterId !== null) {
    return "NOT_OPEN";
  }

  // §19：OPEN + active order = 数据异常，编辑不得扩大异常 → fail closed
  const activeOrders = await resolveActiveErrandOrderRows(tx, errand.id);
  if (activeOrders.length > 0) {
    return "NOT_OPEN";
  }

  if (seams?.afterOrderRowLock) {
    await seams.afterOrderRowLock(tx);
  }

  // §33：锁已持有 → checks-only capability（单一锁权威，不再二次建锁）
  await requireMarketplaceCapability(
    tx,
    actorUserId,
    errand.campusId,
    "MODIFY_PUBLIC_LISTING_CONTENT",
  );

  await tx.errandTask.update({
    where: { id: errand.id },
    data: {
      title: content.title,
      description: content.description,
      categoryId: content.categoryId,
      reward: content.reward,
      pickupLocation: content.pickupLocation,
      deliveryLocation: content.deliveryLocation,
      deadline: content.deadline,
      contactNote: content.contactNote,
      needsAdvancePay: content.needsAdvancePay,
      advanceAmount: content.advanceAmount,
    },
  });

  return "UPDATED";
}

export type ErrandDeleteOutcome =
  | "DELETED"
  | "MISSING"
  | "NOT_DELETABLE"
  | "ANOMALOUS_ACTIVE_ORDER";

/**
 * 删除跑腿任务的唯一权威实现（§35-§37）：替换"事务外 status check → 裸
 * prisma.errandTask.update"。事务内 USER 锁 → ErrandTask FOR UPDATE →
 * fresh ownership/deletedAt/status → active-order invariant → delete。
 *
 * 业务合同保持：仅 OPEN / CANCELLED 允许删除；Task OPEN/CANCELLED 但仍存
 * 在 active ERRAND order 属异常状态 → fail closed NO-OP，不得留下
 * deleted task + ACCEPTED/IN_PROGRESS order。
 */
export async function deleteErrandTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  errandId: string,
  seams?: ErrandLifecycleSeams,
): Promise<ErrandDeleteOutcome> {
  const candidate = await discoverErrandCandidate(tx, errandId);
  if (!candidate) {
    return "MISSING";
  }

  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await acquireGovernanceSubjectLocks(tx, errandParticipantSubjects(candidate));

  await assertActiveAccountMutationAllowed(tx, actorUserId);

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  const errand = await lockErrandTaskRow(tx, errandId);
  if (
    !errand ||
    errand.deletedAt !== null ||
    errand.publisherId !== actorUserId
  ) {
    return "MISSING";
  }

  // fresh 状态权威（§36）：仅 OPEN / CANCELLED 允许删除——claim 先提交时
  // 在此被拒（§38 方向 B 的 NO-OP）
  if (errand.status !== "OPEN" && errand.status !== "CANCELLED") {
    return "NOT_DELETABLE";
  }
  if (errand.status === "OPEN" && errand.accepterId !== null) {
    return "NOT_DELETABLE";
  }

  // candidate 参与者一致性（§16 fail closed）：发现读与锁内 fresh 的参与者
  // 集合必须一致，锁集才完整覆盖真实参与方
  if (
    errand.publisherId !== candidate.publisherId ||
    errand.accepterId !== candidate.accepterId
  ) {
    return "MISSING";
  }

  // §37：OPEN/CANCELLED + active order = 数据异常 → fail closed（零写入）
  const activeOrders = await resolveActiveErrandOrderRows(tx, errand.id);
  if (activeOrders.length > 0) {
    return "ANOMALOUS_ACTIVE_ORDER";
  }

  if (seams?.afterOrderRowLock) {
    await seams.afterOrderRowLock(tx);
  }

  await tx.errandTask.update({
    where: { id: errand.id },
    data: {
      deletedAt: new Date(),
      status: "CANCELLED",
      accepterId: null,
    },
  });

  return "DELETED";
}
