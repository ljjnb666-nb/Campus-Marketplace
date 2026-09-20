"use server";

import { revalidatePath } from "next/cache";

import { actionErrorMessage } from "@/lib/error-handler";
import {
  claimDispute,
  closeDispute,
  releaseDispute,
  resolveDispute,
} from "@/lib/disputes/dispute-service";
import { isDisputeError } from "@/lib/disputes/errors";
import { deriveDisputeReviewAccess } from "@/lib/disputes/dispute-access";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import {
  governanceDisputeClaimSchema,
  governanceDisputeCloseSchema,
  governanceDisputeResolveSchema,
} from "@/validators/governance-dispute";

/**
 * Phase 7G：纠纷运营治理面的薄 Server Action 适配层（7A/7E 同款冻结约定）。
 *
 * 硬合同：
 * - actorId 一律来自 requireUser()，绝不信 FormData 的任何身份字段；
 * - 仅做：validate → 服务端身份 → 有效 access fail-fast → canonical 域服务
 *   （全部锁/锁后授权重读/状态机/order 收敛/hold 生命周期/审计/通知都在
 *   canonical 服务内）→ revalidate。零域逻辑复制；
 * - 授权结构不可暴露：missing/越权统一文案；领用冲突/终局/RESTORE 不可用
 *   保留域内安全文案。
 */

export type GovernanceDisputeActionState = {
  success: boolean;
  outcome?: "CLAIMED" | "ALREADY_YOURS" | "RELEASED" | "ALREADY_RELEASED";
  error?: string;
};

const UNIFORM_DENY_MESSAGE = "没有权限处理该纠纷";

function uniformDeny(): GovernanceDisputeActionState {
  return { success: false, error: UNIFORM_DENY_MESSAGE };
}

function governanceDisputeActionError(
  error: unknown,
  context: string,
): GovernanceDisputeActionState {
  if (isDisputeError(error)) {
    // deny 家族统一文案（missing/越权/非领用人释放不可区分，反 oracle）；
    // 领用冲突 / 终局 / 状态不合法 / RESTORE 不可用保留域内安全文案。
    if (
      error.code === "DISPUTE_NOT_FOUND" ||
      error.code === "DISPUTE_FORBIDDEN" ||
      error.code === "DISPUTE_RELEASE_FORBIDDEN"
    ) {
      return uniformDeny();
    }
    return { success: false, error: error.message };
  }
  return { success: false, error: actionErrorMessage(error, context) };
}

async function loadOperatorAccess() {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveDisputeReviewAccess(context);
  return { user, access };
}

/** 纠纷领用（self claim；OPEN → IN_REVIEW，并发由行锁串行）。 */
export async function claimGovernanceDispute(
  formData: FormData,
): Promise<GovernanceDisputeActionState> {
  try {
    const parsed = governanceDisputeClaimSchema.safeParse({
      disputeId: formData.get("disputeId"),
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    const result = await claimDispute({
      actorId: user.id,
      disputeId: parsed.data.disputeId,
    });

    revalidatePath("/governance/disputes");
    revalidatePath(`/governance/disputes/${parsed.data.disputeId}`);
    return { success: true, outcome: result.outcome };
  } catch (error) {
    return governanceDisputeActionError(error, "claimGovernanceDispute");
  }
}

/** 纠纷释放（self release；IN_REVIEW → OPEN，dueAt 不重置）。 */
export async function releaseGovernanceDispute(
  formData: FormData,
): Promise<GovernanceDisputeActionState> {
  try {
    const parsed = governanceDisputeClaimSchema.safeParse({
      disputeId: formData.get("disputeId"),
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    const result = await releaseDispute({
      actorId: user.id,
      disputeId: parsed.data.disputeId,
    });

    revalidatePath("/governance/disputes");
    revalidatePath(`/governance/disputes/${parsed.data.disputeId}`);
    return { success: true, outcome: result.outcome };
  } catch (error) {
    return governanceDisputeActionError(error, "releaseGovernanceDispute");
  }
}

/** 纠纷解决（RESOLVED；order 收敛动作 + hold 释放 + 审计全在 canonical 服务）。 */
export async function resolveGovernanceDispute(
  formData: FormData,
): Promise<GovernanceDisputeActionState> {
  try {
    const parsed = governanceDisputeResolveSchema.safeParse({
      disputeId: formData.get("disputeId"),
      resolutionCode: formData.get("resolutionCode"),
      resolutionAction: formData.get("resolutionAction"),
      adminNote: typeof formData.get("adminNote") === "string" ? formData.get("adminNote") : undefined,
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    await resolveDispute({
      actorId: user.id,
      disputeId: parsed.data.disputeId,
      resolutionCode: parsed.data.resolutionCode,
      resolutionAction: parsed.data.resolutionAction,
      adminNote: parsed.data.adminNote || null,
    });

    revalidatePath("/governance/disputes");
    revalidatePath(`/governance/disputes/${parsed.data.disputeId}`);
    return { success: true };
  } catch (error) {
    return governanceDisputeActionError(error, "resolveGovernanceDispute");
  }
}

/** 纠纷关闭（CLOSED；order 收敛动作仍必填——终局必须收敛订单）。 */
export async function closeGovernanceDispute(
  formData: FormData,
): Promise<GovernanceDisputeActionState> {
  try {
    const parsed = governanceDisputeCloseSchema.safeParse({
      disputeId: formData.get("disputeId"),
      resolutionAction: formData.get("resolutionAction"),
      adminNote: typeof formData.get("adminNote") === "string" ? formData.get("adminNote") : undefined,
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    await closeDispute({
      actorId: user.id,
      disputeId: parsed.data.disputeId,
      resolutionAction: parsed.data.resolutionAction,
      adminNote: parsed.data.adminNote || null,
    });

    revalidatePath("/governance/disputes");
    revalidatePath(`/governance/disputes/${parsed.data.disputeId}`);
    return { success: true };
  } catch (error) {
    return governanceDisputeActionError(error, "closeGovernanceDispute");
  }
}
