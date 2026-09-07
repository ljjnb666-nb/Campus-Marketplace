"use server";

import { revalidatePath } from "next/cache";
import { actionErrorMessage } from "@/lib/error-handler";
import { prisma, withTransaction } from "@/lib/prisma";
import { resetModerationKeywordCache } from "@/lib/moderation";
import { requireAdmin } from "@/lib/server-auth";
import { decideMembershipVerification } from "@/lib/campus/verification-service";
import { suspendAccount, reinstateAccount } from "@/lib/enforcement/account-enforcement-service";
import { applyReportReviewTx } from "@/lib/enforcement/report-projection";
import { createNotification } from "@/repositories/notification-repository";
import {
  categoryFormSchema,
  categoryStatusSchema,
  moderateListingSchema,
  moderationKeywordSchema,
  moderationKeywordStatusSchema,
  reportReviewSchema,
  toggleUserStatusSchema,
  verificationReviewSchema,
} from "@/validators/admin";

export type AdminActionState = {
  success: boolean;
  error?: string;
};

function invalidFormState(): AdminActionState {
  return { success: false, error: "参数无效" };
}

type CategoryKind = "PRODUCT" | "ERRAND" | "SERVICE";

type CategoryPayload = {
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
};

type CategoryTable = {
  create(args: { data: CategoryPayload }): Promise<unknown>;
  update(args: {
    where: { id: string };
    data: CategoryPayload | { isActive: boolean };
  }): Promise<unknown>;
};

const categoryTables: Record<CategoryKind, CategoryTable> = {
  PRODUCT: prisma.productCategory,
  ERRAND: prisma.errandCategory,
  SERVICE: prisma.serviceCategory,
};

const categoryListingPaths: Record<CategoryKind, string> = {
  PRODUCT: "/products",
  ERRAND: "/errands",
  SERVICE: "/services",
};

function readCategoryForm(formData: FormData) {
  return {
    categoryId: formData.get("categoryId") || undefined,
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: formData.get("description") || "",
    sortOrder: formData.get("sortOrder"),
    isActive: formData.get("isActive"),
  };
}

async function upsertCategory(
  kind: CategoryKind,
  formData: FormData,
): Promise<AdminActionState | undefined> {
  try {
    const admin = await requireAdmin();
    const parsed = categoryFormSchema.safeParse(readCategoryForm(formData));

    if (!parsed.success) {
      return invalidFormState();
    }

    const { categoryId, name, slug, description, sortOrder, isActive } = parsed.data;
    const payload: CategoryPayload = {
      name,
      slug,
      description: description || null,
      sortOrder,
      isActive,
    };

    if (categoryId) {
      await categoryTables[kind].update({ where: { id: categoryId }, data: payload });
    } else {
      await categoryTables[kind].create({ data: payload });
    }

    await prisma.adminLog.create({
      data: {
        adminId: admin.id,
        action: categoryId ? `UPDATE_${kind}_CATEGORY` : `CREATE_${kind}_CATEGORY`,
        targetType: `${kind}_CATEGORY`,
        targetId: categoryId ?? slug,
        detail: name,
      },
    });

    revalidatePath("/admin/categories");
    revalidatePath(categoryListingPaths[kind]);
  } catch (error) {
    return { success: false, error: actionErrorMessage(error, `upsertCategory:${kind}`) };
  }
}

async function toggleCategoryStatus(
  kind: CategoryKind,
  formData: FormData,
): Promise<AdminActionState | undefined> {
  try {
    const admin = await requireAdmin();
    const parsed = categoryStatusSchema.safeParse({
      categoryId: formData.get("categoryId"),
      isActive: formData.get("isActive"),
    });

    if (!parsed.success) {
      return invalidFormState();
    }

    await categoryTables[kind].update({
      where: { id: parsed.data.categoryId },
      data: { isActive: parsed.data.isActive },
    });

    await prisma.adminLog.create({
      data: {
        adminId: admin.id,
        action: parsed.data.isActive ? `ENABLE_${kind}_CATEGORY` : `DISABLE_${kind}_CATEGORY`,
        targetType: `${kind}_CATEGORY`,
        targetId: parsed.data.categoryId,
      },
    });

    revalidatePath("/admin/categories");
    revalidatePath(categoryListingPaths[kind]);
  } catch (error) {
    return { success: false, error: actionErrorMessage(error, `toggleCategoryStatus:${kind}`) };
  }
}

export async function upsertProductCategory(
  formData: FormData,
): Promise<AdminActionState | undefined> {
  return upsertCategory("PRODUCT", formData);
}

export async function toggleProductCategoryStatus(
  formData: FormData,
): Promise<AdminActionState | undefined> {
  return toggleCategoryStatus("PRODUCT", formData);
}

export async function upsertErrandCategory(
  formData: FormData,
): Promise<AdminActionState | undefined> {
  return upsertCategory("ERRAND", formData);
}

export async function toggleErrandCategoryStatus(
  formData: FormData,
): Promise<AdminActionState | undefined> {
  return toggleCategoryStatus("ERRAND", formData);
}

export async function upsertServiceCategory(
  formData: FormData,
): Promise<AdminActionState | undefined> {
  return upsertCategory("SERVICE", formData);
}

export async function toggleServiceCategoryStatus(
  formData: FormData,
): Promise<AdminActionState | undefined> {
  return toggleCategoryStatus("SERVICE", formData);
}

function getReportNotificationCopy(status: "IN_REVIEW" | "RESOLVED" | "REJECTED", handledNote?: string) {
  if (status === "IN_REVIEW") {
    return {
      title: "举报处理中",
      content: handledNote
        ? `你提交的举报正在处理中。处理说明：${handledNote}`
        : "你提交的举报正在处理中，平台会在核查完成后通知你结果。",
    };
  }

  if (status === "RESOLVED") {
    return {
      title: "举报已处理",
      content: `你提交的举报已处理完成。${handledNote ? `处理说明：${handledNote}` : ""}`,
    };
  }

  return {
    title: "举报处理结果已更新",
    content: `你提交的举报未通过。${
      handledNote ? `处理说明：${handledNote}` : "如有需要可补充更完整的信息后再次提交。"
    }`,
  };
}

export async function reviewVerification(
  formData: FormData,
): Promise<AdminActionState | undefined> {
  try {
    const admin = await requireAdmin();

    const parsed = verificationReviewSchema.safeParse({
      verificationId: formData.get("verificationId"),
      userId: formData.get("userId"),
      status: formData.get("status"),
      reviewNote: formData.get("reviewNote"),
    });

    if (!parsed.success) {
      return invalidFormState();
    }

    // Phase 6A：审核决定走中央认证状态机（subject 锁 → verification.review
    // permission 复核 → 账号状态复核 → transition 断言 → 写 + 审计）。
    // 自审拒绝 / 跨校区 scope 不匹配 / 非法流转在 service 内 fail closed。
    await decideMembershipVerification({
      actorId: admin.id,
      verificationId: parsed.data.verificationId,
      decision: parsed.data.status,
      reviewNote: parsed.data.reviewNote || null,
    });

    revalidatePath("/admin");
    revalidatePath("/admin/verifications");
    revalidatePath("/verification");
    revalidatePath("/profile");
    revalidatePath("/notifications");
  } catch (error) {
    return { success: false, error: actionErrorMessage(error, "reviewVerification") };
  }
}

export async function reviewReport(formData: FormData): Promise<AdminActionState | undefined> {
  try {
    const admin = await requireAdmin();

    const parsed = reportReviewSchema.safeParse({
      reportId: formData.get("reportId"),
      status: formData.get("status"),
      handledNote: formData.get("handledNote"),
    });

    if (!parsed.success) {
      return invalidFormState();
    }

    const notification = getReportNotificationCopy(parsed.data.status, parsed.data.handledNote || undefined);

    await withTransaction(async (tx) => {
      // Repair 2 Blocker D：SELECT ... FOR UPDATE 序列化同一 Report 的状态变更
      // （locked status → transition 断言 → canonical update → projection →
      // AdminLog，全部同一 locked transaction；本路径不引入 USER subject locks，
      // 无 row lock → advisory 反序）
      const review = await applyReportReviewTx(tx, {
        reportId: parsed.data.reportId,
        actorId: admin.id,
        status: parsed.data.status,
        handledNote: parsed.data.handledNote || null,
      });

      await createNotification(tx, {
        userId: review.reporterId,
        type: "REPORT",
        title: notification.title,
        content: notification.content,
      });
    });

    revalidatePath("/admin");
    revalidatePath("/admin/reports");
    revalidatePath("/notifications");
  } catch (error) {
    // 中央 transition/存在性错误的用户可读提示
    if (error instanceof Error && error.message.startsWith("REPORT_STATUS_INVALID_TRANSITION:")) {
      return { success: false, error: "举报当前状态不允许此操作" };
    }
    if (error instanceof Error && error.message.startsWith("REPORT_NOT_FOUND:")) {
      return { success: false, error: "举报不存在" };
    }
    return { success: false, error: actionErrorMessage(error, "reviewReport") };
  }
}

export async function toggleUserStatus(
  formData: FormData,
): Promise<AdminActionState | undefined> {
  try {
    const admin = await requireAdmin();
    const parsed = toggleUserStatusSchema.safeParse({
      userId: formData.get("userId"),
      nextStatus: formData.get("nextStatus"),
    });

    if (!parsed.success) {
      return invalidFormState();
    }

    // Phase 6B：账号硬停用/恢复收敛到中央 enforcement service（薄 adapter）。
    // service 内部承担：sorted subject 锁（正式关闭 USER_STATUS_ROLE_ASSIGNMENT_RACE）
    // → user.suspend permission 复核 → self-deny → privileged target 保护（RBAC）
    // → 幂等转移 → EnforcementAction + 审计 + 通知（Repair 1 Blocker C：
    // 通知随命令同事务提交——通知失败整体回滚，不会伪装成 enforcement 失败）。
    const enforcementInput = {
      actorId: admin.id,
      targetUserId: parsed.data.userId,
      reasonCode: "MANUAL_REVIEW" as const,
      sourceType: "ADMIN_ACTION",
    };

    const result =
      parsed.data.nextStatus === "SUSPENDED"
        ? await suspendAccount(enforcementInput)
        : await reinstateAccount(enforcementInput);

    if (result.alreadyInState) {
      return { success: false, error: "账号已处于该状态" };
    }

    revalidatePath("/admin/users");
  } catch (error) {
    return { success: false, error: actionErrorMessage(error, "toggleUserStatus") };
  }
}

export async function moderateListing(
  formData: FormData,
): Promise<AdminActionState | undefined> {
  try {
    const admin = await requireAdmin();
    const parsed = moderateListingSchema.safeParse({
      targetType: formData.get("targetType"),
      targetId: formData.get("targetId"),
    });

    if (!parsed.success) {
      return invalidFormState();
    }

    await withTransaction(async (tx) => {
      if (parsed.data.targetType === "PRODUCT") {
        await tx.product.update({
          where: { id: parsed.data.targetId },
          data: { status: "OFFLINE" },
        });
      }

      if (parsed.data.targetType === "ERRAND") {
        await tx.errandTask.update({
          where: { id: parsed.data.targetId },
          data: { status: "CANCELLED" },
        });
      }

      if (parsed.data.targetType === "SERVICE") {
        await tx.serviceListing.update({
          where: { id: parsed.data.targetId },
          data: { status: "OFFLINE" },
        });
      }

      await tx.adminLog.create({
        data: {
          adminId: admin.id,
          action: "MODERATE_LISTING",
          targetType: parsed.data.targetType,
          targetId: parsed.data.targetId,
        },
      });
    });

    revalidatePath("/admin/products");
    revalidatePath("/admin/errands");
    revalidatePath("/admin/services");
  } catch (error) {
    return { success: false, error: actionErrorMessage(error, "moderateListing") };
  }
}

export async function upsertModerationKeyword(
  formData: FormData,
): Promise<AdminActionState | undefined> {
  try {
    const admin = await requireAdmin();
    const parsed = moderationKeywordSchema.safeParse({
      keywordId: formData.get("keywordId") || undefined,
      keyword: formData.get("keyword"),
      targetType: formData.get("targetType"),
      isEnabled: formData.get("isEnabled"),
    });

    if (!parsed.success) {
      return invalidFormState();
    }

    if (parsed.data.keywordId) {
      await prisma.moderationKeyword.update({
        where: { id: parsed.data.keywordId },
        data: {
          keyword: parsed.data.keyword,
          targetType: parsed.data.targetType,
          isEnabled: parsed.data.isEnabled,
        },
      });
    } else {
      await prisma.moderationKeyword.create({
        data: {
          keyword: parsed.data.keyword,
          targetType: parsed.data.targetType,
          isEnabled: parsed.data.isEnabled,
          createdById: admin.id,
        },
      });
    }

    await prisma.adminLog.create({
      data: {
        adminId: admin.id,
        action: parsed.data.keywordId ? "UPDATE_MODERATION_KEYWORD" : "CREATE_MODERATION_KEYWORD",
        targetType: "MODERATION_KEYWORD",
        targetId: parsed.data.keywordId ?? parsed.data.keyword,
        detail: parsed.data.targetType,
      },
    });

    resetModerationKeywordCache();
    revalidatePath("/admin/keywords");
  } catch (error) {
    return { success: false, error: actionErrorMessage(error, "upsertModerationKeyword") };
  }
}

export async function toggleModerationKeywordStatus(
  formData: FormData,
): Promise<AdminActionState | undefined> {
  try {
    const admin = await requireAdmin();
    const parsed = moderationKeywordStatusSchema.safeParse({
      keywordId: formData.get("keywordId"),
      isEnabled: formData.get("isEnabled"),
    });

    if (!parsed.success) {
      return invalidFormState();
    }

    await prisma.moderationKeyword.update({
      where: { id: parsed.data.keywordId },
      data: { isEnabled: parsed.data.isEnabled },
    });

    await prisma.adminLog.create({
      data: {
        adminId: admin.id,
        action: parsed.data.isEnabled ? "ENABLE_MODERATION_KEYWORD" : "DISABLE_MODERATION_KEYWORD",
        targetType: "MODERATION_KEYWORD",
        targetId: parsed.data.keywordId,
      },
    });

    resetModerationKeywordCache();
    revalidatePath("/admin/keywords");
  } catch (error) {
    return { success: false, error: actionErrorMessage(error, "toggleModerationKeywordStatus") };
  }
}
