import { type ErrandTaskStatus, Prisma } from "@prisma/client";

import { requireMarketplaceCapability } from "@/lib/enforcement/capability-gate";
import { completeErrandOrderTx } from "@/lib/errand-completion";
import {
  assertActiveAccountMutationAllowed,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { emitNotificationsTx } from "@/lib/notifications/notification-service";
import { ERRAND_TASK_STATUS_CHANGED_KIND } from "@/lib/notifications/notification-registry";

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

/**
 * 占用 active obligation 的 ERRAND Order 状态（COMPLETED/CANCELLED/REFUNDED/
 * CLOSED 不属于）。
 *
 * Review Repair RB04（§26）：active/blocking 集合收敛到系统级 Order 语义
 * —— PENDING / ACCEPTED / IN_PROGRESS / IN_DISPUTE 均属未关闭义务
 * （与 account-erasure 的 ACTIVE_ORDER_STATUSES、Service 域
 * ACTIVE_SERVICE_ORDER_STATUSES 同一口径；8C：IN_DISPUTE 仍是治理冻结中的
 * active obligation）。正常 canonical 流程不会产生 OPEN task + PENDING /
 * IN_DISPUTE ERRAND Order 的 pair——但这正是 structural fail-closed 的意义：
 * 出现历史/异常行时 expiry 与 lifecycle 必须 STRUCTURAL_INVALID / 拒绝，
 * 绝不猜测性 CANCELLED（INV-16）。本常量是唯一 SSOT，
 * resolveActiveErrandOrderRows 的 SQL 由它参数化，禁止第二套 in-list。
 */
export const ACTIVE_ERRAND_ORDER_STATUSES: readonly [
  "PENDING",
  "ACCEPTED",
  "IN_PROGRESS",
  "IN_DISPUTE",
] = ["PENDING", "ACCEPTED", "IN_PROGRESS", "IN_DISPUTE"];

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
  deadline: Date;
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
 * accepterId/status/campusId。Phase 9C-02：deadline 一并读取——expired
 * 判定（edit revival guard / CLAIMED→OPEN reopen guard / canonical expiry）
 * 全部以锁内 fresh deadline 为唯一权威。 */
async function lockErrandTaskRow(
  tx: Prisma.TransactionClient,
  errandId: string,
): Promise<LockedErrandRow | null> {
  const rows = await tx.$queryRaw<LockedErrandRow[]>`
    SELECT id, "campusId", status, "publisherId", "accepterId", "deadline", "deletedAt"
    FROM "ErrandTask"
    WHERE id = ${errandId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** active ERRAND Order 解析（§17/§18）：type=ERRAND + errandTaskId 命中 +
 * status ∈ ACTIVE_ERRAND_ORDER_STATUSES（SSOT 参数化，Review Repair RB04：
 * PENDING / IN_DISPUTE 一并计入 blocking obligation），逐行 FOR UPDATE。
 * 返回全部匹配行——调用方按状态要求恰好 0 / 1 个，绝不按 createdAt 猜
 * latest。 */
async function resolveActiveErrandOrderRows(
  tx: Prisma.TransactionClient,
  errandTaskId: string,
): Promise<LockedActiveOrderRow[]> {
  return tx.$queryRaw<LockedActiveOrderRow[]>`
    SELECT id, status, "buyerId", "sellerId"
    FROM "Order"
    WHERE type = 'ERRAND'
      AND "errandTaskId" = ${errandTaskId}
      AND status::text IN (${Prisma.join(ACTIVE_ERRAND_ORDER_STATUSES)})
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
  // Phase 9B：canonical notification domain（label 由 registry 渲染）
  await emitNotificationsTx(tx, [
    {
      kind: ERRAND_TASK_STATUS_CHANGED_KIND,
      recipientUserId: input.publisherId,
      orderId: input.orderId,
      dedupeKey: `${ERRAND_TASK_STATUS_CHANGED_KIND}:${input.orderId}:${input.status}:${input.publisherId}`,
      payload: { orderId: input.orderId, status: input.status },
    },
    {
      kind: ERRAND_TASK_STATUS_CHANGED_KIND,
      recipientUserId: input.accepterId,
      orderId: input.orderId,
      dedupeKey: `${ERRAND_TASK_STATUS_CHANGED_KIND}:${input.orderId}:${input.status}:${input.accepterId}`,
      payload: { orderId: input.orderId, status: input.status },
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
  /** Review Repair RB02：authoritative decision time override（仅测试；生产不传；
   * 在生产捕获 new Date() 的同一逻辑位置——USER 锁 + ErrandTask 行锁之后的
   * reopen 分支内——消费）。 */
  options?: { now?: Date },
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
    // Phase 9C-02（§5.2 reopen guard）：重新曝光增加公开面——deadline 已过
    // 的 CLAIMED 任务不得撤销接单后重新暴露为 OPEN（fresh 锁内判定，不信任
    // 事务外 snapshot）。仅拒绝 reopen：既有 CLAIMED obligation 原样保留
    //（deadline 不自动终止履约义务，§2.1），Task/Order 零写入零通知。
    const reopenNow = options?.now ?? new Date();
    if (
      !(errand.deadline instanceof Date) ||
      errand.deadline.getTime() <= reopenNow.getTime()
    ) {
      return false;
    }

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

export type ErrandContentUpdateOutcome =
  | "UPDATED"
  | "MISSING"
  | "NOT_OPEN"
  | "DEADLINE_EXPIRED";

/**
 * 编辑跑腿任务内容的唯一权威实现（§32-§34）：关闭 stale OPEN snapshot——
 * 事务外 pre-read 只能 discovery，最终写权威 = USER:publisher 锁 +
 * ErrandTask FOR UPDATE fresh 谓词（publisherId == actor / deletedAt null /
 * status == OPEN / accepterId null）。
 *
 * claim 先提交时 fresh row 已是 CLAIMED → NOT_OPEN（NO WRITE，零内容变更）。
 * MISSING 覆盖缺失 / 软删除 / 非发布者（同形，不泄漏存在性）。
 *
 * Phase 9C-02（§5.1 revival guard）：OPEN 且当前 deadline 已过的任务禁止
 * 编辑（含把 deadline 延长到未来）——即使 row 尚未被 scheduler materialize
 * 成 CANCELLED，edit 也不得复活已过期任务 → DEADLINE_EXPIRED（零写入）。
 * 事务外 deadline 校验只用于 UX；authority 在锁内 fresh row 上。
 *
 * Review Repair RB02（§9/§10）：deadline 判定的 authoritativeNow 必须捕获
 * 于 serialization authority（USER 锁 + ErrandTask FOR UPDATE）之后——
 * 请求/事务开始时刻 ≠ 获得 authority 时刻（锁等待期间真实时间可能跨越
 * deadline 边界，旧 now 会复活已到期任务）。options?.now seam 语义冻结为
 * "authoritative decision time override"（测试注入），在生产捕获 new Date()
 * 的同一逻辑位置消费；生产不传。
 */
export async function updateErrandContentTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  errandId: string,
  content: ErrandContentUpdateInput,
  seams?: ErrandLifecycleSeams,
  /** Review Repair RB02：authoritative decision time override（仅测试；生产不传）。 */
  options?: { now?: Date },
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

  // Review Repair RB02：authoritativeNow 捕获于 row authority 之后（锁等待
  // 期间真实时间可能跨越 deadline；§9 时间 authority 冻结）
  const now = options?.now ?? new Date();

  // fresh OPEN 权威（§34）：edit-after-claim 在此被拒，绝不返回成功
  if (errand.status !== "OPEN" || errand.accepterId !== null) {
    return "NOT_OPEN";
  }

  // §19：OPEN + active order = 数据异常，编辑不得扩大异常 → fail closed
  const activeOrders = await resolveActiveErrandOrderRows(tx, errand.id);
  if (activeOrders.length > 0) {
    return "NOT_OPEN";
  }

  // Phase 9C-02 revival guard：当前 deadline 已过（或 corrupt 缺失）→ 拒绝；
  // 请求的 deadline 也不再接受过去时刻（deadline truth > late user intent）
  if (
    !(errand.deadline instanceof Date) ||
    errand.deadline.getTime() <= now.getTime() ||
    content.deadline.getTime() <= now.getTime()
  ) {
    return "DEADLINE_EXPIRED";
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

// ============================================================
// Phase 9C-02（§14/§15/§16）：Errand deadline 到期的 canonical expiry
// authority（scheduled materialization 的唯一业务入口）。
//
// 与 claim / edit / reopen 的 deadline 判定同一 SSOT：deadline 是"允许该
// OPEN 任务继续公开曝光并接受新接单"的截止时刻（§2.1）；到期 materialize
// 结果 = OPEN → CANCELLED（不新增 EXPIRED enum，§3；不为用户取消与系统
// 到期增加 cancellation reason 字段）。
//
// 权威锁序（与 updateErrandContentTx / claimErrandTx 兼容，无环）：
//   candidate discover publisherId（仅锁键，非权威）
//   → USER:publisher governance subject lock
//   → ErrandTask FOR UPDATE（fresh 谓词权威）
//   → active ERRAND Order FOR UPDATE（OPEN + active order = 结构异常）
//   → writes
//
// expiry 是 system lifecycle materialization：无 user actor——不做
// assertActiveAccountMutationAllowed / capability 检查，任何参与方账号
// 状态都不得阻止系统 wind-down（与 expireProductReservationTx 同一语义）。
// OPEN 任务 accepter 必为 null，publisher 单锁即与 claim（publisher+
// claimer 排序锁）线性化：claim 先提交 → fresh 非 OPEN → NOT_OPEN；
// expiry 先提交 → claim fresh 非 OPEN → DENY。deadline 不自动终止既有
// 履约义务（CLAIMED/IN_PROGRESS 等 workflow 不受影响，§2.1/INV-07）。
// ============================================================

export type ErrandDeadlineExpiryOutcome =
  | { kind: "EXPIRED" }
  | { kind: "NOT_DUE"; deadline: Date }
  | { kind: "NOT_OPEN" }
  | { kind: "MISSING" }
  | { kind: "STRUCTURAL_INVALID" };

/**
 * Errand deadline 到期 materialize 的唯一权威实现（§14/§15/§16）。
 *
 * 返回语义（handler 映射见 async/handlers/errand-deadline-expire.ts）：
 *   EXPIRED            fresh OPEN + accepterId null + deadline <= now +
 *                      无 active ERRAND order → CANCELLED
 *   NOT_DUE            discovery 与锁之间 publisher 合法 edit 延长了
 *                      deadline（fresh deadline > now）→ 返回权威新
 *                      deadline（one-shot intent 的 stale-schedule 防御）
 *   NOT_OPEN           其他合法 lifecycle 已先赢（CLAIMED/CANCELLED/...）
 *                      → 幂等 no-op
 *   MISSING            实体不存在 / 软删除 / 锁内 publisherId 漂移
 *                      → 幂等 no-op
 *   STRUCTURAL_INVALID OPEN 却有 accepter / OPEN 却存在 active ERRAND
 *                      order / deadline 字段缺失 → fail closed，绝不猜测
 *                      修复（handler → PERMANENT → DEAD_LETTER）
 */
export async function expireErrandDeadlineTx(
  tx: Prisma.TransactionClient,
  errandId: string,
  seams?: Pick<ErrandLifecycleSeams, "beforeLock" | "afterErrandRowLock">,
  /** Review Repair RB02：authoritative decision time override（仅测试；生产不传；
   * 在生产捕获 new Date() 的同一逻辑位置——publisher 锁 + ErrandTask 行锁
   * 之后的 fresh 谓词处——消费）。 */
  options?: { now?: Date },
): Promise<ErrandDeadlineExpiryOutcome> {
  // candidate pre-read：仅锁键发现（publisherId），不信任 status/deadline
  const candidate = await discoverErrandCandidate(tx, errandId);
  if (!candidate) {
    return { kind: "MISSING" };
  }

  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  // OPEN 任务 participant = publisher 单锁（§15）：与 claim / edit / cancel
  // 共享 publisher 锁域；软删 candidate 已被 discovery 排除
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.publisherId },
  ]);

  // 刻意不做 assertActiveAccountMutationAllowed：expiry 无 user actor

  const errand = await lockErrandTaskRow(tx, errandId);
  if (!errand || errand.deletedAt !== null) {
    return { kind: "MISSING" };
  }
  // publisherId 未变化（§15）：锁键失效属 identity drift → 幂等 no-op
  if (errand.publisherId !== candidate.publisherId) {
    return { kind: "MISSING" };
  }

  if (seams?.afterErrandRowLock) {
    await seams.afterErrandRowLock(tx);
  }

  // fresh 状态权威（§16）：非 OPEN = 其他合法 lifecycle 已先赢
  if (errand.status !== "OPEN") {
    return { kind: "NOT_OPEN" };
  }

  // 结构异常 fail closed：OPEN + accepter 非 null / OPEN 无 deadline
  // （DB NOT NULL 合同下不可能）→ 绝不猜测修复
  if (errand.accepterId !== null || !(errand.deadline instanceof Date)) {
    return { kind: "STRUCTURAL_INVALID" };
  }

  // deadline 判定（§19：单一 authoritativeNow）
  const now = options?.now ?? new Date();
  if (errand.deadline.getTime() > now.getTime()) {
    // discovery 与锁之间 publisher 合法 edit 延长了 deadline → 返回权威新
    // deadline（handler RESCHEDULE 到该时刻；不是 recurrence）
    return { kind: "NOT_DUE", deadline: errand.deadline };
  }

  // OPEN 却存在 active ERRAND order = 数据异常（§16）：fail closed
  const activeOrders = await resolveActiveErrandOrderRows(tx, errand.id);
  if (activeOrders.length > 0) {
    return { kind: "STRUCTURAL_INVALID" };
  }

  // 条件 update 保留为最终谓词安全带（行锁下恒真；并发 winner 仅一路成功）
  const cancelResult = await tx.errandTask.updateMany({
    where: { id: errand.id, status: "OPEN" },
    data: { status: "CANCELLED" },
  });

  if (cancelResult.count === 0) {
    // 并发 lifecycle winner（claim / cancel / delete）在安全带处先赢
    return { kind: "NOT_OPEN" };
  }

  return { kind: "EXPIRED" };
}
