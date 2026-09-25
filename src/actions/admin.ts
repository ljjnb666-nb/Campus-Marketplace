"use server";

import { revalidatePath } from "next/cache";
import { actionErrorMessage } from "@/lib/error-handler";
import { resetModerationKeywordCache } from "@/lib/moderation";
import { requireAdmin } from "@/lib/server-auth";
import { decideMembershipVerification } from "@/lib/campus/verification-service";
import { suspendAccount, reinstateAccount } from "@/lib/enforcement/account-enforcement-service";
import { reviewReportInGovernance } from "@/lib/reports/report-review-service";
import {
  toggleCategoryStatusInGovernance,
  toggleModerationKeywordStatusInGovernance,
  upsertCategoryInGovernance,
  upsertModerationKeywordInGovernance,
} from "@/lib/governance/admin-configuration-service";
import {
  categoryFormSchema,
  categoryStatusSchema,
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

// RB-05：Category / ModerationKeyword 的 mutation authority 已收敛到
// canonical governance service（USER actor 锁 → 锁内 fresh permission 复核
// → 域写 + same-tx AdminLog 审计 → COMMIT）。本文件的 8 个 legacy action
// 只保留 requireAdmin 粗粒度入口门 + 身份发现 + FormData 校验 + post-commit
// 缓存/路由失效 + 错误映射——entry auth 可过期，canonical mutation 不可。
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

    await upsertCategoryInGovernance({
      actorId: admin.id,
      kind,
      categoryId,
      name,
      slug,
      description: description || null,
      sortOrder,
      isActive,
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

    await toggleCategoryStatusInGovernance({
      actorId: admin.id,
      kind,
      categoryId: parsed.data.categoryId,
      isActive: parsed.data.isActive,
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

    // Phase 7E：legacy 薄 adapter——canonical mutation authority 是
    // reviewReportInGovernance（USER subject lock → REPORT/CASE 行锁 →
    // 锁后授权 → transition 断言 → update + case 同步 + projection + 审计 +
    // reporter 通知，全部同一 locked transaction）。本 action 零域逻辑。
    await reviewReportInGovernance({
      actorId: admin.id,
      reportId: parsed.data.reportId,
      status: parsed.data.status,
      handledNote: parsed.data.handledNote || null,
    });

    revalidatePath("/admin");
    revalidatePath("/admin/reports");
    revalidatePath("/governance/reports");
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
    // → 幂等转移 → EnforcementAction + 审计（authoritative transaction）。
    // Repair 2 Blocker C：站内通知为 commit 后 best-effort 投递——通知失败仅记
    // ENFORCEMENT_NOTIFICATION_FAILED 日志，不影响 enforcement 成败。
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

// Phase 7C：legacy moderateListing 已移除——listing 治理唯一入口是
// /governance/listings canonical moderation service（raw status moderation
// 写入口普查必须为零；本文件保留的 toggleUserStatus 走 canonical
// enforcement seam，不属于 listing moderation）。

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

    await upsertModerationKeywordInGovernance({
      actorId: admin.id,
      keywordId: parsed.data.keywordId,
      keyword: parsed.data.keyword,
      targetType: parsed.data.targetType,
      isEnabled: parsed.data.isEnabled,
    });

    // 缓存失效只在 service COMMIT 成功后发生；authority deny / 回滚
    // （含审计失败）不会到达此处。
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

    await toggleModerationKeywordStatusInGovernance({
      actorId: admin.id,
      keywordId: parsed.data.keywordId,
      isEnabled: parsed.data.isEnabled,
    });

    resetModerationKeywordCache();
    revalidatePath("/admin/keywords");
  } catch (error) {
    return { success: false, error: actionErrorMessage(error, "toggleModerationKeywordStatus") };
  }
}
