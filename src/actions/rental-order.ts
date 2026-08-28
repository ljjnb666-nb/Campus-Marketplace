"use server";

import { withTransaction, prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireUser } from "@/lib/server-auth";
import {
  revalidateRentalOrderCreationViews,
  revalidateRentalOrderListViews,
  revalidateRentalOrderViews,
} from "@/lib/revalidate";
import {
  approveExtensionTx,
  approveRentalOrderTx,
  cancelRentalOrderTx,
  confirmPickupTx,
  confirmReturnTx,
  createRentalOrderTx,
  initiateDisputeTx,
  rejectExtensionTx,
  rejectRentalOrderTx,
  requestExtensionTx,
  requestReturnTx,
  respondDamageClaimTx,
  submitDamageClaimTx,
  submitRentalReviewTx,
} from "@/lib/rental-order-machine";
import {
  asAssetTx,
  AssetServiceError,
  attachAssetsToEntity,
  buildAssetReference,
  isImageValidationError,
  markAssetsForValuesPendingDelete,
  parseAssetReference,
  uploadImageAsset,
  UPLOAD_LIMITS,
} from "@/lib/upload";
import {
  rentalCancelSchema,
  rentalDamageClaimRespondSchema,
  rentalDamageClaimSchema,
  rentalDisputeSchema,
  rentalExtensionRequestIdSchema,
  rentalExtensionSchema,
  rentalOrderIdSchema,
  rentalPickupConfirmSchema,
  rentalRejectSchema,
  rentalReturnConfirmSchema,
  rentalReviewSchema,
  rentalOrderCreateSchema,
} from "@/validators/rental";

export type RentalOrderActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};

/**
 * 上传订单相关私有照片（handover / return / report）。
 * 服务端强制 maxCount；返回 asset: 引用（禁止永久公开 URL），
 * 订单事务成功后再 attach 到 RentalOrder，失败则由 orphan cleanup 回收。
 */
async function uploadOrderPhotos(
  files: FormDataEntryValue[],
  scope: "handover" | "return" | "report",
  ownerId: string,
): Promise<string[]> {
  const limits = UPLOAD_LIMITS[scope];
  const validFiles = files.filter((file): file is File => file instanceof File && file.size > 0);

  if (validFiles.length > limits.maxCount) {
    throw new AssetServiceError("TOO_MANY_FILES", `最多上传${limits.maxCount}张图片`);
  }

  return Promise.all(
    validFiles.map(async (file) => {
      const result = await uploadImageAsset({ userId: ownerId, category: scope, file });
      return buildAssetReference(result.assetId);
    }),
  );
}

/** 事务成功后将照片资源绑定到订单（幂等；失败留待 orphan cleanup 回收） */
async function attachOrderPhotos(ownerId: string, orderId: string, tokens: string[]): Promise<void> {
  const assetIds = tokens
    .map((token) => parseAssetReference(token))
    .filter((id): id is string => id !== null);
  if (assetIds.length === 0) return;
  await attachAssetsToEntity(asAssetTx(prisma), {
    ownerId,
    assetIds,
    target: { type: "rentalOrder", id: orderId },
  });
}

function photoUploadErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AssetServiceError) return error.message;
  if (isImageValidationError(error)) return error.message;
  return fallback;
}

export async function createRentalOrder(_prevState: RentalOrderActionState, formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();

  const parsed = rentalOrderCreateSchema.safeParse({
    rentalListingId: formData.get('rentalListingId'),
    startTime: formData.get('startTime'),
    endTime: formData.get('endTime'),
    quantity: formData.get('quantity') ?? '1',
    renterNote: formData.get('renterNote') ?? undefined,
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

  try {
    const result = await withTransaction((tx) =>
      createRentalOrderTx(tx, {
        userId: user.id,
        rentalListingId: parsed.data.rentalListingId,
        startTime,
        endTime,
        quantity,
        renterNote: parsed.data.renterNote,
      }),
    );

    if ('error' in result) return { success: false, message: result.error as string };

    revalidateRentalOrderCreationViews();

    return { success: true, message: '租赁申请已提交', redirectTo: `/rental-orders/${result.orderId}` };
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "createRentalOrder", error });
    return { success: false, message: '提交租赁申请失败，请稍后重试' };
  }
}

export async function approveRentalOrder(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalOrderIdSchema.safeParse({ orderId: formData.get("orderId") ?? "" });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }
  const orderId = parsed.data.orderId;

  try {
    const result = await withTransaction((tx) => approveRentalOrderTx(tx, { orderId, userId: user.id }));
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "approveRentalOrder", error });
    return { success: false, message: "操作失败，请稍后重试" };
  }

  revalidateRentalOrderViews(orderId);
  return { success: true, message: "已同意租赁申请" };
}

export async function rejectRentalOrder(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalRejectSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    rejectReason: formData.get("rejectReason") ?? undefined,
  });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }
  const { orderId } = parsed.data;
  const rejectReason = parsed.data.rejectReason ?? "";

  try {
    const result = await withTransaction((tx) =>
      rejectRentalOrderTx(tx, { orderId, userId: user.id, rejectReason }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "rejectRentalOrder", error });
    return { success: false, message: "操作失败，请稍后重试" };
  }

  revalidateRentalOrderViews(orderId);
  return { success: true, message: "已拒绝租赁申请" };
}

export async function confirmPickup(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalPickupConfirmSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    role: formData.get("role") ?? "",
    currentCondition: formData.get("currentCondition") ?? undefined,
    knownIssues: formData.get("knownIssues") ?? undefined,
  });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }
  const { orderId, role, currentCondition, knownIssues } = parsed.data;

  try {
    const photoTokens = await uploadOrderPhotos(formData.getAll("photos"), "handover", user.id);

    const previousRecord = await prisma.rentalHandoverRecord.findUnique({
      where: { orderId },
      select: { photos: true },
    });

    const result = await withTransaction((tx) =>
      confirmPickupTx(tx, {
        orderId,
        userId: user.id,
        role,
        photos: photoTokens,
        currentCondition,
        knownIssues,
      }),
    );
    if ('error' in result) return { success: false, message: result.error as string };

    await attachOrderPhotos(user.id, orderId, photoTokens);

    // 再次确认时被替换的旧照片标记待删除
    if (previousRecord) {
      const removed = previousRecord.photos.filter((p) => !photoTokens.includes(p));
      if (removed.length > 0) {
        await markAssetsForValuesPendingDelete(user.id, removed).catch(() => undefined);
      }
    }
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "confirmPickup", error });
    return {
      success: false,
      message: photoUploadErrorMessage(error, "操作失败，请稍后重试"),
    };
  }

  revalidateRentalOrderViews(orderId);
  return { success: true, message: "已确认取货" };
}

export async function requestReturn(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalOrderIdSchema.safeParse({ orderId: formData.get("orderId") ?? "" });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }
  const orderId = parsed.data.orderId;

  try {
    const result = await withTransaction((tx) => requestReturnTx(tx, { orderId, userId: user.id }));
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "requestReturn", error });
    return { success: false, message: "操作失败，请稍后重试" };
  }

  revalidateRentalOrderViews(orderId);
  return { success: true, message: "已提交归还请求" };
}

export async function confirmReturn(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalReturnConfirmSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    role: formData.get("role") ?? "",
    inspectionNote: formData.get("inspectionNote") ?? undefined,
  });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }
  const { orderId, role, inspectionNote } = parsed.data;
  const hasDamage = formData.get("hasDamage") === "true";
  const needsCleaning = formData.get("needsCleaning") === "true";
  const accessoriesComplete = formData.get("accessoriesComplete") === "true";

  try {
    const photoTokens = await uploadOrderPhotos(formData.getAll("photos"), "return", user.id);

    const previousRecord = await prisma.rentalReturnRecord.findUnique({
      where: { orderId },
      select: { photos: true },
    });

    const result = await withTransaction((tx) =>
      confirmReturnTx(tx, {
        orderId,
        userId: user.id,
        role,
        photos: photoTokens,
        hasDamage,
        needsCleaning,
        accessoriesComplete,
        inspectionNote,
      }),
    );
    if ('error' in result) return { success: false, message: result.error as string };

    await attachOrderPhotos(user.id, orderId, photoTokens);

    // 再次确认时被替换的旧照片标记待删除
    if (previousRecord) {
      const removed = previousRecord.photos.filter((p) => !photoTokens.includes(p));
      if (removed.length > 0) {
        await markAssetsForValuesPendingDelete(user.id, removed).catch(() => undefined);
      }
    }
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "confirmReturn", error });
    return {
      success: false,
      message: photoUploadErrorMessage(error, "操作失败，请稍后重试"),
    };
  }

  revalidateRentalOrderViews(orderId);
  return { success: true, message: "已确认归还" };
}

export async function cancelRentalOrder(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalCancelSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    cancellationReason: formData.get("cancellationReason") ?? "OTHER",
    cancellationNote: formData.get("cancellationNote") ?? undefined,
  });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }
  const { orderId, cancellationReason, cancellationNote } = parsed.data;

  try {
    const result = await withTransaction((tx) =>
      cancelRentalOrderTx(tx, { orderId, userId: user.id, cancellationReason, cancellationNote }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "cancelRentalOrder", error });
    return { success: false, message: "取消订单失败，请稍后重试" };
  }

  revalidateRentalOrderViews(orderId);
  return { success: true, message: "订单已取消" };
}

export async function requestExtension(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();

  const parsed = rentalExtensionSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    newEndTime: formData.get("newEndTime"),
  });
  if (!parsed.success) return { success: false, message: "参数错误" };

  const { orderId, newEndTime: endStr } = parsed.data;
  const newEndTime = new Date(endStr);

  try {
    const result = await withTransaction((tx) =>
      requestExtensionTx(tx, { orderId, userId: user.id, newEndTime }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "requestExtension", error });
    return { success: false, message: "提交续租请求失败，请稍后重试" };
  }

  revalidateRentalOrderViews(orderId);
  return { success: true, message: "已发送续租请求" };
}

export async function approveExtension(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalExtensionRequestIdSchema.safeParse({
    extensionRequestId: formData.get("extensionRequestId") ?? "",
  });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }
  const extensionRequestId = parsed.data.extensionRequestId;

  try {
    const result = await withTransaction((tx) =>
      approveExtensionTx(tx, { extensionRequestId, userId: user.id }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "approveExtension", error });
    return { success: false, message: "操作失败，请稍后重试" };
  }

  revalidateRentalOrderListViews();
  return { success: true, message: "已同意续租请求" };
}

export async function rejectExtension(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalExtensionRequestIdSchema.safeParse({
    extensionRequestId: formData.get("extensionRequestId") ?? "",
  });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }
  const extensionRequestId = parsed.data.extensionRequestId;

  try {
    const result = await withTransaction((tx) =>
      rejectExtensionTx(tx, { extensionRequestId, userId: user.id }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "rejectExtension", error });
    return { success: false, message: "操作失败，请稍后重试" };
  }

  revalidateRentalOrderListViews();
  return { success: true, message: "已拒绝续租请求" };
}

export async function submitDamageClaim(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalDamageClaimSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    damageDescription: formData.get("damageDescription"),
    requestedDeduction: formData.get("requestedDeduction"),
  });
  if (!parsed.success) return { success: false, message: parsed.error.issues[0]?.message ?? "参数错误" };

  const { orderId, damageDescription, requestedDeduction } = parsed.data;

  try {
    const photoTokens = await uploadOrderPhotos(formData.getAll("photos"), "report", user.id);

    const result = await withTransaction((tx) =>
      submitDamageClaimTx(tx, {
        orderId,
        userId: user.id,
        damageDescription,
        requestedDeduction,
        photos: photoTokens,
      }),
    );
    if ('error' in result) return { success: false, message: result.error as string };

    await attachOrderPhotos(user.id, orderId, photoTokens);
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "submitDamageClaim", error });
    return {
      success: false,
      message: photoUploadErrorMessage(error, "提交索赔失败，请稍后重试"),
    };
  }

  revalidateRentalOrderViews(orderId);
  return { success: true, message: "已提交索赔" };
}

export async function respondDamageClaim(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalDamageClaimRespondSchema.safeParse({
    claimId: formData.get("claimId") ?? "",
    agreed: formData.get("agreed") ?? "",
    renterNote: formData.get("renterNote") ?? undefined,
  });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }
  const { claimId, agreed, renterNote } = parsed.data;

  try {
    const result = await withTransaction((tx) =>
      respondDamageClaimTx(tx, { claimId, userId: user.id, agreed, renterNote }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "respondDamageClaim", error });
    return { success: false, message: "操作失败，请稍后重试" };
  }

  revalidateRentalOrderListViews();
  return { success: true, message: agreed ? "已同意索赔" : "已拒绝索赔" };
}

export async function initiateDispute(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalDisputeSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }
  const { orderId, reason } = parsed.data;

  try {
    const evidenceTokens = await uploadOrderPhotos(formData.getAll("evidencePhotos"), "report", user.id);

    const result = await withTransaction((tx) =>
      initiateDisputeTx(tx, { orderId, userId: user.id, reason, evidencePhotos: evidenceTokens }),
    );
    if ('error' in result) return { success: false, message: result.error as string };

    await attachOrderPhotos(user.id, orderId, evidenceTokens);
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "initiateDispute", error });
    return {
      success: false,
      message: photoUploadErrorMessage(error, "发起纠纷失败，请稍后重试"),
    };
  }

  revalidateRentalOrderViews(orderId);
  return { success: true, message: "已发起纠纷" };
}

export async function submitRentalReview(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalReviewSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    overallRating: formData.get("overallRating"),
    content: formData.get("content") ?? undefined,
    itemMatchDesc: formData.get("itemMatchDesc") ?? undefined,
  });

  if (!parsed.success) return { success: false, message: "参数错误" };
  const { orderId, overallRating, content } = parsed.data;

  try {
    const result = await withTransaction((tx) =>
      submitRentalReviewTx(tx, { orderId, userId: user.id, overallRating, content }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "submitRentalReview", error });
    return { success: false, message: "提交评价失败，请稍后重试" };
  }

  revalidateRentalOrderViews(orderId);
  return { success: true, message: "评价成功" };
}
