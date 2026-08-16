"use server";

import { prisma } from "@/lib/prisma";
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
import { saveUploadedImage } from "@/lib/upload";
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

async function saveFormPhotos(files: FormDataEntryValue[], scope: "handover" | "return" | "report") {
  const photos = await Promise.all(
    files.map(async (file) => {
      if (file instanceof File && file.size > 0) {
        return saveUploadedImage(file, scope);
      }
      return null;
    })
  );
  return photos.filter((p): p is string => p !== null);
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
    const result = await prisma.$transaction((tx) =>
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
    console.error("createRentalOrder failed:", error);
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
    const result = await prisma.$transaction((tx) => approveRentalOrderTx(tx, { orderId, userId: user.id }));
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("approveRentalOrder failed:", error);
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
    const result = await prisma.$transaction((tx) =>
      rejectRentalOrderTx(tx, { orderId, userId: user.id, rejectReason }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("rejectRentalOrder failed:", error);
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

  const validPhotos = await saveFormPhotos(formData.getAll("photos"), "handover");

  try {
    const result = await prisma.$transaction((tx) =>
      confirmPickupTx(tx, {
        orderId,
        userId: user.id,
        role,
        photos: validPhotos,
        currentCondition,
        knownIssues,
      }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("confirmPickup failed:", error);
    return { success: false, message: "操作失败，请稍后重试" };
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
    const result = await prisma.$transaction((tx) => requestReturnTx(tx, { orderId, userId: user.id }));
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("requestReturn failed:", error);
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

  const validPhotos = await saveFormPhotos(formData.getAll("photos"), "return");

  try {
    const result = await prisma.$transaction((tx) =>
      confirmReturnTx(tx, {
        orderId,
        userId: user.id,
        role,
        photos: validPhotos,
        hasDamage,
        needsCleaning,
        accessoriesComplete,
        inspectionNote,
      }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("confirmReturn failed:", error);
    return { success: false, message: "操作失败，请稍后重试" };
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
    const result = await prisma.$transaction((tx) =>
      cancelRentalOrderTx(tx, { orderId, userId: user.id, cancellationReason, cancellationNote }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("cancelRentalOrder failed:", error);
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
    const result = await prisma.$transaction((tx) =>
      requestExtensionTx(tx, { orderId, userId: user.id, newEndTime }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("requestExtension failed:", error);
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
    const result = await prisma.$transaction((tx) =>
      approveExtensionTx(tx, { extensionRequestId, userId: user.id }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("approveExtension failed:", error);
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
    const result = await prisma.$transaction((tx) =>
      rejectExtensionTx(tx, { extensionRequestId, userId: user.id }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("rejectExtension failed:", error);
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

  const validPhotos = await saveFormPhotos(formData.getAll("photos"), "report");

  try {
    const result = await prisma.$transaction((tx) =>
      submitDamageClaimTx(tx, {
        orderId,
        userId: user.id,
        damageDescription,
        requestedDeduction,
        photos: validPhotos,
      }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("submitDamageClaim failed:", error);
    return { success: false, message: "提交索赔失败，请稍后重试" };
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
    const result = await prisma.$transaction((tx) =>
      respondDamageClaimTx(tx, { claimId, userId: user.id, agreed, renterNote }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("respondDamageClaim failed:", error);
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

  const evidencePhotos = await saveFormPhotos(formData.getAll("evidencePhotos"), "report");

  try {
    const result = await prisma.$transaction((tx) =>
      initiateDisputeTx(tx, { orderId, userId: user.id, reason, evidencePhotos }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("initiateDispute failed:", error);
    return { success: false, message: "发起纠纷失败，请稍后重试" };
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
    const result = await prisma.$transaction((tx) =>
      submitRentalReviewTx(tx, { orderId, userId: user.id, overallRating, content }),
    );
    if ('error' in result) return { success: false, message: result.error as string };
  } catch (error) {
    console.error("submitRentalReview failed:", error);
    return { success: false, message: "提交评价失败，请稍后重试" };
  }

  revalidateRentalOrderViews(orderId);
  return { success: true, message: "评价成功" };
}
