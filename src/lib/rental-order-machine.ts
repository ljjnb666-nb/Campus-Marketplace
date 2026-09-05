import { Prisma, type DepositStatus, type RentalCancellationReason, type RentalOrderStatus, type RentalPricingUnit } from "@prisma/client";
import { createNotifications } from "@/repositories/notification-repository";
import { calculateRentalAmount, calculateRentalDuration, createRentalOrderNo } from "@/lib/rental-price";
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

  // ---- 步骤 1：普通只读 pre-read（无锁），仅用于发现 candidate ownerId ----
  const candidates = await tx.$queryRaw<Array<{ id: string; ownerId: string }>>`
    SELECT id, "ownerId"
    FROM "RentalListing"
    WHERE id = ${input.rentalListingId} AND "deletedAt" IS NULL AND status = 'AVAILABLE'
  `;
  const candidate = candidates[0];

  if (!candidate) return { error: '出租物品不存在或已下架' };
  if (candidate.ownerId === userId) return { error: '不能租用自己的物品' };

  // ---- 步骤 2/3：participant governance 锁 + 活跃复核（racePoint seam）----
  return withObligationGuard(
    tx,
    [userId, candidate.ownerId],
    async () => {
      // ---- 步骤 4：取得 subject locks 后再 FOR UPDATE 同一行 ----
    // ⚠️ 维护注意：此处使用 $queryRaw + FOR UPDATE 绕过 Prisma 类型化查询以获取行锁。
    // 代价是字段列表、返回类型需与 prisma/schema.prisma 的 RentalListing 模型手动同步。
    // 如果 RentalListing 新增/重命名字段且此处遗漏，TypeScript 不会在编译期报错。
    // 修改 RentalListing schema 时请同步检查此处的 SELECT 列表。
    const listings = await tx.$queryRaw<Array<{
      id: string; ownerId: string; totalQuantity: number;
      minimumDuration: number; maximumDuration: number;
      price: unknown; pricingUnit: string; depositAmount: unknown;
      pickupLocation: string; returnLocation: string;
      requiresApproval: boolean; status: string; title: string; deletedAt: Date | null;
    }>>`
      SELECT id, "ownerId", "totalQuantity", "minimumDuration", "maximumDuration",
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

    await createNotifications(tx, [{
      userId: listing.ownerId,
      type: 'RENTAL',
      title: '收到新的租赁申请',
      content: `"${listing.title}" 收到新的租赁申请，请前往出租订单中心处理。`,
    }]);

    return { orderId: order.id };
  }, racePoint);
}

export async function approveRentalOrderTx(
  tx: Prisma.TransactionClient,
  input: { orderId: string; userId: string },
): Promise<RentalOrderTxError | { success: true }> {
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

  await writeStatusLog(tx, {
    orderId: input.orderId,
    fromStatus: 'PENDING_APPROVAL',
    toStatus: 'REJECTED',
    operatorId: input.userId,
    note: `出租者拒绝租赁: ${input.rejectReason}`,
  });

  await createNotifications(tx, [{
    userId: order.renterId,
    type: 'RENTAL',
    title: '租赁申请被拒绝',
    content: `你的租赁申请被拒绝。原因：${input.rejectReason}`,
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
): Promise<RentalOrderTxError | { success: true }> {
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

export async function requestExtensionTx(
  tx: Prisma.TransactionClient,
  input: { orderId: string; userId: string; newEndTime: Date },
): Promise<RentalOrderTxError | { success: true }> {
  const order = await tx.rentalOrder.findFirst({
    where: { id: input.orderId, renterId: input.userId, status: { in: ['IN_RENTAL', 'PICKED_UP'] } },
  });
  if (!order) return { error: "订单状态错误" };
  if (input.newEndTime <= order.endTime) return { error: "新结束时间必须晚于当前结束时间" };

  const conflict = await checkTimeConflict(tx, order.rentalListingId, order.endTime, input.newEndTime, order.quantity, order.id);
  if (!conflict.available) return { error: "续租时间段库存不足" };

  const additionalFee = calculateRentalAmount(order.unitPriceSnapshot, order.pricingUnitSnapshot, order.endTime, input.newEndTime);

  await tx.rentalExtensionRequest.create({
    data: {
      orderId: input.orderId,
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

async function findPendingExtensionForOwner(
  tx: Prisma.TransactionClient,
  extensionRequestId: string,
  userId: string,
) {
  const ext = await tx.rentalExtensionRequest.findFirst({
    where: { id: extensionRequestId, status: 'PENDING' },
    include: { order: true },
  });
  if (!ext || ext.order.ownerId !== userId) return null;
  return ext;
}

export async function approveExtensionTx(
  tx: Prisma.TransactionClient,
  input: { extensionRequestId: string; userId: string },
): Promise<RentalOrderTxError | { success: true }> {
  const ext = await findPendingExtensionForOwner(tx, input.extensionRequestId, input.userId);
  if (!ext) return { error: "无效请求" };

  const conflict = await checkTimeConflict(tx, ext.order.rentalListingId, ext.order.endTime, ext.newEndTime, ext.order.quantity, ext.order.id);
  if (!conflict.available) return { error: "续租时间段库存不足" };

  await tx.rentalExtensionRequest.update({
    where: { id: input.extensionRequestId },
    data: { status: 'APPROVED' },
  });

  await tx.rentalOrder.update({
    where: { id: ext.orderId },
    data: {
      endTime: ext.newEndTime,
      finalAmount: { increment: ext.additionalFee },
    },
  });

  await writeStatusLog(tx, {
    orderId: ext.orderId,
    fromStatus: ext.order.status,
    toStatus: ext.order.status,
    operatorId: input.userId,
    note: `出租者同意续租，新结束时间: ${ext.newEndTime.toISOString()}`,
  });

  await createNotifications(tx, [{
    userId: ext.order.renterId,
    type: 'RENTAL',
    title: '续租请求已通过',
    content: `你的续租请求已通过。`,
  }]);
  return { success: true };
}

export async function rejectExtensionTx(
  tx: Prisma.TransactionClient,
  input: { extensionRequestId: string; userId: string },
): Promise<RentalOrderTxError | { success: true }> {
  const ext = await findPendingExtensionForOwner(tx, input.extensionRequestId, input.userId);
  if (!ext) return { error: "无效请求" };

  await tx.rentalExtensionRequest.update({
    where: { id: input.extensionRequestId },
    data: { status: 'REJECTED' },
  });

  await createNotifications(tx, [{
    userId: ext.order.renterId,
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

export async function initiateDisputeTx(
  tx: Prisma.TransactionClient,
  input: { orderId: string; userId: string; reason: string; evidencePhotos: string[] },
): Promise<RentalOrderTxError | { success: true }> {
  const order = await tx.rentalOrder.findFirst({
    where: { id: input.orderId, OR: [{ ownerId: input.userId }, { renterId: input.userId }] },
  });
  if (!order) return { error: "无效请求" };

  if (!isDisputableStatus(order.status)) return { error: "状态不允许纠纷" };

  await tx.rentalDispute.create({
    data: {
      orderId: input.orderId,
      initiatorId: input.userId,
      reason: input.reason,
      evidencePhotos: input.evidencePhotos,
      status: 'OPEN',
    },
  });

  await tx.rentalOrder.update({
    where: { id: input.orderId },
    data: { status: 'IN_DISPUTE' },
  });

  await writeStatusLog(tx, {
    orderId: input.orderId,
    fromStatus: order.status,
    toStatus: 'IN_DISPUTE',
    operatorId: input.userId,
    note: `发起纠纷: ${input.reason}`,
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
): Promise<RentalOrderTxError | { success: true }> {
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
