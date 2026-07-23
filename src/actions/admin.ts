"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/server-auth";
import { createNotification } from "@/repositories/notification-repository";
import { reportReviewSchema, verificationReviewSchema } from "@/validators/admin";

const toggleUserStatusSchema = z.object({
  userId: z.string().min(1),
  nextStatus: z.enum(["ACTIVE", "SUSPENDED"]),
});

const moderateListingSchema = z.object({
  targetType: z.enum(["PRODUCT", "ERRAND", "SERVICE"]),
  targetId: z.string().min(1),
});

const categoryBaseSchema = z.object({
  categoryId: z.string().optional(),
  name: z.string().trim().min(1).max(30),
  slug: z.string().trim().min(1).max(40),
  description: z.string().trim().max(120).optional(),
  sortOrder: z.coerce.number().int().min(0).max(999),
  isActive: z.enum(["true", "false"]).transform((value) => value === "true"),
});

const productCategorySchema = categoryBaseSchema;
const errandCategorySchema = categoryBaseSchema;
const serviceCategorySchema = categoryBaseSchema;

const categoryStatusSchema = z.object({
  categoryId: z.string().min(1),
  isActive: z.enum(["true", "false"]).transform((value) => value === "true"),
});

const moderationKeywordSchema = z.object({
  keywordId: z.string().optional(),
  keyword: z.string().trim().min(1).max(40),
  targetType: z.enum(["PRODUCT", "ERRAND", "SERVICE", "MESSAGE", "GLOBAL"]),
  isEnabled: z.enum(["true", "false"]).transform((value) => value === "true"),
});

const moderationKeywordStatusSchema = z.object({
  keywordId: z.string().min(1),
  isEnabled: z.enum(["true", "false"]).transform((value) => value === "true"),
});

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

export async function reviewVerification(formData: FormData) {
  const admin = await requireAdmin();

  const parsed = verificationReviewSchema.safeParse({
    verificationId: formData.get("verificationId"),
    userId: formData.get("userId"),
    status: formData.get("status"),
    reviewNote: formData.get("reviewNote"),
  });

  if (!parsed.success) {
    return;
  }

  const reviewedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.userVerification.update({
      where: { id: parsed.data.verificationId },
      data: {
        status: parsed.data.status,
        reviewNote: parsed.data.reviewNote || null,
        reviewedAt,
      },
    });

    await tx.user.update({
      where: { id: parsed.data.userId },
      data: {
        verificationStatus: parsed.data.status,
      },
    });

    await tx.adminLog.create({
      data: {
        adminId: admin.id,
        action: parsed.data.status === "VERIFIED" ? "APPROVE_VERIFICATION" : "REJECT_VERIFICATION",
        targetType: "USER_VERIFICATION",
        targetId: parsed.data.verificationId,
        detail: parsed.data.reviewNote || null,
      },
    });

    await createNotification(tx, {
      userId: parsed.data.userId,
      type: "SYSTEM",
      title: parsed.data.status === "VERIFIED" ? "校园认证已通过" : "校园认证未通过",
      content:
        parsed.data.status === "VERIFIED"
          ? "你的校园认证已通过审核，平台会向其他同学展示你的认证状态。"
          : `你的校园认证未通过审核。${
              parsed.data.reviewNote ? `原因：${parsed.data.reviewNote}` : "请完善材料后重新提交。"
            }`,
    });
  });

  revalidatePath("/admin");
  revalidatePath("/admin/verifications");
  revalidatePath("/verification");
  revalidatePath("/profile");
  revalidatePath("/notifications");
}

export async function reviewReport(formData: FormData) {
  const admin = await requireAdmin();

  const parsed = reportReviewSchema.safeParse({
    reportId: formData.get("reportId"),
    status: formData.get("status"),
    handledNote: formData.get("handledNote"),
  });

  if (!parsed.success) {
    return;
  }

  const notification = getReportNotificationCopy(parsed.data.status, parsed.data.handledNote || undefined);

  await prisma.$transaction(async (tx) => {
    const report = await tx.report.update({
      where: { id: parsed.data.reportId },
      data: {
        status: parsed.data.status,
        handledById: admin.id,
        handledNote: parsed.data.handledNote || null,
        handledAt:
          parsed.data.status === "RESOLVED" || parsed.data.status === "REJECTED" ? new Date() : null,
      },
      select: {
        reporterId: true,
      },
    });

    await tx.adminLog.create({
      data: {
        adminId: admin.id,
        action: `REPORT_${parsed.data.status}`,
        targetType: "REPORT",
        targetId: parsed.data.reportId,
        detail: parsed.data.handledNote || null,
      },
    });

    await createNotification(tx, {
      userId: report.reporterId,
      type: "REPORT",
      title: notification.title,
      content: notification.content,
    });
  });

  revalidatePath("/admin");
  revalidatePath("/admin/reports");
  revalidatePath("/notifications");
}

export async function toggleUserStatus(formData: FormData) {
  const admin = await requireAdmin();
  const parsed = toggleUserStatusSchema.safeParse({
    userId: formData.get("userId"),
    nextStatus: formData.get("nextStatus"),
  });

  if (!parsed.success) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: parsed.data.userId },
      data: { status: parsed.data.nextStatus },
    });

    await tx.adminLog.create({
      data: {
        adminId: admin.id,
        action: parsed.data.nextStatus === "SUSPENDED" ? "SUSPEND_USER" : "RESTORE_USER",
        targetType: "USER",
        targetId: parsed.data.userId,
      },
    });

    await createNotification(tx, {
      userId: parsed.data.userId,
      type: "SYSTEM",
      title: parsed.data.nextStatus === "SUSPENDED" ? "账号已被停用" : "账号已恢复正常",
      content:
        parsed.data.nextStatus === "SUSPENDED"
          ? "你的账号当前已被管理员暂停使用，如有疑问请联系平台管理员。"
          : "你的账号已恢复正常使用。",
    });
  });

  revalidatePath("/admin/users");
}

export async function moderateListing(formData: FormData) {
  const admin = await requireAdmin();
  const parsed = moderateListingSchema.safeParse({
    targetType: formData.get("targetType"),
    targetId: formData.get("targetId"),
  });

  if (!parsed.success) {
    return;
  }

  await prisma.$transaction(async (tx) => {
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
}

export async function upsertProductCategory(formData: FormData) {
  const admin = await requireAdmin();
  const parsed = productCategorySchema.safeParse({
    categoryId: formData.get("categoryId") || undefined,
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: formData.get("description") || "",
    sortOrder: formData.get("sortOrder"),
    isActive: formData.get("isActive"),
  });

  if (!parsed.success) {
    return;
  }

  if (parsed.data.categoryId) {
    await prisma.productCategory.update({
      where: { id: parsed.data.categoryId },
      data: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        description: parsed.data.description || null,
        sortOrder: parsed.data.sortOrder,
        isActive: parsed.data.isActive,
      },
    });
  } else {
    await prisma.productCategory.create({
      data: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        description: parsed.data.description || null,
        sortOrder: parsed.data.sortOrder,
        isActive: parsed.data.isActive,
      },
    });
  }

  await prisma.adminLog.create({
    data: {
      adminId: admin.id,
      action: parsed.data.categoryId ? "UPDATE_PRODUCT_CATEGORY" : "CREATE_PRODUCT_CATEGORY",
      targetType: "PRODUCT_CATEGORY",
      targetId: parsed.data.categoryId ?? parsed.data.slug,
      detail: parsed.data.name,
    },
  });

  revalidatePath("/admin/categories");
  revalidatePath("/products");
}

export async function toggleProductCategoryStatus(formData: FormData) {
  const admin = await requireAdmin();
  const parsed = categoryStatusSchema.safeParse({
    categoryId: formData.get("categoryId"),
    isActive: formData.get("isActive"),
  });

  if (!parsed.success) {
    return;
  }

  await prisma.productCategory.update({
    where: { id: parsed.data.categoryId },
    data: { isActive: parsed.data.isActive },
  });

  await prisma.adminLog.create({
    data: {
      adminId: admin.id,
      action: parsed.data.isActive ? "ENABLE_PRODUCT_CATEGORY" : "DISABLE_PRODUCT_CATEGORY",
      targetType: "PRODUCT_CATEGORY",
      targetId: parsed.data.categoryId,
    },
  });

  revalidatePath("/admin/categories");
  revalidatePath("/products");
}

export async function upsertErrandCategory(formData: FormData) {
  const admin = await requireAdmin();
  const parsed = errandCategorySchema.safeParse({
    categoryId: formData.get("categoryId") || undefined,
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: formData.get("description") || "",
    sortOrder: formData.get("sortOrder"),
    isActive: formData.get("isActive"),
  });

  if (!parsed.success) {
    return;
  }

  if (parsed.data.categoryId) {
    await prisma.errandCategory.update({
      where: { id: parsed.data.categoryId },
      data: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        description: parsed.data.description || null,
        sortOrder: parsed.data.sortOrder,
        isActive: parsed.data.isActive,
      },
    });
  } else {
    await prisma.errandCategory.create({
      data: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        description: parsed.data.description || null,
        sortOrder: parsed.data.sortOrder,
        isActive: parsed.data.isActive,
      },
    });
  }

  await prisma.adminLog.create({
    data: {
      adminId: admin.id,
      action: parsed.data.categoryId ? "UPDATE_ERRAND_CATEGORY" : "CREATE_ERRAND_CATEGORY",
      targetType: "ERRAND_CATEGORY",
      targetId: parsed.data.categoryId ?? parsed.data.slug,
      detail: parsed.data.name,
    },
  });

  revalidatePath("/admin/categories");
  revalidatePath("/errands");
}

export async function toggleErrandCategoryStatus(formData: FormData) {
  const admin = await requireAdmin();
  const parsed = categoryStatusSchema.safeParse({
    categoryId: formData.get("categoryId"),
    isActive: formData.get("isActive"),
  });

  if (!parsed.success) {
    return;
  }

  await prisma.errandCategory.update({
    where: { id: parsed.data.categoryId },
    data: { isActive: parsed.data.isActive },
  });

  await prisma.adminLog.create({
    data: {
      adminId: admin.id,
      action: parsed.data.isActive ? "ENABLE_ERRAND_CATEGORY" : "DISABLE_ERRAND_CATEGORY",
      targetType: "ERRAND_CATEGORY",
      targetId: parsed.data.categoryId,
    },
  });

  revalidatePath("/admin/categories");
  revalidatePath("/errands");
}

export async function upsertServiceCategory(formData: FormData) {
  const admin = await requireAdmin();
  const parsed = serviceCategorySchema.safeParse({
    categoryId: formData.get("categoryId") || undefined,
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: formData.get("description") || "",
    sortOrder: formData.get("sortOrder"),
    isActive: formData.get("isActive"),
  });

  if (!parsed.success) {
    return;
  }

  if (parsed.data.categoryId) {
    await prisma.serviceCategory.update({
      where: { id: parsed.data.categoryId },
      data: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        description: parsed.data.description || null,
        sortOrder: parsed.data.sortOrder,
        isActive: parsed.data.isActive,
      },
    });
  } else {
    await prisma.serviceCategory.create({
      data: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        description: parsed.data.description || null,
        sortOrder: parsed.data.sortOrder,
        isActive: parsed.data.isActive,
      },
    });
  }

  await prisma.adminLog.create({
    data: {
      adminId: admin.id,
      action: parsed.data.categoryId ? "UPDATE_SERVICE_CATEGORY" : "CREATE_SERVICE_CATEGORY",
      targetType: "SERVICE_CATEGORY",
      targetId: parsed.data.categoryId ?? parsed.data.slug,
      detail: parsed.data.name,
    },
  });

  revalidatePath("/admin/categories");
  revalidatePath("/services");
}

export async function toggleServiceCategoryStatus(formData: FormData) {
  const admin = await requireAdmin();
  const parsed = categoryStatusSchema.safeParse({
    categoryId: formData.get("categoryId"),
    isActive: formData.get("isActive"),
  });

  if (!parsed.success) {
    return;
  }

  await prisma.serviceCategory.update({
    where: { id: parsed.data.categoryId },
    data: { isActive: parsed.data.isActive },
  });

  await prisma.adminLog.create({
    data: {
      adminId: admin.id,
      action: parsed.data.isActive ? "ENABLE_SERVICE_CATEGORY" : "DISABLE_SERVICE_CATEGORY",
      targetType: "SERVICE_CATEGORY",
      targetId: parsed.data.categoryId,
    },
  });

  revalidatePath("/admin/categories");
  revalidatePath("/services");
}

export async function upsertModerationKeyword(formData: FormData) {
  const admin = await requireAdmin();
  const parsed = moderationKeywordSchema.safeParse({
    keywordId: formData.get("keywordId") || undefined,
    keyword: formData.get("keyword"),
    targetType: formData.get("targetType"),
    isEnabled: formData.get("isEnabled"),
  });

  if (!parsed.success) {
    return;
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

  revalidatePath("/admin/keywords");
}

export async function toggleModerationKeywordStatus(formData: FormData) {
  const admin = await requireAdmin();
  const parsed = moderationKeywordStatusSchema.safeParse({
    keywordId: formData.get("keywordId"),
    isEnabled: formData.get("isEnabled"),
  });

  if (!parsed.success) {
    return;
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

  revalidatePath("/admin/keywords");
}
