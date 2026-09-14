"use server";

import { actionErrorMessage } from "@/lib/error-handler";
import {
  isModerationError,
  ModerationError,
} from "@/lib/moderation/errors";
import {
  moderateErrandListing,
  moderateProductListing,
  moderateRentalListing,
  moderateServiceListing,
  restoreListingByModerationIdentity,
} from "@/lib/moderation/listing-moderation-service";
import { isRbacError } from "@/lib/rbac/errors";
import { revalidateListingModerationViews } from "@/lib/revalidate";
import { requireUser } from "@/lib/server-auth";
import {
  listingModerationRestoreSchema,
  listingModerationTakedownSchema,
} from "@/validators/governance-listing";

/**
 * Phase 7C listing 治理面薄 Server Action 适配层（R2-03/R2-06 冻结）。
 *
 * 硬合同：
 * - 身份一律来自 requireUser()（session → DB ACTIVE 复查 → consent），
 *   绝不信 FormData 的任何身份字段（ownerId/campusId/moderatorId 等结构性
 *   不出现在 schema 中——.strict() 显式拒绝）；
 * - takedown：四域各自独立 typed action（targetType 是代码常量，客户端不能
 *   选择/伪造）；campusId/owner/现势状态全部由服务器锁内解析；
 * - restore：客户端只提交 { moderationId, expectedListingUpdatedAt }；
 *   target identity 由服务器从 moderation 行解析（R2-03）；
 * - 错误映射：授权族（RbacError / MODERATION_TARGET_NOT_FOUND /
 *   MODERATION_SELF_DENIED）→ 统一 deny 文案（授权结构不可暴露）；STALE /
 *   NOT_RESTORABLE 为授权 operator 的安全反馈（泛化文案，不泄露 owner
 *   注销事实）；UI 收到 STALE 必须刷新重检，绝不自动重试（R2-06）；
 * - 成功后 revalidate：PUBLIC 检索/列表/详情/收藏/owner 面 + 治理面。
 */

export type ListingModerationActionState = {
  success: boolean;
  message?: string;
  /** R2-06：STALE 时 UI 必须刷新治理详情（不得自动重试） */
  stale?: boolean;
};

const UNIFORM_DENY_MESSAGE = "没有权限执行该治理操作";
const STALE_MESSAGE = "处置状态已变化，请刷新治理详情后重试";
const NOT_RESTORABLE_MESSAGE = "该处置当前不可恢复";

const TAKEDOWN_SUCCESS_MESSAGE = "已对该内容执行治理处置";
const ALREADY_MODERATED_MESSAGE = "该内容已在治理处置中";
const RESTORE_SUCCESS_MESSAGE = "已恢复该内容的公开展示";

function formEntries(formData: FormData): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      entries[key] = value;
    }
  }
  return entries;
}

function moderationActionError(error: unknown, context: string): ListingModerationActionState {
  if (error instanceof ModerationError) {
    if (error.code === "STALE_MODERATION_REVIEW") {
      return { success: false, stale: true, message: STALE_MESSAGE };
    }
    if (error.code === "RESTORE_NOT_RESTORABLE") {
      return { success: false, message: NOT_RESTORABLE_MESSAGE };
    }
    // MODERATION_TARGET_NOT_FOUND / MODERATION_SELF_DENIED → 统一 deny
    return { success: false, message: UNIFORM_DENY_MESSAGE };
  }
  if (isRbacError(error)) {
    return { success: false, message: UNIFORM_DENY_MESSAGE };
  }
  return { success: false, message: actionErrorMessage(error, context) };
}

/** 四域 takedown 共用冻结链（type 为代码常量；schema 严格拒绝注入字段）。 */
async function runTakedown(
  formData: FormData,
  targetType: "PRODUCT" | "SERVICE" | "ERRAND" | "RENTAL",
  context: string,
): Promise<ListingModerationActionState> {
  try {
    const parsed = listingModerationTakedownSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return { success: false, message: UNIFORM_DENY_MESSAGE };
    }

    const actor = await requireUser();
    const result = await (targetType === "PRODUCT"
      ? moderateProductListing({
          moderatorId: actor.id,
          listingId: parsed.data.listingId,
          reasonCode: parsed.data.reasonCode,
          note: parsed.data.note ?? null,
        })
      : targetType === "SERVICE"
        ? moderateServiceListing({
            moderatorId: actor.id,
            listingId: parsed.data.listingId,
            reasonCode: parsed.data.reasonCode,
            note: parsed.data.note ?? null,
          })
        : targetType === "ERRAND"
          ? moderateErrandListing({
              moderatorId: actor.id,
              listingId: parsed.data.listingId,
              reasonCode: parsed.data.reasonCode,
              note: parsed.data.note ?? null,
            })
          : moderateRentalListing({
              moderatorId: actor.id,
              listingId: parsed.data.listingId,
              reasonCode: parsed.data.reasonCode,
              note: parsed.data.note ?? null,
            }));

    revalidateListingModerationViews(targetType, parsed.data.listingId);
    return {
      success: true,
      message:
        result.outcome === "TAKEDOWN"
          ? TAKEDOWN_SUCCESS_MESSAGE
          : ALREADY_MODERATED_MESSAGE,
    };
  } catch (error) {
    return moderationActionError(error, context);
  }
}

export async function moderateProductListingAction(
  formData: FormData,
): Promise<ListingModerationActionState> {
  return runTakedown(formData, "PRODUCT", "moderateProductListingAction");
}

export async function moderateServiceListingAction(
  formData: FormData,
): Promise<ListingModerationActionState> {
  return runTakedown(formData, "SERVICE", "moderateServiceListingAction");
}

export async function moderateErrandListingAction(
  formData: FormData,
): Promise<ListingModerationActionState> {
  return runTakedown(formData, "ERRAND", "moderateErrandListingAction");
}

export async function moderateRentalListingAction(
  formData: FormData,
): Promise<ListingModerationActionState> {
  return runTakedown(formData, "RENTAL", "moderateRentalListingAction");
}

/**
 * restore：客户端只提交 { moderationId, expectedListingUpdatedAt }；
 * target identity 由服务器从 moderation 行解析（R2-03）；type 不出自客户端。
 */
export async function restoreListingModerationAction(
  formData: FormData,
): Promise<ListingModerationActionState> {
  try {
    const parsed = listingModerationRestoreSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return { success: false, message: UNIFORM_DENY_MESSAGE };
    }

    const actor = await requireUser();
    const result = await restoreListingByModerationIdentity({
      moderatorId: actor.id,
      moderationId: parsed.data.moderationId,
      expectedListingUpdatedAt: new Date(parsed.data.expectedListingUpdatedAt),
    });

    revalidateListingModerationViews(result.targetType, result.listingId);
    return { success: true, message: RESTORE_SUCCESS_MESSAGE };
  } catch (error) {
    if (isModerationError(error) && error.code === "STALE_MODERATION_REVIEW") {
      return { success: false, stale: true, message: STALE_MESSAGE };
    }
    return moderationActionError(error, "restoreListingModerationAction");
  }
}

export type { ListingModerationActionState as ListingModerationActionResult };
