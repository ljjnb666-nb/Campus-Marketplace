"use server";

import { withTransaction } from "@/lib/prisma";
import type { AssetCategory, Prisma } from "@prisma/client";
import { readOrderOriginCookie, clearOrderOriginCookie } from "@/lib/analytics/order-origin-cookie";
import { logger } from "@/lib/logger";
import { validateUploadBatch, mapUploadsWithConcurrency } from "@/lib/upload-batch";
import { parseMarketplaceDateTimeLocal } from "@/lib/marketplace-time";
import { isGovernanceError } from "@/lib/governance/domain-errors";
import { isEnforcementError } from "@/lib/enforcement/errors";
import { NewActivityDisabledError } from "@/lib/feature-flags/feature-flag-guard";
import { isRbacError } from "@/lib/rbac/errors";
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
  completeRentalInspectionTx,
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
  AssetServiceError,
  attachAssetsToEntity,
  buildAssetReference,
  isImageValidationError,
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

/** R08: unzoned browser datetime-local always means the campus Asia/Shanghai wall clock.
 * Zoned legacy callers remain compatible but must also pass strict calendar validation.
 * Node Date.parse silently normalizes invalid days such as 2026-02-30, so reject them
 * before accepting a zoned ISO timestamp.
 */
function parseRentalDateInput(value: string): Date | null {
  const input = value.trim();
  const campusWallTime = parseMarketplaceDateTimeLocal(input);
  if (campusWallTime) return campusWallTime;

  const zoned = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(input);
  if (!zoned) return null;
  const campusCalendar = [zoned[1], zoned[2], zoned[3]].join("-") +
    "T" + zoned[4] + ":" + zoned[5] + ":" + (zoned[6] ?? "00");
  if (!parseMarketplaceDateTimeLocal(campusCalendar)) return null;
  const zone = zoned[8].toUpperCase();
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) {
    return null;
  }
  const explicit = new Date(input);
  return Number.isFinite(explicit.getTime()) ? explicit : null;
}

export type RentalOrderActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};

/**
 * 上传订单相关私有照片（handover / return / report）。
 * 服务端强制 maxCount；返回 asset: 引用（禁止永久公开 URL），
 * 上传先完成，业务引用与 UploadedAsset 绑定随后在同一事务提交。
 */
async function uploadOrderPhotos(
  files: FormDataEntryValue[],
  scope: "handover" | "return" | "report",
  ownerId: string,
): Promise<string[]> {
  const limits = UPLOAD_LIMITS[scope];
  // R09：浏览器先经独立 /api/upload/images 上传单文件，再把小型 asset:
  // token 发给 Server Action。旧的小文件 action 调用保留兼容，但不能绕过
  // token 的事务内 ownership/category/access 验证。
  const submitted = files.filter((value) => !(value instanceof File && value.size === 0));
  if (submitted.length > limits.maxCount) {
    throw new AssetServiceError("TOO_MANY_FILES", `最多上传${limits.maxCount}张图片`);
  }
  validateUploadBatch(submitted, scope);
  return mapUploadsWithConcurrency(submitted, async (value) => {
    if (typeof value === "string") {
      if (!parseAssetReference(value)) {
        throw new AssetServiceError("INVALID_ASSET_REFERENCE", "照片引用无效，请重新上传");
      }
      return value;
    }
    const result = await uploadImageAsset({ userId: ownerId, category: scope, file: value });
    return buildAssetReference(result.assetId);
  });
}

/** R10：照片引用与 ATTACHED 状态必须属于同一数据库事务。 */
async function attachOrderPhotos(
  tx: Prisma.TransactionClient, ownerId: string, orderId: string,
  tokens: string[], scope: "handover" | "return" | "report",
): Promise<void> {
  const assetIds = tokens.map((token) => parseAssetReference(token));
  if (assetIds.some((id) => !id) || new Set(assetIds).size !== tokens.length) {
    throw new AssetServiceError("INVALID_ASSET_REFERENCE", "照片引用无效，请重新上传");
  }
  if (assetIds.length === 0) return;
  const ids = assetIds as string[];
  // 同一业务事务内验证各资产的 owner、类目、私有访问级别与 UPLOADED
  // 状态；客户端 token 不具备独立授权，不得跨类/跨租户资产挪用。
  const rows = await tx.uploadedAsset.findMany({
    where: {
      id: { in: ids }, ownerId, status: "UPLOADED",
      category: scope.toUpperCase() as AssetCategory, access: "PRIVATE",
    },
    select: { id: true },
  });
  if (rows.length !== ids.length) {
    throw new AssetServiceError("ASSET_BIND_CONFLICT", "照片状态已变化，请重新上传");
  }
  const attached = await attachAssetsToEntity(tx, {
    ownerId,
    assetIds: ids,
    target: { type: "rentalOrder", id: orderId },
  });
  // 抛错而非返回错误：强制回滚同一 tx 内已写入的交接/索赔/纠纷引用。
  // UPLOADED 数量不足代表过期、被删除或已被另一请求占用，不能成功提交。
  if (attached !== ids.length) {
    throw new AssetServiceError("ASSET_BIND_CONFLICT", "照片状态已变化，请重新上传");
  }
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

  const startTime = parseRentalDateInput(parsed.data.startTime);
  const endTime = parseRentalDateInput(parsed.data.endTime);
  const quantity = Number(parsed.data.quantity);

  if (!startTime || !endTime) {
    return { success: false, message: '时间格式不正确' };
  }
  if (startTime >= endTime) {
    return { success: false, message: '开始时间必须早于结束时间' };
  }

  try {
    const sourceToken = await readOrderOriginCookie();
    const result = await withTransaction((tx) =>
      createRentalOrderTx(tx, {
        userId: user.id,
        rentalListingId: parsed.data.rentalListingId,
        startTime,
        endTime,
        quantity,
        renterNote: parsed.data.renterNote,
        ...(sourceToken ? { attributionSourceToken: sourceToken } : {}),
      }),
    );

    if ('error' in result) return { success: false, message: result.error as string };

    if (sourceToken) await clearOrderOriginCookie();
    revalidateRentalOrderCreationViews();

    return { success: true, message: '租赁申请已提交', redirectTo: `/rental-orders/${result.orderId}` };
  } catch (error) {
    // 参与方/能力门域错误（Phase 5/6A/6B/6C-3）返回安全 userMessage：
    // GOVERNANCE_SUBJECT_INACTIVE / AUTH_ACCOUNT_INACTIVE / MEMBERSHIP_NOT_ACTIVE /
    // MARKETPLACE_RESTRICTED / MARKETPLACE_COUNTERPARTY_UNAVAILABLE
    if (isGovernanceError(error) || isRbacError(error) || isEnforcementError(error) || error instanceof NewActivityDisabledError) {
      return { success: false, message: error.message };
    }

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

    const result = await withTransaction(async (tx) => {
      const outcome = await confirmPickupTx(tx, {
        orderId, userId: user.id, role, photos: photoTokens, currentCondition, knownIssues,
      });
      if ("error" in outcome) return outcome;
      await attachOrderPhotos(tx, user.id, orderId, photoTokens, "handover");
      return outcome;
    });
    if ("error" in result) return { success: false, message: result.error as string };

    // 私有照片属于订单证据；本次 FormData 不包含某张历史照片，
    // 不代表数据库或纠纷/索赔已不再引用它。禁止在确认动作中抢先
    // PENDING_DELETE；历史资产只能由引用/hold-aware 的 retention 管理。
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
    hasDamage: formData.get("hasDamage"),
    needsCleaning: formData.get("needsCleaning"),
    accessoriesComplete: formData.get("accessoriesComplete"),
  });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }
  const { orderId, role, inspectionNote, hasDamage, needsCleaning, accessoriesComplete } = parsed.data;

  try {
    const photoTokens = await uploadOrderPhotos(formData.getAll("photos"), "return", user.id);

    const result = await withTransaction(async (tx) => {
      const outcome = await confirmReturnTx(tx, {
        orderId, userId: user.id, role, photos: photoTokens,
        hasDamage, needsCleaning, accessoriesComplete, inspectionNote,
      });
      if ("error" in outcome) return outcome;
      await attachOrderPhotos(tx, user.id, orderId, photoTokens, "return");
      return outcome;
    });
    if ("error" in result) return { success: false, message: result.error as string };

    // 私有照片属于订单证据；本次 FormData 不包含某张历史照片，
    // 不代表数据库或纠纷/索赔已不再引用它。禁止在确认动作中抢先
    // PENDING_DELETE；历史资产只能由引用/hold-aware 的 retention 管理。
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

export async function completeRentalInspection(formData: FormData): Promise<RentalOrderActionState> {
  const user = await requireUser();
  const parsed = rentalOrderIdSchema.safeParse({ orderId: formData.get("orderId") });
  if (!parsed.success) return { success: false, message: "订单不存在" };
  try {
    const result = await withTransaction(tx => completeRentalInspectionTx(tx, {
      orderId: parsed.data.orderId, userId: user.id,
    }));
    if ('error' in result) return { success: false, message: result.error };
    revalidateRentalOrderViews(parsed.data.orderId);
    return { success: true, message: "验收已结束；线下款项请双方自行核对" };
  } catch (error) {
    logger.error("rental-order action failed", "rental-order", { action: "completeRentalInspection", error });
    return { success: false, message: "结束验收失败，请重试" };
  }
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
  const newEndTime = parseRentalDateInput(endStr);
  if (!newEndTime) return { success: false, message: "时间格式不正确" };

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

    const result = await withTransaction(async (tx) => {
      const outcome = await submitDamageClaimTx(tx, {
        orderId, userId: user.id, damageDescription, requestedDeduction, photos: photoTokens,
      });
      if ("error" in outcome) return outcome;
      await attachOrderPhotos(tx, user.id, orderId, photoTokens, "report");
      return outcome;
    });
    if ("error" in result) return { success: false, message: result.error as string };
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

    const result = await withTransaction(async (tx) => {
      const outcome = await initiateDisputeTx(tx, {
        orderId, userId: user.id, reason, evidencePhotos: evidenceTokens,
      });
      if ("error" in outcome) return outcome;
      await attachOrderPhotos(tx, user.id, orderId, evidenceTokens, "report");
      return outcome;
    });
    if ("error" in result) return { success: false, message: result.error as string };
  } catch (error) {
    if (error instanceof NewActivityDisabledError) {
      return { success: false, message: error.message };
    }
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
