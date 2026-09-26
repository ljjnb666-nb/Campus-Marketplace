import { Prisma, type DepositStatus, type RentalCancellationReason, type RentalOrderStatus, type RentalPricingUnit } from "@prisma/client";
import { marketplaceObligationValidator } from "@/lib/enforcement/capability-gate";
import {
  DATA_HOLD_SOURCE_TYPE_RENTAL_DISPUTE,
  DISPUTE_HOLD_REASON_CODE,
  createHoldTxLocked,
} from "@/lib/privacy/data-hold-service";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { hasActiveListingModeration } from "@/lib/moderation/listing-moderation-query";
import type { ListingModerationRacePoint } from "@/lib/order-creation";
import { createNotifications } from "@/repositories/notification-repository";
import { computeDisputeDueAt } from "@/lib/disputes/dispute-sla";
import {
  DISPUTE_ACTIVE_STATUSES,
  disputeCampusScopeKey,
} from "@/lib/disputes/dispute-scope";
import { calculateRentalAmount, calculateRentalDuration, createRentalOrderNo } from "@/lib/rental-price";
import {
  assertActiveAccountMutationAllowed,
  prepareActiveAccountMutation,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { checkTimeConflict } from "@/repositories/rental-order-repository";
import { withObligationGuard, type ObligationRacePoint } from "@/lib/governance/obligation-guard";

/**
 * 租赁订单状态机：从 server action 中抽出的领域逻辑。
 * 全部函数只依赖传入的事务客户端（Prisma.TransactionClient），
 * 不包含 "use server" / revalidatePath / FormData，可直接用 mock 的事务客户端做单元测试。
 */

// 事务内的业务失败统一以 { error } 返回，由 action 层转换为用户提示文案
export type RentalOrderTxError = { error: string };

type RentalRole = "owner" | "renter";

type RentalOrderParty = { ownerId: string; renterId: string };

/** 写入订单状态流转日志 */
export async function writeStatusLog(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    fromStatus: RentalOrderStatus | null;
    toStatus: RentalOrderStatus;
    operatorId: string;
    note: string;
  },
) {
  await tx.rentalOrderStatusLog.create({
    data: {
      orderId: input.orderId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      operatorId: input.operatorId,
      note: input.note,
    },
  });
}

/** role 已通过 zod 枚举校验，这里核对当前用户确实是该角色的当事人 */
export function isRentalOrderRoleParticipant(order: RentalOrderParty, role: RentalRole, userId: string): boolean {
  if (role === "owner") return order.ownerId === userId;
  return order.renterId === userId;
}

/** 订单是否允许当前用户取消（待出租者确认时仅租客可取消，待取货时双方均可） */
export function canCancelRentalOrder(order: { status: RentalOrderStatus } & RentalOrderParty, userId: string): boolean {
  if (order.status === "PENDING_APPROVAL" && order.renterId === userId) return true;
  if (order.status === "PENDING_PICKUP" && (order.ownerId === userId || order.renterId === userId)) return true;
  return false;
}

/** 可发起纠纷的订单状态 */
const DISPUTABLE_STATUSES: readonly RentalOrderStatus[] = [
  "IN_RENTAL",
  "PENDING_RETURN",
  "PENDING_INSPECTION",
  "COMPLETED",
  "PICKED_UP",
];

export function isDisputableStatus(status: RentalOrderStatus): boolean {
  return DISPUTABLE_STATUSES.includes(status);
}

/** 相对方：出租者对应租客、租客对应出租者 */
export function counterpartyId(order: RentalOrderParty, userId: string): string {
  return order.ownerId === userId ? order.renterId : order.ownerId;
}

/** 完成订单后的押金状态：有押金进入待退回，无押金保持原状 */
export function depositStatusAfterCompletion(order: {
  depositAmount: Prisma.Decimal;
  depositStatus: DepositStatus;
}): DepositStatus {
  return order.depositAmount.gt(0) ? "PENDING_REFUND" : order.depositStatus;
}

/** 订单完成时给双方累加租赁参与计数 */
export async function incrementRentalCompletionCounters(tx: Prisma.TransactionClient, order: RentalOrderParty) {
  await tx.user.update({ where: { id: order.ownerId }, data: { rentalOwnerCount: { increment: 1 } } });
  await tx.user.update({ where: { id: order.renterId }, data: { rentalRenterCount: { increment: 1 } } });
}

/** 重算目标用户的租借好评率（0..1 的比率，好评 = overallRating >= 4） */
export async function recomputeRentalPositiveRate(tx: Prisma.TransactionClient, targetUserId: string) {
  const [totalReviews, positiveReviews] = await Promise.all([
    tx.rentalReview.count({ where: { targetUserId } }),
    tx.rentalReview.count({ where: { targetUserId, overallRating: { gte: 4 } } }),
  ]);
  await tx.user.update({
    where: { id: targetUserId },
    data: { rentalPositiveRate: totalReviews > 0 ? positiveReviews / totalReviews : 0 },
  });
}

export async function createRentalOrderTx(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    rentalListingId: string;
    startTime: Date;
    endTime: Date;
    quantity: number;
    renterNote?: string;
  },
  racePoint?: ObligationRacePoint,
  /** Phase 7C：listing 行锁 + 复查后、写入前的测试 seam（生产不传）。 */
  domainRacePoint?: ListingModerationRacePoint,
): Promise<RentalOrderTxError | { orderId: string }> {
  const { userId, startTime, endTime, quantity } = input;

  // ⚠️ 锁序契约（Phase 5 REPAIR 3，防死锁）：
  //   governance subject locks（renter + owner advisory）
  //   → business/domain row locks（RentalListing FOR UPDATE）
  //   → writes
  // eraseAccount(owner) 的顺序是 subject lock → RentalListing updateMany；
  // 若本函数先 FOR UPDATE 再取 subject lock，出租者注销与租赁创建并发会
  // 形成 row lock ↔ advisory lock 交叉等待（SQLSTATE 40P01）。
  // 因此：第一次只做普通只读查询发现 candidate ownerId（不加锁），
  // 取得 participant locks 后再 FOR UPDATE 并重验证同一行。

  // ---- 步骤 1：普通只读 pre-read（无锁），仅用于发现 candidate ownerId / campusId ----
  const candidates = await tx.$queryRaw<Array<{ id: string; ownerId: string; campusId: string }>>`
    SELECT id, "ownerId", "campusId"
    FROM "RentalListing"
    WHERE id = ${input.rentalListingId} AND "deletedAt" IS NULL AND status = 'AVAILABLE'
  `;
  const candidate = candidates[0];

  if (!candidate) return { error: '出租物品不存在或已下架' };
  if (candidate.ownerId === userId) return { error: '不能租用自己的物品' };

  // ---- 步骤 2/3：participant governance 锁 + 锁内校验（racePoint seam）----
  // Phase 6C-3：校验由 marketplaceObligationValidator 统一组装——renter 三门
  // 专用校验（403 族）+ 全参与方（renter+owner）资格校验（对手方失效统一
  // 409 MARKETPLACE_COUNTERPARTY_UNAVAILABLE，不区分哪一方/哪一维）。
  return withObligationGuard(
    tx,
    [userId, candidate.ownerId],
    marketplaceObligationValidator({
      initiatorId: userId,
      participantUserIds: [userId, candidate.ownerId],
      campusId: candidate.campusId,
    }),
    async () => {
      // ---- 步骤 4：取得 subject locks 后再 FOR UPDATE 同一行 ----
    // ⚠️ 维护注意：此处使用 $queryRaw + FOR UPDATE 绕过 Prisma 类型化查询以获取行锁。
    // 代价是字段列表、返回类型需与 prisma/schema.prisma 的 RentalListing 模型手动同步。
    // 如果 RentalListing 新增/重命名字段且此处遗漏，TypeScript 不会在编译期报错。
    // 修改 RentalListing schema 时请同步检查此处的 SELECT 列表。
    const listings = await tx.$queryRaw<Array<{
      id: string; ownerId: string; campusId: string; totalQuantity: number;
      minimumDuration: number; maximumDuration: number;
      price: unknown; pricingUnit: string; depositAmount: unknown;
      pickupLocation: string; returnLocation: string;
      requiresApproval: boolean; status: string; title: string; deletedAt: Date | null;
    }>>`
      SELECT id, "ownerId", "campusId", "totalQuantity", "minimumDuration", "maximumDuration",
             price, "pricingUnit", "depositAmount", "pickupLocation", "returnLocation",
             "requiresApproval", status, title, "deletedAt"
      FROM "RentalListing"
      WHERE id = ${candidate.id}
      FOR UPDATE
    `;
    const rawListing = listings[0];

    // ---- 步骤 5：行锁下重验证（不信任 pre-read snapshot，fail closed）----
    if (!rawListing || rawListing.deletedAt !== null) {
      return { error: '出租物品不存在或已下架' };
    }
    if (rawListing.status !== 'AVAILABLE') {
      return { error: '出租物品不存在或已下架' };
    }
    // ownerId 不变量断言：schema/domain 无 owner 转移路径，理论上不变；
    // 若出现 pre-read/locked 不一致，必须 fail closed（绝不能给错误的
    // owner 创建租赁义务）。
    if (rawListing.ownerId !== candidate.ownerId) {
      return { error: '出租物品状态已变化，请重试' };
    }
    // Phase 7C（R2-02）：campusId 同样以锁内现势行为准（pre-read 仅 discovery）。
    if (rawListing.campusId !== candidate.campusId) {
      return { error: '出租物品状态已变化，请重试' };
    }
    // Phase 7C：活跃治理 moderation → 新租赁义务拒绝（既有义务不受影响）
    if (await hasActiveListingModeration(tx, "RENTAL", rawListing.id)) {
      return { error: '出租物品当前不可预约' };
    }
    if (domainRacePoint) {
      await domainRacePoint(tx);
    }

    // ⚠️ $queryRaw 返回的 Decimal 列是原始类型（string/number），pricingUnit 是 string 而非枚举。
    // 需手动包装为 Prisma.Decimal 和 as RentalPricingUnit，绕开了 TypeScript 的类型保护。
    const listing = {
      ...rawListing,
      price: new Prisma.Decimal(String(rawListing.price)),
      depositAmount: new Prisma.Decimal(String(rawListing.depositAmount)),
    };

    if (quantity > listing.totalQuantity) return { error: '租赁数量超过可用库存' };

    const duration = calculateRentalDuration(listing.pricingUnit, startTime, endTime);
    if (duration < listing.minimumDuration) return { error: `最短租期为 ${listing.minimumDuration} 个计价单位` };
    if (duration > listing.maximumDuration) return { error: `最长租期为 ${listing.maximumDuration} 个计价单位` };

    const unavailable = await tx.rentalUnavailablePeriod.findFirst({
      where: {
        rentalListingId: listing.id,
        AND: [{ startDate: { lt: endTime } }, { endDate: { gt: startTime } }],
      },
    });
    if (unavailable) return { error: '该时间段已被标记为不可租' };

    const conflict = await checkTimeConflict(tx, listing.id, startTime, endTime, quantity);
    if (!conflict.available) return { error: '该时间段已被预订，库存不足' };

    const rentalAmount = calculateRentalAmount(listing.price, listing.pricingUnit, startTime, endTime);
    const depositAmount = listing.depositAmount;
    const finalAmount = rentalAmount.add(depositAmount);

    const orderStatus = listing.requiresApproval ? 'PENDING_APPROVAL' : 'PENDING_PICKUP';
    const depositStatus = depositAmount.gt(0) ? 'PENDING_PAYMENT' : 'NOT_REQUIRED';

    const order = await tx.rentalOrder.create({
      data: {
        orderNumber: createRentalOrderNo(),
        rentalListingId: listing.id,
        ownerId: listing.ownerId,
        renterId: userId,
        startTime,
        endTime,
        quantity,
        unitPriceSnapshot: listing.price,
        pricingUnitSnapshot: listing.pricingUnit as RentalPricingUnit,
        rentalDuration: duration,
        rentalAmount,
        depositAmount,
        serviceFee: new Prisma.Decimal(0),
        overdueFee: new Prisma.Decimal(0),
        depositDeduction: new Prisma.Decimal(0),
        finalAmount,
        paymentStatus: 'OFFLINE_PENDING',
        depositStatus,
        status: orderStatus,
        pickupLocationSnapshot: listing.pickupLocation,
        returnLocationSnapshot: listing.returnLocation,
        renterNote: input.renterNote || null,
      },
    });

    await writeStatusLog(tx, {
      orderId: order.id,
      fromStatus: null,
      toStatus: orderStatus,
      operatorId: userId,
      note: '租客提交租赁申请',
    });

    // FINAL SECONDARY-COPY CLOSURE（BLOCKER C）：listing.title 是
    // USER_AUTHORED_CONTENT（secondaryCopyAllowed=NO）——通知只做事件信号，
    // 绝不复制 listing 标题/描述/地点/renterNote（SECONDARY_COPY_FIELD_
    // EXPECTATIONS: RentalListing.title → Notification.content = FORBIDDEN）。
    await createNotifications(tx, [{
      userId: listing.ownerId,
      type: 'RENTAL',
      title: '收到新的租赁申请',
      content: '你的出租物品收到新的租赁申请，请前往出租订单中心处理。',
    }]);

    return { orderId: order.id };
  }, racePoint);
}

export async function approveRentalOrderTx(
  tx: Prisma.TransactionClient,
  input: { orderId: string; userId: string },
): Promise<RentalOrderTxError | { success: true }> {
  await prepareActiveAccountMutation(tx, input.userId);

  const order = await tx.rentalOrder.findFirst({
    where: { id: input.orderId, ownerId: input.userId, status: 'PENDING_APPROVAL' },
  });
  if (!order) return { error: "订单不存在或状态不允许" };

  await tx.rentalOrder.update({
    where: { id: input.orderId },
    data: { status: 'PENDING_PICKUP' },
  });

  await writeStatusLog(tx, {
    orderId: input.orderId,
    fromStatus: 'PENDING_APPROVAL',
    toStatus: 'PENDING_PICKUP',
    operatorId: input.userId,
    note: '出租者同意租赁',
  });

  await createNotifications(tx, [{
    userId: order.renterId,
    type: 'RENTAL',
    title: '租赁申请已通过',
    content: `你的租赁申请已被通过，请留意取货信息。`,
  }]);
  return { success: true };
}

export async function rejectRentalOrderTx(
  tx: Prisma.TransactionClient,
  input: { orderId: string; userId: string; rejectReason: string },
): Promise<RentalOrderTxError | { success: true }> {
  await prepareActiveAccountMutation(tx, input.userId);

  const order = await tx.rentalOrder.findFirst({
    where: { id: input.orderId, ownerId: input.userId, status: 'PENDING_APPROVAL' },
  });
  if (!order) return { error: "订单不存在或状态不允许" };

  await tx.rentalOrder.update({
    where: { id: input.orderId },
    data: {
      status: 'REJECTED',
      cancellationNote: input.rejectReason,
      cancellationReason: 'OTHER',
      cancelledById: input.userId,
      cancelledAt: new Date(),
    },
  });

  // Repair 4 / RB-04 secondary-copy rule：rejectReason 是 user free text，
  // 唯一权威保存在 RentalOrder.cancellationNote（由 lifecycle/erasure 策略
  // 处理）；status log note 与 Notification.content 都只允许 generic system
  // copy，绝不能复制原始原因。
  await writeStatusLog(tx, {
    orderId: input.orderId,
    fromStatus: 'PENDING_APPROVAL',
    toStatus: 'REJECTED',
    operatorId: input.userId,
    note: '出租者拒绝了租赁申请',
  });

  await createNotifications(tx, [{
    userId: order.renterId,
    type: 'RENTAL',
    title: '租赁申请被拒绝',
    content: '你的租赁申请未通过，请前往订单详情查看。',
  }]);
  return { success: true };
}

export async function confirmPickupTx(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    userId: string;
    role: RentalRole;
    photos: string[];
    currentCondition?: string;
    knownIssues?: string;
  },
): Promise<RentalOrderTxError | { success: true }> {
  await prepareActiveAccountMutation(tx, input.userId);

  const { orderId, userId, role } = input;
  const order = await tx.rentalOrder.findFirst({
    where: { id: orderId, status: 'PENDING_PICKUP' },
    include: { handoverRecord: true },
  });
  if (!order) return { error: "订单状态错误" };
  if (!isRentalOrderRoleParticipant(order, role, userId)) return { error: "无权操作" };

  const dataToUpdate: Record<string, unknown> = {
    photos: input.photos.length ? input.photos : undefined,
    currentCondition: input.currentCondition || undefined,
    knownIssues: input.knownIssues || undefined,
  };
  dataToUpdate[role === 'owner' ? 'ownerConfirmed' : 'renterConfirmed'] = true;

  const newRecord = await tx.rentalHandoverRecord.upsert({
    where: { orderId },
    create: {
      orderId,
      photos: input.photos,
      currentCondition: input.currentCondition,
      knownIssues: input.knownIssues,
      ownerConfirmed: role === 'owner',
      renterConfirmed: role === 'renter',
    },
    update: dataToUpdate,
  });

  if (newRecord.ownerConfirmed && newRecord.renterConfirmed) {
    await tx.rentalOrder.update({
      where: { id: orderId },
      data: { status: 'IN_RENTAL' },
    });
    await writeStatusLog(tx, {
      orderId,
      fromStatus: 'PENDING_PICKUP',
      toStatus: 'IN_RENTAL',
      operatorId: userId,
      note: '双方均已确认取货',
    });
    await createNotifications(tx, [
      { userId: order.ownerId, type: 'RENTAL', title: '取货已完成', content: '物品已开始租赁。' },
      { userId: order.renterId, type: 'RENTAL', title: '取货已完成', content: '物品已开始租赁。' },
    ]);
  }
  return { success: true };
}

export async function requestReturnTx(
  tx: Prisma.TransactionClient,
  input: { orderId: string; userId: string },
  activeAccountSeams?: ActiveAccountMutationSeams,
): Promise<RentalOrderTxError | { success: true }> {
  await prepareActiveAccountMutation(tx, input.userId, activeAccountSeams);

  const order = await tx.rentalOrder.findFirst({
    where: { id: input.orderId, renterId: input.userId, status: { in: ['IN_RENTAL', 'OVERDUE', 'PICKED_UP'] } },
  });
  if (!order) return { error: "订单状态错误" };

  await tx.rentalOrder.update({
    where: { id: input.orderId },
    data: { status: 'PENDING_RETURN' },
  });

  await writeStatusLog(tx, {
    orderId: input.orderId,
    fromStatus: order.status,
    toStatus: 'PENDING_RETURN',
    operatorId: input.userId,
    note: '租客发起归还请求',
  });

  await createNotifications(tx, [{
    userId: order.ownerId,
    type: 'RENTAL',
    title: '租客请求归还',
    content: `租客已请求归还物品，请确认。`,
  }]);
  return { success: true };
}

export async function confirmReturnTx(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    userId: string;
    role: RentalRole;
    photos: string[];
    hasDamage: boolean;
    needsCleaning: boolean;
    accessoriesComplete: boolean;
    inspectionNote?: string;
  },
): Promise<RentalOrderTxError | { success: true }> {
  await prepareActiveAccountMutation(tx, input.userId);

  const { orderId, userId, role, photos, hasDamage, needsCleaning, accessoriesComplete } = input;
  const order = await tx.rentalOrder.findFirst({
    where: { id: orderId, status: { in: ['PENDING_RETURN', 'PENDING_INSPECTION'] } },
    include: { returnRecord: true },
  });
  if (!order) return { error: "订单状态错误" };
  if (!isRentalOrderRoleParticipant(order, role, userId)) return { error: "无权操作" };

  const dataToUpdate: Record<string, unknown> = {
    photos: photos.length ? photos : undefined,
    hasDamage,
    needsCleaning,
    accessoriesComplete,
    inspectionNote: input.inspectionNote || undefined,
  };
  dataToUpdate[role === 'owner' ? 'ownerConfirmed' : 'renterConfirmed'] = true;

  if (order.returnRecord && ((role === 'owner' && order.returnRecord.ownerConfirmed) || (role === 'renter' && order.returnRecord.renterConfirmed))) {
    return { error: "不能重复确认" };
  }

  await tx.rentalReturnRecord.upsert({
    where: { orderId },
    create: {
      orderId,
      photos,
      hasDamage,
      needsCleaning,
      accessoriesComplete,
      inspectionNote: input.inspectionNote,
      ownerConfirmed: role === 'owner',
      renterConfirmed: role === 'renter',
    },
    update: dataToUpdate,
  });

  if (role === 'owner') {
    const now = new Date();
    const nextStatus = hasDamage ? 'PENDING_INSPECTION' : 'COMPLETED';
    const depStatus = nextStatus === 'COMPLETED' ? depositStatusAfterCompletion(order) : order.depositStatus;

    await tx.rentalOrder.update({
      where: { id: orderId },
      data: {
        actualReturnTime: now,
        status: nextStatus,
        ...(nextStatus === 'COMPLETED' ? { completedAt: now } : {}),
        depositStatus: depStatus,
      },
    });

    await writeStatusLog(tx, {
      orderId,
      fromStatus: order.status,
      toStatus: nextStatus,
      operatorId: userId,
      note: `出租者已确认归还${hasDamage ? '，物品有损坏' : ''}`,
    });

    if (nextStatus === 'COMPLETED') {
      await incrementRentalCompletionCounters(tx, order);
    }

    await createNotifications(tx, [{
      userId: order.renterId,
      type: 'RENTAL',
      title: '归还已确认',
      content: `出租者已确认物品归还。${hasDamage ? '请注意检查损坏索赔。' : ''}`,
    }]);
  }
  return { success: true };
}

export async function cancelRentalOrderTx(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    userId: string;
    cancellationReason: RentalCancellationReason;
    cancellationNote?: string;
  },
): Promise<RentalOrderTxError | { success: true }> {
  await prepareActiveAccountMutation(tx, input.userId);

  const order = await tx.rentalOrder.findFirst({ where: { id: input.orderId } });
  if (!order) return { error: "订单不存在" };
  if (!canCancelRentalOrder(order, input.userId)) return { error: "当前状态不允许取消" };

  await tx.rentalOrder.update({
    where: { id: input.orderId },
    data: {
      status: 'CANCELLED',
      cancelledById: input.userId,
      cancellationReason: input.cancellationReason,
      cancellationNote: input.cancellationNote,
      cancelledAt: new Date(),
    },
  });

  await writeStatusLog(tx, {
    orderId: input.orderId,
    fromStatus: order.status,
    toStatus: 'CANCELLED',
    operatorId: input.userId,
    note: `取消原因: ${input.cancellationReason}`,
  });

  await createNotifications(tx, [{
    userId: counterpartyId(order, input.userId),
    type: 'RENTAL',
    title: '订单已取消',
    content: `对方已取消订单。原因：${input.cancellationReason}`,
  }]);

  return { success: true };
}

/**
 * AUDIT2-RB03 冻结合同：允许发起/批准续租的订单状态全集。
 * 不新增状态；PENDING_RETURN / PENDING_INSPECTION / COMPLETED / CANCELLED /
 * REJECTED / CLOSED / IN_DISPUTE / OVERDUE 一律不得 approve（§25）。
 */
export const EXTENSION_ALLOWED_ORDER_STATUSES: readonly RentalOrderStatus[] = [
  "IN_RENTAL",
  "PICKED_UP",
];

type ExtensionOrderRow = {
  id: string;
  ownerId: string;
  renterId: string;
  rentalListingId: string;
  status: string;
  startTime: Date;
  endTime: Date;
  quantity: number;
  unitPriceSnapshot: unknown;
  pricingUnitSnapshot: string;
};

/** $queryRaw 行 → 续租计价/会计所需的 order 视图（Decimal/pricingUnit 手动包装）。 */
function asExtensionOrder(row: ExtensionOrderRow) {
  return {
    ...row,
    status: row.status as RentalOrderStatus,
    unitPriceSnapshot: new Prisma.Decimal(String(row.unitPriceSnapshot)),
    pricingUnitSnapshot: row.pricingUnitSnapshot as RentalPricingUnit,
  };
}

/** 测试 seam：participant 锁 + 全部校验通过后、winner gate 写入前的受控暂停点（生产不传）。 */
export type ExtensionRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

/**
 * 租客发起续租（AUDIT2-RB03 serialization 修复版）。
 *
 * 冻结流程（directive §14）：
 *   1. candidate pre-read（无锁，renterId 收口，仅发现 owner/renter 锁键）
 *   2. sorted {USER:owner, USER:renter} governance subject locks（完整参与方锁集，
 *      与 approve/reject/createRentalOrder/erase 同锁域串行；禁止只锁 actor）
 *   3. actor（renter）lifecycle 复核（assertActiveAccountMutationAllowed，checks-only）
 *   4. RentalOrder FOR UPDATE（不信任 pre-read snapshot，fresh 重验证 renter/状态）
 *   5. RentalListing FOR UPDATE（capacity authority 与 createRentalOrderTx 同 mutex）
 *   6. single-PENDING invariant：已有 PENDING → 稳定业务错误，绝不创建第二个
 *   7. fresh newEndTime > fresh order.endTime
 *   7b. maximumDuration 总租期合同：calculateRentalDuration(startTime → newEnd)
 *       ≤ locked listing.maximumDuration（续租不得绕过创建时同域规则）
 *   8. unavailable period 增量区间 [order.endTime, newEndTime) 命中即拒绝
 *   9. capacity check（request 阶段仅即时反馈，不是 approval authority）
 *   10. additionalFee 基于 fresh locked 订单 price snapshot 计价（listing 现价不是 authority）
 *   11. create PENDING + owner 通知
 *
 * seams（仅测试注入；生产不传）：beforeLock（发现锁键后、取锁前）、
 * afterCheck（actor ACTIVE 复核后、首个域校验前）——语义与
 * prepareActiveAccountMutation 相同，但锁集升级为完整参与方锁。
 */
export async function requestExtensionTx(
  tx: Prisma.TransactionClient,
  input: { orderId: string; userId: string; newEndTime: Date },
  activeAccountSeams?: ActiveAccountMutationSeams,
): Promise<RentalOrderTxError | { success: true }> {
  // ---- 步骤 1：candidate pre-read（无锁），仅发现 participant 锁键 ----
  const candidates = await tx.$queryRaw<Array<{ id: string; ownerId: string; renterId: string }>>`
    SELECT id, "ownerId", "renterId"
    FROM "RentalOrder"
    WHERE id = ${input.orderId} AND "renterId" = ${input.userId}
  `;
  const candidate = candidates[0];
  if (!candidate) return { error: "订单状态错误" };

  // ---- 步骤 2：ONE sorted set：USER:owner + USER:renter ----
  if (activeAccountSeams?.beforeLock) {
    await activeAccountSeams.beforeLock(tx);
  }
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.ownerId },
    { subjectType: "USER", subjectId: candidate.renterId },
  ]);

  // RB-03：仅 actor（renter）lifecycle 复核；不对既有义务重新定义对手方
  // suspension 语义（§11）
  await assertActiveAccountMutationAllowed(tx, input.userId);
  if (activeAccountSeams?.afterCheck) {
    await activeAccountSeams.afterCheck(tx);
  }

  // ---- 步骤 3：RentalOrder FOR UPDATE + fresh 重验证 ----
  const orderRows = await tx.$queryRaw<ExtensionOrderRow[]>`
    SELECT id, "ownerId", "renterId", "rentalListingId", status, "startTime", "endTime",
           quantity, "unitPriceSnapshot", "pricingUnitSnapshot"
    FROM "RentalOrder"
    WHERE id = ${candidate.id}
    FOR UPDATE
  `;
  const rawOrder = orderRows[0];
  // §15：renter 身份以锁内 fresh 行为准，绝不信任 candidate
  if (!rawOrder || rawOrder.renterId !== input.userId || rawOrder.ownerId !== candidate.ownerId) {
    return { error: "订单状态错误" };
  }
  if (!EXTENSION_ALLOWED_ORDER_STATUSES.includes(rawOrder.status as RentalOrderStatus)) {
    return { error: "订单状态错误" };
  }
  const order = asExtensionOrder(rawOrder);

  // ---- 步骤 4：RentalListing FOR UPDATE（capacity mutex；物理缺失 fail closed）----
  // AUDIT2-RB03 review fix：maximumDuration 是 extension 的 policy authority
  // （RentalOrder 无该字段的 snapshot，本轮以 locked listing 现势行为准，
  // SCHEMA_CHANGE=NO）。
  const listingRows = await tx.$queryRaw<Array<{ id: string; maximumDuration: number }>>`
    SELECT id, "maximumDuration"
    FROM "RentalListing"
    WHERE id = ${order.rentalListingId}
    FOR UPDATE
  `;
  const lockedListing = listingRows[0];
  if (!lockedListing) return { error: "出租物品不存在或已下架" };

  // ---- 步骤 5：single-PENDING invariant（§16，participant + order locks 内）----
  const pendingCount = await tx.rentalExtensionRequest.count({
    where: { orderId: order.id, status: "PENDING" },
  });
  if (pendingCount > 0) return { error: "已有待处理的续租请求" };

  // ---- 步骤 6：fresh newEndTime（§19，锁内而非 UI）----
  if (input.newEndTime <= order.endTime) return { error: "新结束时间必须晚于当前结束时间" };

  // ---- 步骤 6b：maximumDuration 总租期合同（review fix §2/§4）----
  // maximumDuration 约束整个订单 startTime → proposed endTime 的最大总租期，
  // 不是单次 extension 增量；语义与 createRentalOrderTx 相同，续租不得绕过。
  const proposedDuration = calculateRentalDuration(order.pricingUnitSnapshot, order.startTime, input.newEndTime);
  if (proposedDuration > lockedListing.maximumDuration) {
    return { error: `最长租期为 ${lockedListing.maximumDuration} 个计价单位` };
  }

  // ---- 步骤 7：unavailable period 增量区间（§22，与 createRentalOrderTx 同谓词）----
  const unavailable = await tx.rentalUnavailablePeriod.findFirst({
    where: {
      rentalListingId: order.rentalListingId,
      AND: [{ startDate: { lt: input.newEndTime } }, { endDate: { gt: order.endTime } }],
    },
  });
  if (unavailable) return { error: "该时间段已被标记为不可租" };

  // ---- 步骤 8：capacity 即时反馈（§21，approve 阶段仍会重查）----
  const conflict = await checkTimeConflict(tx, order.rentalListingId, order.endTime, input.newEndTime, order.quantity, order.id);
  if (!conflict.available) return { error: "续租时间段库存不足" };

  // ---- 步骤 9：fee 基于订单 price snapshot（§20）----
  const additionalFee = calculateRentalAmount(order.unitPriceSnapshot, order.pricingUnitSnapshot, order.endTime, input.newEndTime);

  await tx.rentalExtensionRequest.create({
    data: {
      orderId: order.id,
      requesterId: input.userId,
      newEndTime: input.newEndTime,
      additionalFee,
      status: 'PENDING',
    },
  });

  await createNotifications(tx, [{
    userId: order.ownerId,
    type: 'RENTAL',
    title: '收到续租请求',
    content: `租客请求续租物品至 ${input.newEndTime.toLocaleDateString()}。`,
  }]);
  return { success: true };
}

/**
 * 出租者批准续租（AUDIT2-RB03 serialization 修复版）。
 *
 * 冻结流程（directive §23-§39）：candidate pre-read（仅发现锁键）→
 * sorted {USER:owner, USER:renter} locks → actor（owner）ACTIVE 复核 →
 * RentalOrder FOR UPDATE + fresh 重验证（参与者/状态，§24/§25）→
 * RentalListing FOR UPDATE（capacity mutex，§26）→
 * RentalExtensionRequest FOR UPDATE + fresh 验证（§28）→
 * exact single-PENDING cardinality（§29，历史脏数据 fail closed）→
 * fresh endTime（§30 不得缩短订单）→ maximumDuration approval-time 复查
 * （review fix：locked listing 现势值，request-time PASS 不是 authority）→
 * fee 重算比对（§31 基线漂移 fail
 * closed，不静默改价）→ unavailable period（§33）→ capacity（§33）→
 * racePoint（测试 seam）→ conditional winner gate（§34 updateMany
 * PENDING→APPROVED count=1）→ 订单 endTime/rentalDuration/rentalAmount/
 * finalAmount 同事务更新（§35-§37）→ status log（§38）→ renter 通知
 * （§39 仅 winner 一条）。
 *
 * 冲突类失败（unavailable/capacity）时 extension 保持 PENDING（§33）。
 */
export async function approveExtensionTx(
  tx: Prisma.TransactionClient,
  input: { extensionRequestId: string; userId: string },
  racePoint?: ExtensionRacePoint,
): Promise<RentalOrderTxError | { success: true }> {
  // ---- 步骤 1：candidate pre-read（无锁），仅发现锁键 ----
  const candidates = await tx.$queryRaw<
    Array<{ id: string; orderId: string; ownerId: string; renterId: string; listingId: string }>
  >`
    SELECT ext."id", ext."orderId", o."ownerId", o."renterId", o."rentalListingId" AS "listingId"
    FROM "RentalExtensionRequest" ext
    JOIN "RentalOrder" o ON ext."orderId" = o."id"
    WHERE ext."id" = ${input.extensionRequestId}
  `;
  const candidate = candidates[0];
  if (!candidate) return { error: "无效请求" };

  // ---- 步骤 2：ONE sorted set：USER:owner + USER:renter ----
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.ownerId },
    { subjectType: "USER", subjectId: candidate.renterId },
  ]);

  // RB-03：仅 actor（owner）lifecycle 复核
  await assertActiveAccountMutationAllowed(tx, input.userId);

  // ---- 步骤 3：RentalOrder FOR UPDATE + fresh 权威重验证（§24）----
  const orderRows = await tx.$queryRaw<ExtensionOrderRow[]>`
    SELECT id, "ownerId", "renterId", "rentalListingId", status, "startTime", "endTime",
           quantity, "unitPriceSnapshot", "pricingUnitSnapshot"
    FROM "RentalOrder"
    WHERE id = ${candidate.orderId}
    FOR UPDATE
  `;
  const rawOrder = orderRows[0];
  if (!rawOrder) return { error: "无效请求" };
  if (
    rawOrder.ownerId !== candidate.ownerId ||
    rawOrder.renterId !== candidate.renterId ||
    rawOrder.rentalListingId !== candidate.listingId
  ) {
    return { error: "订单状态已变化，请重试" };
  }
  if (rawOrder.ownerId !== input.userId) return { error: "无效请求" };
  if (!EXTENSION_ALLOWED_ORDER_STATUSES.includes(rawOrder.status as RentalOrderStatus)) {
    return { error: "订单状态已变化，无法续租" };
  }
  const order = asExtensionOrder(rawOrder);

  // ---- 步骤 4：RentalListing FOR UPDATE（§26 capacity mutex；物理缺失 fail closed）----
  // review fix：approval-time maximumDuration 以 locked listing 现势行为准，
  // 绝不信任 request-time 旧值（owner 可能已在 request 之后收紧最长租期）。
  const listingRows = await tx.$queryRaw<Array<{ id: string; maximumDuration: number }>>`
    SELECT id, "maximumDuration"
    FROM "RentalListing"
    WHERE id = ${order.rentalListingId}
    FOR UPDATE
  `;
  const lockedListing = listingRows[0];
  if (!lockedListing) return { error: "出租物品不存在或已下架" };

  // ---- 步骤 5：RentalExtensionRequest FOR UPDATE + fresh 验证（§28）----
  const extRows = await tx.$queryRaw<
    Array<{
      id: string;
      orderId: string;
      requesterId: string;
      newEndTime: Date;
      additionalFee: unknown;
      status: string;
    }>
  >`
    SELECT "id", "orderId", "requesterId", "newEndTime", "additionalFee", "status"
    FROM "RentalExtensionRequest"
    WHERE id = ${input.extensionRequestId}
    FOR UPDATE
  `;
  const rawExt = extRows[0];
  if (
    !rawExt ||
    rawExt.orderId !== order.id ||
    rawExt.requesterId !== order.renterId ||
    rawExt.status !== "PENDING"
  ) {
    return { error: "无效请求" };
  }
  const ext = {
    ...rawExt,
    additionalFee: new Prisma.Decimal(String(rawExt.additionalFee)),
  };

  // ---- 步骤 6：exact pending cardinality（§29，历史重复 PENDING fail closed）----
  const pendingCount = await tx.rentalExtensionRequest.count({
    where: { orderId: order.id, status: "PENDING" },
  });
  if (pendingCount !== 1) return { error: "存在多个待处理的续租请求，请先逐个拒绝后再审批" };

  // ---- 步骤 7：fresh base-end 保护（§30，绝不缩短订单）----
  if (ext.newEndTime <= order.endTime) return { error: "续租请求已过期，请重新提交续租" };

  // ---- 步骤 7b：maximumDuration approval-time 复查（review fix §2/§5/§6）----
  // request-time PASS 不是 approval authority：fresh locked listing.maximumDuration
  // 才是 policy authority。违反时返回同一稳定业务错误，extension 保持 PENDING、
  // 订单零变更、零 approval notification。
  const proposedDuration = calculateRentalDuration(order.pricingUnitSnapshot, order.startTime, ext.newEndTime);
  if (proposedDuration > lockedListing.maximumDuration) {
    return { error: `最长租期为 ${lockedListing.maximumDuration} 个计价单位` };
  }

  // ---- 步骤 8：fee 重算比对（§31/§32，基线漂移 fail closed 不改价）----
  const expectedAdditionalFee = calculateRentalAmount(
    order.unitPriceSnapshot,
    order.pricingUnitSnapshot,
    order.endTime,
    ext.newEndTime,
  );
  if (!expectedAdditionalFee.eq(ext.additionalFee)) {
    return { error: "续租费用已变化，请重新提交续租" };
  }

  // ---- 步骤 9：unavailable period（§22/§33，冲突保持 PENDING）----
  const unavailable = await tx.rentalUnavailablePeriod.findFirst({
    where: {
      rentalListingId: order.rentalListingId,
      AND: [{ startDate: { lt: ext.newEndTime } }, { endDate: { gt: order.endTime } }],
    },
  });
  if (unavailable) return { error: "该时间段已被标记为不可租" };

  // ---- 步骤 10：capacity recheck（§33，冲突保持 PENDING）----
  const conflict = await checkTimeConflict(tx, order.rentalListingId, order.endTime, ext.newEndTime, order.quantity, order.id);
  if (!conflict.available) return { error: "续租时间段库存不足" };

  if (racePoint) {
    await racePoint(tx);
  }

  // ---- 步骤 11：winner gate（§34 conditional updateMany，count 必须 = 1）----
  const gate = await tx.rentalExtensionRequest.updateMany({
    where: { id: ext.id, status: "PENDING" },
    data: { status: "APPROVED" },
  });
  if (gate.count !== 1) return { error: "无效请求" };

  // ---- 步骤 12：会计一致性（§35-§37：duration 重算，金额各加一次）----
  const newRentalDuration = calculateRentalDuration(order.pricingUnitSnapshot, order.startTime, ext.newEndTime);
  await tx.rentalOrder.update({
    where: { id: order.id },
    data: {
      endTime: ext.newEndTime,
      rentalDuration: newRentalDuration,
      rentalAmount: { increment: expectedAdditionalFee },
      finalAmount: { increment: expectedAdditionalFee },
    },
  });

  // ---- 步骤 13：status log（§38 same-status domain event）----
  await writeStatusLog(tx, {
    orderId: order.id,
    fromStatus: order.status,
    toStatus: order.status,
    operatorId: input.userId,
    note: `出租者同意续租，新结束时间: ${ext.newEndTime.toISOString()}`,
  });

  // ---- 步骤 14：renter 通知（§39 仅 winner 一条）----
  await createNotifications(tx, [{
    userId: order.renterId,
    type: 'RENTAL',
    title: '续租请求已通过',
    content: `你的续租请求已通过。`,
  }]);
  return { success: true };
}

/**
 * 出租者拒绝续租（AUDIT2-RB03 serialization 修复版）。
 *
 * 冻结流程（directive §40-§42）：candidate pre-read → sorted participant
 * locks → owner ACTIVE 复核 → RentalOrder FOR UPDATE →
 * RentalExtensionRequest FOR UPDATE + fresh 验证 → conditional
 * PENDING→REJECTED（count=1）→ renter 通知。
 *
 * reject 属于 closing a pending request（§41）：不检查订单当前状态——
 * 订单即使已 PENDING_RETURN / IN_DISPUTE / COMPLETED，owner 仍可拒绝以
 * 清理 stale request。与 approve 共享同一锁集 + extension 行锁，单胜者。
 */
export async function rejectExtensionTx(
  tx: Prisma.TransactionClient,
  input: { extensionRequestId: string; userId: string },
  racePoint?: ExtensionRacePoint,
): Promise<RentalOrderTxError | { success: true }> {
  // ---- 步骤 1：candidate pre-read（无锁），仅发现锁键 ----
  const candidates = await tx.$queryRaw<
    Array<{ id: string; orderId: string; ownerId: string; renterId: string }>
  >`
    SELECT ext."id", ext."orderId", o."ownerId", o."renterId"
    FROM "RentalExtensionRequest" ext
    JOIN "RentalOrder" o ON ext."orderId" = o."id"
    WHERE ext."id" = ${input.extensionRequestId}
  `;
  const candidate = candidates[0];
  if (!candidate) return { error: "无效请求" };

  // ---- 步骤 2：ONE sorted set：USER:owner + USER:renter ----
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.ownerId },
    { subjectType: "USER", subjectId: candidate.renterId },
  ]);

  // RB-03：仅 actor（owner）lifecycle 复核
  await assertActiveAccountMutationAllowed(tx, input.userId);

  // ---- 步骤 3：RentalOrder FOR UPDATE + fresh 重验证 ----
  const orderRows = await tx.$queryRaw<
    Array<{ id: string; ownerId: string; renterId: string; status: string }>
  >`
    SELECT id, "ownerId", "renterId", "status"
    FROM "RentalOrder"
    WHERE id = ${candidate.orderId}
    FOR UPDATE
  `;
  const rawOrder = orderRows[0];
  if (!rawOrder) return { error: "无效请求" };
  if (rawOrder.ownerId !== candidate.ownerId || rawOrder.renterId !== candidate.renterId) {
    return { error: "订单状态已变化，请重试" };
  }
  if (rawOrder.ownerId !== input.userId) return { error: "无效请求" };

  // ---- 步骤 4：RentalExtensionRequest FOR UPDATE + fresh 验证 ----
  const extRows = await tx.$queryRaw<
    Array<{ id: string; orderId: string; requesterId: string; status: string }>
  >`
    SELECT "id", "orderId", "requesterId", "status"
    FROM "RentalExtensionRequest"
    WHERE id = ${input.extensionRequestId}
    FOR UPDATE
  `;
  const rawExt = extRows[0];
  if (
    !rawExt ||
    rawExt.orderId !== rawOrder.id ||
    rawExt.requesterId !== rawOrder.renterId ||
    rawExt.status !== "PENDING"
  ) {
    return { error: "无效请求" };
  }

  if (racePoint) {
    await racePoint(tx);
  }

  // ---- 步骤 5：conditional PENDING→REJECTED（count 必须 = 1）----
  const gate = await tx.rentalExtensionRequest.updateMany({
    where: { id: rawExt.id, status: "PENDING" },
    data: { status: "REJECTED" },
  });
  if (gate.count !== 1) return { error: "无效请求" };

  await createNotifications(tx, [{
    userId: rawOrder.renterId,
    type: 'RENTAL',
    title: '续租请求被拒绝',
    content: `你的续租请求被拒绝。`,
  }]);
  return { success: true };
}

export async function submitDamageClaimTx(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    userId: string;
    damageDescription: string;
    requestedDeduction: string;
    photos: string[];
  },
): Promise<RentalOrderTxError | { success: true }> {
  await prepareActiveAccountMutation(tx, input.userId);

  const order = await tx.rentalOrder.findFirst({
    where: { id: input.orderId, ownerId: input.userId, status: 'PENDING_INSPECTION' },
  });
  if (!order) return { error: "状态错误" };
  if (new Prisma.Decimal(input.requestedDeduction).gt(order.depositAmount)) return { error: "索赔金额不能大于押金" };

  await tx.rentalDamageClaim.create({
    data: {
      orderId: input.orderId,
      submittedById: input.userId,
      damageDescription: input.damageDescription,
      requestedDeduction: new Prisma.Decimal(input.requestedDeduction),
      photos: input.photos,
    },
  });

  await createNotifications(tx, [{
    userId: order.renterId,
    type: 'RENTAL',
    title: '收到损坏索赔',
    content: `出租者提交了损坏索赔请求，请尽快处理。`,
  }]);
  return { success: true };
}

export async function respondDamageClaimTx(
  tx: Prisma.TransactionClient,
  input: { claimId: string; userId: string; agreed: boolean; renterNote?: string },
): Promise<RentalOrderTxError | { success: true }> {
  await prepareActiveAccountMutation(tx, input.userId);

  const claim = await tx.rentalDamageClaim.findFirst({
    where: { id: input.claimId, resolvedAt: null },
    include: { order: true },
  });
  if (!claim || claim.order.renterId !== input.userId) return { error: "无效请求" };

  await tx.rentalDamageClaim.update({
    where: { id: input.claimId },
    data: { renterAgreed: input.agreed, renterNote: input.renterNote, resolvedAt: new Date() },
  });

  const now = new Date();
  if (input.agreed) {
    await tx.rentalOrder.update({
      where: { id: claim.orderId },
      data: {
        depositDeduction: claim.requestedDeduction,
        depositStatus: 'PARTIALLY_REFUNDED', // Simplified
        status: 'COMPLETED',
        completedAt: now,
      },
    });
  } else {
    // 租客拒绝索赔：物品已实际归还，订单完成、押金不扣除并进入退回流程；
    // 出租者若不认可，仍可在 COMPLETED 状态发起纠纷（initiateDispute 允许该状态）。
    await tx.rentalOrder.update({
      where: { id: claim.orderId },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        depositStatus: depositStatusAfterCompletion(claim.order),
      },
    });
  }

  if (claim.order.status !== 'COMPLETED') {
    await writeStatusLog(tx, {
      orderId: claim.orderId,
      fromStatus: claim.order.status,
      toStatus: 'COMPLETED',
      operatorId: input.userId,
      note: input.agreed ? '租客同意损坏索赔，订单完成' : '租客拒绝损坏索赔，订单完成',
    });
    await incrementRentalCompletionCounters(tx, claim.order);
  }

  await createNotifications(tx, [{
    userId: claim.order.ownerId,
    type: 'RENTAL',
    title: input.agreed ? '索赔已同意' : '索赔被拒绝',
    content: `租客${input.agreed ? '同意' : '拒绝'}了损坏索赔。`,
  }]);
  return { success: true };
}

/**
 * Phase 7G：发起租赁纠纷（serialization 修复版）。
 *
 * 修复既有 read → create → update 无锁模式（TOCTOU：并发双 dispute、
 * 锁外状态校验）。冻结流程（directive §INITIATE DISPUTE SERIALIZATION）：
 *
 *   1. candidate order pre-read（无锁，仅发现 ownerId/renterId/campusId）
 *   2. acquire ONE sorted governance subject lock set：USER:owner + USER:renter
 *      （与 role revoke / account suspend / erasure / 其它 dispute 决策同锁序串行）
 *   3. RentalOrder FOR UPDATE
 *   4. locked re-read / revalidate：同一 owner/renter/campus、disputable 状态、
 *      无 active dispute（pre-read 仅 discovery，绝不信任其快照）
 *   5. create RentalDispute：status=OPEN、openedFromOrderStatus=当前订单状态
 *      （恒 non-null）、campus snapshot（order → listing.campusId）、
 *      dueAt = createdAt + 48h
 *   6. create dispute DataHolds（owner + renter，source-linked）经
 *      createHoldTxLocked seam（调用方锁前置条件在本事务内已满足）
 *   7. RentalOrder.status = IN_DISPUTE
 *   8. status log
 *   9. notifications
 *
 * 不使用 sleep 排序；同一订单的 active dispute 唯一性另由 DB partial unique
 * index（RentalDispute_order_active_key）兜底。DISPUTE_AUTO_RISK_FLAG =
 * DISABLED（dispute 是双边关系，RiskFlag.userId 是单边的——禁止自动把
 * initiator/counterparty 变成 risk signal target）；也不产生任何
 * EnforcementAction / 审计行（用户侧动作，非治理 mutation）。
 */
export async function initiateDisputeTx(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    userId: string;
    reason: string;
    evidencePhotos: string[];
    /** 测试 seam：锁 + 复查之后、首个写入之前（D-RACE waiter 注入；生产不传） */
    racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
    /** 测试 seam：sorted participant USER locks 取得之前（erase-wins 构造；生产不传） */
    beforeSubjectLocks?: (tx: Prisma.TransactionClient) => Promise<void>;
  },
): Promise<RentalOrderTxError | { success: true }> {
  // ---- 步骤 1：candidate pre-read（无锁，仅用于发现锁键与 campus）----
  const candidates = await tx.$queryRaw<
    { id: string; ownerId: string; renterId: string; campusId: string }[]
  >`
    SELECT o."id", o."ownerId", o."renterId", l."campusId"
    FROM "RentalOrder" o
    JOIN "RentalListing" l ON o."rentalListingId" = l."id"
    WHERE o."id" = ${input.orderId}
      AND (o."ownerId" = ${input.userId} OR o."renterId" = ${input.userId})
  `;
  const candidate = candidates[0];
  if (!candidate) return { error: "无效请求" };

  // ---- 步骤 2：ONE sorted set：USER:owner + USER:renter（全局锁序）----
  if (input.beforeSubjectLocks) {
    await input.beforeSubjectLocks(tx);
  }

  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.ownerId },
    { subjectType: "USER", subjectId: candidate.renterId },
  ]);

  // RB-03 REVIEW FIX：initiator lifecycle 复核（checks-only——完整
  // sorted {USER:owner, USER:renter} 已取得，禁止 actor-only 部分锁重取）。
  // 只要求 initiator ACTIVE；counterparty ACTIVE 不是本轮新增条件
  // （COMPLETED 历史交易可对已失效对手方发起合法治理 dispute）
  await assertActiveAccountMutationAllowed(tx, input.userId);

  // ---- 步骤 3：RentalOrder FOR UPDATE（行锁下重验证）----
  const rows = await tx.$queryRaw<
    { id: string; ownerId: string; renterId: string; status: string; campusId: string }[]
  >`
    SELECT o."id", o."ownerId", o."renterId", o."status", l."campusId"
    FROM "RentalOrder" o
    JOIN "RentalListing" l ON o."rentalListingId" = l."id"
    WHERE o."id" = ${input.orderId}
    FOR UPDATE
  `;
  const order = rows[0];
  if (!order) return { error: "无效请求" };

  // ---- 步骤 4：locked revalidate（不信任 pre-read snapshot，fail closed）----
  if (order.ownerId !== candidate.ownerId || order.renterId !== candidate.renterId) {
    return { error: "订单状态已变化，请重试" };
  }
  if (order.campusId !== candidate.campusId) {
    return { error: "订单状态已变化，请重试" };
  }
  if (order.ownerId !== input.userId && order.renterId !== input.userId) {
    return { error: "无效请求" };
  }
  if (!isDisputableStatus(order.status as RentalOrderStatus)) {
    return { error: "状态不允许纠纷" };
  }
  const activeDispute = await tx.rentalDispute.findFirst({
    where: { orderId: input.orderId, status: { in: [...DISPUTE_ACTIVE_STATUSES] } },
    select: { id: true },
  });
  if (activeDispute) return { error: "该订单已有进行中的纠纷" };

  if (input.racePoint) {
    await input.racePoint(tx);
  }

  // ---- 步骤 5-9：dispute + source-linked holds + order 状态 + log + 通知 ----
  const now = new Date();
  const dispute = await tx.rentalDispute.create({
    data: {
      orderId: input.orderId,
      initiatorId: input.userId,
      reason: input.reason,
      evidencePhotos: input.evidencePhotos,
      status: "OPEN",
      campusId: order.campusId,
      scopeKey: disputeCampusScopeKey(order.campusId),
      openedFromOrderStatus: order.status as RentalOrderStatus,
      dueAt: computeDisputeDueAt(now),
      createdAt: now,
    },
    select: { id: true },
  });

  // 步骤 6：owner + renter 各一条 source-linked DISPUTE hold（TxLocked seam，
  // 本事务已持有双方 subject 锁 → 前置条件满足；partial unique 兜底重复）
  await createHoldTxLocked(tx, {
    type: "DISPUTE",
    subjectType: "USER",
    subjectId: order.ownerId,
    reasonCode: DISPUTE_HOLD_REASON_CODE,
    sourceType: DATA_HOLD_SOURCE_TYPE_RENTAL_DISPUTE,
    sourceId: dispute.id,
  });
  await createHoldTxLocked(tx, {
    type: "DISPUTE",
    subjectType: "USER",
    subjectId: order.renterId,
    reasonCode: DISPUTE_HOLD_REASON_CODE,
    sourceType: DATA_HOLD_SOURCE_TYPE_RENTAL_DISPUTE,
    sourceId: dispute.id,
  });

  await tx.rentalOrder.update({
    where: { id: input.orderId },
    data: { status: "IN_DISPUTE" },
  });

  // Repair 4 / RB-04：dispute reason 是 user free text（权威在
  // RentalDispute.reason）——status log note 只允许 generic system copy，
  // 绝不拼接原始纠纷原因。
  await writeStatusLog(tx, {
    orderId: input.orderId,
    fromStatus: order.status as RentalOrderStatus,
    toStatus: "IN_DISPUTE",
    operatorId: input.userId,
    note: "订单进入纠纷流程",
  });

  await createNotifications(tx, [{
    userId: counterpartyId(order, input.userId),
    type: 'RENTAL',
    title: '发生订单纠纷',
    content: `对方对订单发起了纠纷。`,
  }]);
  return { success: true };
}

export async function submitRentalReviewTx(
  tx: Prisma.TransactionClient,
  input: { orderId: string; userId: string; overallRating: number; content?: string },
  activeAccountSeams?: ActiveAccountMutationSeams,
): Promise<RentalOrderTxError | { success: true }> {
  await prepareActiveAccountMutation(tx, input.userId, activeAccountSeams);

  const order = await tx.rentalOrder.findFirst({
    where: { id: input.orderId, status: 'COMPLETED', OR: [{ ownerId: input.userId }, { renterId: input.userId }] },
  });
  if (!order) return { error: "订单状态错误" };

  const exist = await tx.rentalReview.findFirst({ where: { orderId: input.orderId, authorId: input.userId } });
  if (exist) return { error: "已经评价过" };

  const targetUserId = counterpartyId(order, input.userId);

  await tx.rentalReview.create({
    data: {
      orderId: input.orderId,
      authorId: input.userId,
      targetUserId,
      overallRating: input.overallRating,
      content: input.content || null,
      tags: [],
    },
  });

  await recomputeRentalPositiveRate(tx, targetUserId);

  await createNotifications(tx, [{
    userId: targetUserId,
    type: 'RENTAL',
    title: '收到新评价',
    content: `对方已对订单进行了评价。`,
  }]);
  return { success: true };
}
