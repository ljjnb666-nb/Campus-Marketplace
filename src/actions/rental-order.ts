"use server";

import { Prisma, RentalCancellationReason } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import { createNotifications } from "@/repositories/notification-repository";
import { calculateRentalAmount, calculateRentalDuration, createRentalOrderNo } from "@/lib/rental-price";
import { checkTimeConflict } from "@/repositories/rental-order-repository";
import { rentalOrderCreateSchema, rentalExtensionSchema, rentalDamageClaimSchema, rentalReviewSchema } from "@/validators/rental";
import { saveUploadedImage } from "@/lib/upload";

export type RentalOrderActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};

export async function createRentalOrder(_prevState: RentalOrderActionState, formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  
  const parsed = rentalOrderCreateSchema.safeParse({
    rentalListingId: formData.get('rentalListingId'),
    startTime: formData.get('startTime'),
    endTime: formData.get('endTime'),
    quantity: formData.get('quantity') ?? '1',
    renterNote: formData.get('renterNote'),
  });
  
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? '参数不正确' };
  }
  
  const startTime = new Date(parsed.data.startTime);
  const endTime = new Date(parsed.data.endTime);
  const quantity = Number(parsed.data.quantity);
  
  if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
    return { success: false, message: '时间格式不正确' };
  }
  if (startTime >= endTime) {
    return { success: false, message: '开始时间必须早于结束时间' };
  }
  
  const result = await prisma.$transaction(async (tx) => {
    const listing = await tx.rentalListing.findFirst({
      where: { id: parsed.data.rentalListingId, deletedAt: null, status: 'AVAILABLE' },
    });
    
    if (!listing) return { error: '出租物品不存在或已下架' };
    if (listing.ownerId === user.id) return { error: '不能租用自己的物品' };
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
        renterId: user.id,
        startTime,
        endTime,
        quantity,
        unitPriceSnapshot: listing.price,
        pricingUnitSnapshot: listing.pricingUnit,
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
        renterNote: parsed.data.renterNote || null,
      },
    });
    
    await tx.rentalOrderStatusLog.create({
      data: {
        orderId: order.id,
        fromStatus: null,
        toStatus: orderStatus,
        operatorId: user.id,
        note: '租客提交租赁申请',
      },
    });
    
    await createNotifications(tx, [{
      userId: listing.ownerId,
      orderId: order.id,
      type: 'RENTAL',
      title: '收到新的租赁申请',
      content: `"${listing.title}" 收到新的租赁申请，请前往出租订单中心处理。`,
    }]);
    
    return { orderId: order.id };
  });
  
  if ('error' in result) return { success: false, message: result.error as string };
  
  revalidatePath('/rentals');
  revalidatePath('/my/owner-orders');
  revalidatePath('/my/rental-orders');
  
  return { success: true, message: '租赁申请已提交', redirectTo: `/rental-orders/${result.orderId}` };
}

export async function approveRentalOrder(formData: FormData) {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");

  await prisma.$transaction(async (tx) => {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, ownerId: user.id, status: 'PENDING_APPROVAL' },
    });
    if (!order) throw new Error("订单不存在或状态不允许");

    await tx.rentalOrder.update({
      where: { id: orderId },
      data: { status: 'PENDING_PICKUP' },
    });

    await tx.rentalOrderStatusLog.create({
      data: {
        orderId,
        fromStatus: 'PENDING_APPROVAL',
        toStatus: 'PENDING_PICKUP',
        operatorId: user.id,
        note: '出租者同意租赁',
      },
    });

    await createNotifications(tx, [{
      userId: order.renterId,
      orderId: order.id,
      type: 'RENTAL',
      title: '租赁申请已通过',
      content: `你的租赁申请已被通过，请留意取货信息。`,
    }]);
  }).catch(() => {});
  revalidatePath(`/rental-orders/${orderId}`);
}

export async function rejectRentalOrder(formData: FormData) {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const rejectReason = String(formData.get("rejectReason") ?? "");

  await prisma.$transaction(async (tx) => {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, ownerId: user.id, status: 'PENDING_APPROVAL' },
    });
    if (!order) throw new Error("订单不存在或状态不允许");

    await tx.rentalOrder.update({
      where: { id: orderId },
      data: {
        status: 'REJECTED',
        cancellationNote: rejectReason,
        cancellationReason: 'OTHER',
        cancelledById: user.id,
        cancelledAt: new Date(),
      },
    });

    await tx.rentalOrderStatusLog.create({
      data: {
        orderId,
        fromStatus: 'PENDING_APPROVAL',
        toStatus: 'REJECTED',
        operatorId: user.id,
        note: `出租者拒绝租赁: ${rejectReason}`,
      },
    });

    await createNotifications(tx, [{
      userId: order.renterId,
      orderId: order.id,
      type: 'RENTAL',
      title: '租赁申请被拒绝',
      content: `你的租赁申请被拒绝。原因：${rejectReason}`,
    }]);
  }).catch(() => {});
  revalidatePath(`/rental-orders/${orderId}`);
}

export async function confirmPickup(formData: FormData) {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const role = String(formData.get("role") ?? "");
  const currentCondition = String(formData.get("currentCondition") ?? "");
  const knownIssues = String(formData.get("knownIssues") ?? "");
  
  const files = formData.getAll("photos");
  const photos = await Promise.all(
    files.map(async (file) => {
      if (file instanceof File && file.size > 0) {
        return saveUploadedImage(file, "handover");
      }
      return null;
    })
  );
  const validPhotos = photos.filter((p): p is string => p !== null);

  await prisma.$transaction(async (tx) => {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, status: 'PENDING_PICKUP' },
      include: { handoverRecord: true },
    });
    if (!order) throw new Error("订单状态错误");
    if (role === 'owner' && order.ownerId !== user.id) throw new Error("权限错误");
    if (role === 'renter' && order.renterId !== user.id) throw new Error("权限错误");

    const dataToUpdate: Record<string, unknown> = {
      photos: validPhotos.length ? validPhotos : undefined,
      currentCondition: currentCondition || undefined,
      knownIssues: knownIssues || undefined,
    };
    if (role === 'owner') dataToUpdate.ownerConfirmed = true;
    if (role === 'renter') dataToUpdate.renterConfirmed = true;

    const newRecord = await tx.rentalHandoverRecord.upsert({
      where: { orderId },
      create: {
        orderId,
        photos: validPhotos,
        currentCondition,
        knownIssues,
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
      await tx.rentalOrderStatusLog.create({
        data: {
          orderId,
          fromStatus: 'PENDING_PICKUP',
          toStatus: 'IN_RENTAL',
          operatorId: user.id,
          note: '双方均已确认取货',
        },
      });
      await createNotifications(tx, [
        { userId: order.ownerId, orderId, type: 'RENTAL', title: '取货已完成', content: '物品已开始租赁。' },
        { userId: order.renterId, orderId, type: 'RENTAL', title: '取货已完成', content: '物品已开始租赁。' }
      ]);
    }
  }).catch(() => {});
  revalidatePath(`/rental-orders/${orderId}`);
}

export async function requestReturn(formData: FormData) {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");

  await prisma.$transaction(async (tx) => {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, renterId: user.id, status: { in: ['IN_RENTAL', 'OVERDUE', 'PICKED_UP'] } },
    });
    if (!order) throw new Error("订单状态错误");

    await tx.rentalOrder.update({
      where: { id: orderId },
      data: { status: 'PENDING_RETURN' },
    });

    await tx.rentalOrderStatusLog.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: 'PENDING_RETURN',
        operatorId: user.id,
        note: '租客发起归还请求',
      },
    });

    await createNotifications(tx, [{
      userId: order.ownerId,
      orderId: order.id,
      type: 'RENTAL',
      title: '租客请求归还',
      content: `租客已请求归还物品，请确认。`,
    }]);
  }).catch(() => {});
  revalidatePath(`/rental-orders/${orderId}`);
}

export async function confirmReturn(formData: FormData) {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const role = String(formData.get("role") ?? "");
  const hasDamage = formData.get("hasDamage") === "true";
  const needsCleaning = formData.get("needsCleaning") === "true";
  const accessoriesComplete = formData.get("accessoriesComplete") === "true";
  const inspectionNote = String(formData.get("inspectionNote") ?? "");
  
  const files = formData.getAll("photos");
  const photos = await Promise.all(
    files.map(async (file) => {
      if (file instanceof File && file.size > 0) return saveUploadedImage(file, "return");
      return null;
    })
  );
  const validPhotos = photos.filter((p): p is string => p !== null);

  await prisma.$transaction(async (tx) => {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, status: { in: ['PENDING_RETURN', 'PENDING_INSPECTION'] } },
      include: { returnRecord: true },
    });
    if (!order) throw new Error("订单状态错误");
    if (role === 'owner' && order.ownerId !== user.id) throw new Error("权限错误");
    if (role === 'renter' && order.renterId !== user.id) throw new Error("权限错误");

    const dataToUpdate: Record<string, unknown> = {
      photos: validPhotos.length ? validPhotos : undefined,
      hasDamage,
      needsCleaning,
      accessoriesComplete,
      inspectionNote: inspectionNote || undefined,
    };
    if (role === 'owner') dataToUpdate.ownerConfirmed = true;
    if (role === 'renter') dataToUpdate.renterConfirmed = true;

    if (order.returnRecord && ((role === 'owner' && order.returnRecord.ownerConfirmed) || (role === 'renter' && order.returnRecord.renterConfirmed))) {
      throw new Error("不能重复确认");
    }

    await tx.rentalReturnRecord.upsert({
      where: { orderId },
      create: {
        orderId,
        photos: validPhotos,
        hasDamage,
        needsCleaning,
        accessoriesComplete,
        inspectionNote,
        ownerConfirmed: role === 'owner',
        renterConfirmed: role === 'renter',
      },
      update: dataToUpdate,
    });

    if (role === 'owner') {
      const now = new Date();
      const nextStatus = hasDamage ? 'PENDING_INSPECTION' : 'COMPLETED';
      const depStatus = (order.depositAmount.gt(0) && nextStatus === 'COMPLETED') ? 'PENDING_REFUND' : order.depositStatus;

      await tx.rentalOrder.update({
        where: { id: orderId },
        data: {
          actualReturnTime: now,
          status: nextStatus,
          ...(nextStatus === 'COMPLETED' ? { completedAt: now } : {}),
          depositStatus: depStatus,
        },
      });

      await tx.rentalOrderStatusLog.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: nextStatus,
          operatorId: user.id,
          note: `出租者已确认归还${hasDamage ? '，物品有损坏' : ''}`,
        },
      });

      if (nextStatus === 'COMPLETED') {
        await tx.user.update({ where: { id: order.ownerId }, data: { rentalOwnerCount: { increment: 1 } } });
        await tx.user.update({ where: { id: order.renterId }, data: { rentalRenterCount: { increment: 1 } } });
      }

      await createNotifications(tx, [{
        userId: order.renterId,
        orderId: order.id,
        type: 'RENTAL',
        title: '归还已确认',
        content: `出租者已确认物品归还。${hasDamage ? '请注意检查损坏索赔。' : ''}`,
      }]);
    }
  }).catch(() => {});
  revalidatePath(`/rental-orders/${orderId}`);
}

export async function cancelRentalOrder(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const cancellationReason = String(formData.get("cancellationReason") ?? "OTHER");
  const cancellationNote = String(formData.get("cancellationNote") ?? "");

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.rentalOrder.findFirst({ where: { id: orderId } });
    if (!order) return { error: "订单不存在" };

    let canCancel = false;
    if (order.status === 'PENDING_APPROVAL' && order.renterId === user.id) canCancel = true;
    if (order.status === 'PENDING_PICKUP' && (order.ownerId === user.id || order.renterId === user.id)) canCancel = true;

    if (!canCancel) return { error: "当前状态不允许取消" };

    await tx.rentalOrder.update({
      where: { id: orderId },
      data: {
        status: 'CANCELLED',
        cancelledById: user.id,
        cancellationReason: cancellationReason as RentalCancellationReason,
        cancellationNote,
        cancelledAt: new Date(),
      },
    });

    await tx.rentalOrderStatusLog.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: 'CANCELLED',
        operatorId: user.id,
        note: `取消原因: ${cancellationReason}`,
      },
    });

    const targetUser = order.ownerId === user.id ? order.renterId : order.ownerId;
    await createNotifications(tx, [{
      userId: targetUser,
      orderId: order.id,
      type: 'RENTAL',
      title: '订单已取消',
      content: `对方已取消订单。原因：${cancellationReason}`,
    }]);

    return { success: true };
  });

  if ('error' in result) return { success: false, message: result.error as string };
  revalidatePath(`/rental-orders/${orderId}`);
  return { success: true, message: "订单已取消" };
}

export async function requestExtension(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  
  const parsed = rentalExtensionSchema.safeParse({
    orderId: formData.get("orderId"),
    newEndTime: formData.get("newEndTime"),
  });
  if (!parsed.success) return { success: false, message: "参数错误" };
  
  const { orderId, newEndTime: endStr } = parsed.data;
  const newEndTime = new Date(endStr);

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, renterId: user.id, status: { in: ['IN_RENTAL', 'PICKED_UP'] } },
    });
    if (!order) return { error: "订单状态错误" };
    if (newEndTime <= order.endTime) return { error: "新结束时间必须晚于当前结束时间" };

    const conflict = await checkTimeConflict(tx, order.rentalListingId, order.endTime, newEndTime, order.quantity, order.id);
    if (!conflict.available) return { error: "续租时间段库存不足" };

    const additionalFee = calculateRentalAmount(order.unitPriceSnapshot, order.pricingUnitSnapshot, order.endTime, newEndTime);

    await tx.rentalExtensionRequest.create({
      data: {
        orderId,
        requesterId: user.id,
        newEndTime,
        additionalFee,
        status: 'PENDING',
      },
    });

    await createNotifications(tx, [{
      userId: order.ownerId,
      orderId: order.id,
      type: 'RENTAL',
      title: '收到续租请求',
      content: `租客请求续租物品至 ${newEndTime.toLocaleDateString()}。`,
    }]);
    return { success: true };
  });

  if ('error' in result) return { success: false, message: result.error as string };
  revalidatePath(`/rental-orders/${orderId}`);
  return { success: true, message: "已发送续租请求" };
}

export async function approveExtension(formData: FormData) {
  const user = await requireUser();
  const extensionRequestId = String(formData.get("extensionRequestId") ?? "");

  await prisma.$transaction(async (tx) => {
    const ext = await tx.rentalExtensionRequest.findFirst({
      where: { id: extensionRequestId, status: 'PENDING' },
      include: { order: true },
    });
    if (!ext || ext.order.ownerId !== user.id) throw new Error("无效请求");

    const conflict = await checkTimeConflict(tx, ext.order.rentalListingId, ext.order.endTime, ext.newEndTime, ext.order.quantity, ext.order.id);
    if (!conflict.available) throw new Error("续租时间段库存不足");

    await tx.rentalExtensionRequest.update({
      where: { id: extensionRequestId },
      data: { status: 'APPROVED' },
    });

    await tx.rentalOrder.update({
      where: { id: ext.orderId },
      data: {
        endTime: ext.newEndTime,
        finalAmount: { increment: ext.additionalFee },
      },
    });

    await tx.rentalOrderStatusLog.create({
      data: {
        orderId: ext.orderId,
        fromStatus: ext.order.status,
        toStatus: ext.order.status,
        operatorId: user.id,
        note: `出租者同意续租，新结束时间: ${ext.newEndTime.toISOString()}`,
      },
    });

    await createNotifications(tx, [{
      userId: ext.order.renterId,
      orderId: ext.orderId,
      type: 'RENTAL',
      title: '续租请求已通过',
      content: `你的续租请求已通过。`,
    }]);
  }).catch(() => {});
  revalidatePath(`/rental-orders`);
}

export async function rejectExtension(formData: FormData) {
  const user = await requireUser();
  const extensionRequestId = String(formData.get("extensionRequestId") ?? "");

  await prisma.$transaction(async (tx) => {
    const ext = await tx.rentalExtensionRequest.findFirst({
      where: { id: extensionRequestId, status: 'PENDING' },
      include: { order: true },
    });
    if (!ext || ext.order.ownerId !== user.id) throw new Error("无效请求");

    await tx.rentalExtensionRequest.update({
      where: { id: extensionRequestId },
      data: { status: 'REJECTED' },
    });

    await createNotifications(tx, [{
      userId: ext.order.renterId,
      orderId: ext.orderId,
      type: 'RENTAL',
      title: '续租请求被拒绝',
      content: `你的续租请求被拒绝。`,
    }]);
  }).catch(() => {});
  revalidatePath(`/rental-orders`);
}

export async function submitDamageClaim(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalDamageClaimSchema.safeParse({
    orderId: formData.get("orderId"),
    damageDescription: formData.get("damageDescription"),
    requestedDeduction: formData.get("requestedDeduction"),
  });
  if (!parsed.success) return { success: false, message: "参数错误" };

  const { orderId, damageDescription, requestedDeduction } = parsed.data;

  const files = formData.getAll("photos");
  const photos = await Promise.all(
    files.map(async (file) => {
      if (file instanceof File && file.size > 0) return saveUploadedImage(file, "report");
      return null;
    })
  );
  const validPhotos = photos.filter((p): p is string => p !== null);

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, ownerId: user.id, status: 'PENDING_INSPECTION' },
    });
    if (!order) return { error: "状态错误" };
    if (new Prisma.Decimal(requestedDeduction).gt(order.depositAmount)) return { error: "索赔金额不能大于押金" };

    await tx.rentalDamageClaim.create({
      data: {
        orderId,
        submittedById: user.id,
        damageDescription,
        requestedDeduction: new Prisma.Decimal(requestedDeduction),
        photos: validPhotos,
      },
    });

    await createNotifications(tx, [{
      userId: order.renterId,
      orderId: order.id,
      type: 'RENTAL',
      title: '收到损坏索赔',
      content: `出租者提交了损坏索赔请求，请尽快处理。`,
    }]);
    return { success: true };
  });

  if ('error' in result) return { success: false, message: result.error as string };
  revalidatePath(`/rental-orders/${orderId}`);
  return { success: true, message: "已提交索赔" };
}

export async function respondDamageClaim(formData: FormData) {
  const user = await requireUser();
  const claimId = String(formData.get("claimId") ?? "");
  const agreed = formData.get("agreed") === "true";
  const renterNote = String(formData.get("renterNote") ?? "");

  await prisma.$transaction(async (tx) => {
    const claim = await tx.rentalDamageClaim.findFirst({
      where: { id: claimId, resolvedAt: null },
      include: { order: true },
    });
    if (!claim || claim.order.renterId !== user.id) throw new Error("无效请求");

    await tx.rentalDamageClaim.update({
      where: { id: claimId },
      data: { renterAgreed: agreed, renterNote, resolvedAt: new Date() },
    });

    if (agreed) {
      const depStatus = 'PARTIALLY_REFUNDED'; // Simplified
      await tx.rentalOrder.update({
        where: { id: claim.orderId },
        data: {
          depositDeduction: claim.requestedDeduction,
          depositStatus: depStatus,
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });
      await tx.user.update({ where: { id: claim.order.ownerId }, data: { rentalOwnerCount: { increment: 1 } } });
      await tx.user.update({ where: { id: claim.order.renterId }, data: { rentalRenterCount: { increment: 1 } } });
    }

    await createNotifications(tx, [{
      userId: claim.order.ownerId,
      orderId: claim.orderId,
      type: 'RENTAL',
      title: agreed ? '索赔已同意' : '索赔被拒绝',
      content: `租客${agreed ? '同意' : '拒绝'}了损坏索赔。`,
    }]);
  }).catch(() => {});
  revalidatePath(`/rental-orders`);
}

export async function initiateDispute(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  
  const files = formData.getAll("evidencePhotos");
  const photos = await Promise.all(
    files.map(async (file) => {
      if (file instanceof File && file.size > 0) return saveUploadedImage(file, "report");
      return null;
    })
  );
  const evidencePhotos = photos.filter((p): p is string => p !== null);

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, OR: [{ ownerId: user.id }, { renterId: user.id }] },
    });
    if (!order) return { error: "无效请求" };

    const validStatuses = ['IN_RENTAL', 'PENDING_RETURN', 'PENDING_INSPECTION', 'COMPLETED', 'PICKED_UP'];
    if (!validStatuses.includes(order.status)) return { error: "状态不允许纠纷" };

    await tx.rentalDispute.create({
      data: {
        orderId,
        initiatorId: user.id,
        reason,
        evidencePhotos,
        status: 'OPEN',
      },
    });

    await tx.rentalOrder.update({
      where: { id: orderId },
      data: { status: 'IN_DISPUTE' },
    });

    await tx.rentalOrderStatusLog.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: 'IN_DISPUTE',
        operatorId: user.id,
        note: `发起纠纷: ${reason}`,
      },
    });

    const targetUser = order.ownerId === user.id ? order.renterId : order.ownerId;
    await createNotifications(tx, [{
      userId: targetUser,
      orderId: order.id,
      type: 'RENTAL',
      title: '发生订单纠纷',
      content: `对方对订单发起了纠纷。`,
    }]);
    return { success: true };
  });

  if ('error' in result) return { success: false, message: result.error as string };
  revalidatePath(`/rental-orders/${orderId}`);
  return { success: true, message: "已发起纠纷" };
}

export async function submitRentalReview(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalReviewSchema.safeParse({
    orderId: formData.get("orderId"),
    overallRating: formData.get("overallRating"),
    content: formData.get("content"),
    itemMatchDesc: formData.get("itemMatchDesc"),
  });
  
  if (!parsed.success) return { success: false, message: "参数错误" };
  const { orderId, overallRating, content } = parsed.data;

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, status: 'COMPLETED', OR: [{ ownerId: user.id }, { renterId: user.id }] },
    });
    if (!order) return { error: "订单状态错误" };

    const exist = await tx.rentalReview.findFirst({ where: { orderId, authorId: user.id } });
    if (exist) return { error: "已经评价过" };

    const targetUserId = user.id === order.renterId ? order.ownerId : order.renterId;

    await tx.rentalReview.create({
      data: {
        orderId,
        authorId: user.id,
        targetUserId,
        overallRating,
        content: content || null,
        tags: [],
      },
    });

    if (overallRating >= 4) {
      // Simplistic update
      await tx.user.update({
        where: { id: targetUserId },
        data: { rentalPositiveRate: { increment: 1 } },
      });
    }

    await createNotifications(tx, [{
      userId: targetUserId,
      orderId: order.id,
      type: 'RENTAL',
      title: '收到新评价',
      content: `对方已对订单进行了评价。`,
    }]);
    return { success: true };
  });

  if ('error' in result) return { success: false, message: result.error as string };
  revalidatePath(`/rental-orders/${orderId}`);
  return { success: true, message: "评价成功" };
}
