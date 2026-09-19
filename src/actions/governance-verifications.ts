"use server";

import { revalidatePath } from "next/cache";

import { actionErrorMessage } from "@/lib/error-handler";
import { decideMembershipVerification } from "@/lib/campus/verification-service";
import { deriveVerificationReviewAccess } from "@/lib/campus/verification-review-access";
import { isRbacError } from "@/lib/rbac/errors";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import { governanceVerificationReviewSchema } from "@/validators/governance-verification";

/**
 * Phase 7F：认证审核治理面的薄 Server Action 适配层（7A/7E 同款冻结约定）。
 *
 * 硬合同：
 * - actorId 一律来自 requireUser()（session → DB ACTIVE 复查 → consent）；
 * - 认证 decision 唯一 canonical authority = decideMembershipVerification()
 *   （sorted {USER:actor, USER:target} subject 锁 → 锁内重读 → membership
 *   ACTIVE 断言 → verification.review 授权复核 → transition 断言 → 写 +
 *   审计 + 通知 + 材料保留期）。本 action 零域逻辑复制，不复制
 *   transition table——合法性最终由 canonical state machine 判定；
 * - 授权结构不可暴露：missing/越权统一文案（反 oracle）；自审/跨校区/
 *   非法流转保留域内用户安全文案。
 */

export type GovernanceVerificationActionState = {
  success: boolean;
  error?: string;
};

const UNIFORM_DENY_MESSAGE = "没有权限审核该认证申请";

function uniformDeny(): GovernanceVerificationActionState {
  return { success: false, error: UNIFORM_DENY_MESSAGE };
}

function governanceVerificationActionError(
  error: unknown,
  context: string,
): GovernanceVerificationActionState {
  if (isRbacError(error)) {
    // deny 家族统一文案（missing/越权不可区分，反 oracle）；
    // 自审 / 非法流转 / membership 失效保留域内用户安全文案。
    if (
      error.code === "VERIFICATION_NOT_FOUND" ||
      error.code === "AUTH_PERMISSION_DENIED" ||
      error.code === "AUTH_CAMPUS_SCOPE_MISMATCH"
    ) {
      return uniformDeny();
    }
    return { success: false, error: error.message };
  }
  return { success: false, error: actionErrorMessage(error, context) };
}

/** 认证审核决定（approve / reject / revoke 的治理面薄入口）。 */
export async function reviewGovernanceVerification(
  formData: FormData,
): Promise<GovernanceVerificationActionState> {
  try {
    const noteRaw = formData.get("reviewNote");
    const reasonRaw = formData.get("reasonCode");
    const parsed = governanceVerificationReviewSchema.safeParse({
      verificationId: formData.get("verificationId"),
      decision: formData.get("decision"),
      reviewNote: typeof noteRaw === "string" ? noteRaw : undefined,
      reasonCode: typeof reasonRaw === "string" && reasonRaw.length > 0 ? reasonRaw : undefined,
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const user = await requireUser();
    const context = await loadAuthorizationContext(user.id);
    const access = deriveVerificationReviewAccess(context);
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    await decideMembershipVerification({
      actorId: user.id,
      verificationId: parsed.data.verificationId,
      decision: parsed.data.decision,
      reviewNote: parsed.data.reviewNote || null,
      reasonCode: parsed.data.reasonCode ?? null,
    });

    revalidatePath("/governance/verifications");
    revalidatePath(`/governance/verifications/${parsed.data.verificationId}`);
    revalidatePath("/verification");
    revalidatePath("/profile");
    revalidatePath("/notifications");
    return { success: true };
  } catch (error) {
    return governanceVerificationActionError(error, "reviewGovernanceVerification");
  }
}
