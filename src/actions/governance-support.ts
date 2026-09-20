"use server";

import { revalidatePath } from "next/cache";

import { actionErrorMessage } from "@/lib/error-handler";
import { deriveSupportManageAccess } from "@/lib/support/support-access";
import { isSupportTicketError } from "@/lib/support/errors";
import {
  claimSupportTicket,
  closeSupportTicket,
  releaseSupportTicket,
  resolveSupportTicket,
} from "@/lib/support/support-service";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import {
  governanceSupportClaimSchema,
  governanceSupportCloseSchema,
  governanceSupportResolveSchema,
} from "@/validators/governance-support";

/**
 * Phase 7G：支持工单运营治理面的薄 Server Action 适配层（7A/7E 同款冻结约定）。
 *
 * 硬合同：
 * - actorId 一律来自 requireUser()，绝不信 FormData 的任何身份字段；
 * - 仅做：validate → 服务端身份 → 有效 access fail-fast → canonical 域服务
 *   （全部锁/锁后授权重读/状态机/审计/通知都在 canonical 服务内）→ revalidate；
 * - 授权结构不可暴露：missing/越权统一文案；领用冲突/终局保留域内安全文案。
 */

export type GovernanceSupportActionState = {
  success: boolean;
  outcome?: "CLAIMED" | "ALREADY_YOURS" | "RELEASED" | "ALREADY_RELEASED";
  error?: string;
};

const UNIFORM_DENY_MESSAGE = "没有权限处理该工单";

function uniformDeny(): GovernanceSupportActionState {
  return { success: false, error: UNIFORM_DENY_MESSAGE };
}

function governanceSupportActionError(
  error: unknown,
  context: string,
): GovernanceSupportActionState {
  if (isSupportTicketError(error)) {
    // deny 家族统一文案（missing/越权/非领用人释放不可区分，反 oracle）；
    // 领用冲突 / 终局 / 状态不合法保留域内安全文案。
    if (
      error.code === "SUPPORT_TICKET_NOT_FOUND" ||
      error.code === "SUPPORT_TICKET_FORBIDDEN" ||
      error.code === "SUPPORT_TICKET_RELEASE_FORBIDDEN"
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
  const access = deriveSupportManageAccess(context);
  return { user, access };
}

/** 工单领用（self claim；OPEN → IN_PROGRESS，并发由行锁串行）。 */
export async function claimSupportTicketAction(
  formData: FormData,
): Promise<GovernanceSupportActionState> {
  try {
    const parsed = governanceSupportClaimSchema.safeParse({
      ticketId: formData.get("ticketId"),
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    const result = await claimSupportTicket({
      actorId: user.id,
      ticketId: parsed.data.ticketId,
    });

    revalidatePath("/governance/support");
    revalidatePath(`/governance/support/${parsed.data.ticketId}`);
    return { success: true, outcome: result.outcome };
  } catch (error) {
    return governanceSupportActionError(error, "claimSupportTicketAction");
  }
}

/** 工单释放（self release；IN_PROGRESS → OPEN，dueAt 不重置）。 */
export async function releaseSupportTicketAction(
  formData: FormData,
): Promise<GovernanceSupportActionState> {
  try {
    const parsed = governanceSupportClaimSchema.safeParse({
      ticketId: formData.get("ticketId"),
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    const result = await releaseSupportTicket({
      actorId: user.id,
      ticketId: parsed.data.ticketId,
    });

    revalidatePath("/governance/support");
    revalidatePath(`/governance/support/${parsed.data.ticketId}`);
    return { success: true, outcome: result.outcome };
  } catch (error) {
    return governanceSupportActionError(error, "releaseSupportTicketAction");
  }
}

/** 工单解决（RESOLVED；resolutionMessage USER_VISIBLE / internalNote OPERATOR_ONLY）。 */
export async function resolveSupportTicketAction(
  formData: FormData,
): Promise<GovernanceSupportActionState> {
  try {
    const parsed = governanceSupportResolveSchema.safeParse({
      ticketId: formData.get("ticketId"),
      resolutionCode: formData.get("resolutionCode"),
      resolutionMessage: typeof formData.get("resolutionMessage") === "string"
        ? formData.get("resolutionMessage")
        : undefined,
      internalNote: typeof formData.get("internalNote") === "string"
        ? formData.get("internalNote")
        : undefined,
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    await resolveSupportTicket({
      actorId: user.id,
      ticketId: parsed.data.ticketId,
      resolutionCode: parsed.data.resolutionCode,
      resolutionMessage: parsed.data.resolutionMessage || null,
      internalNote: parsed.data.internalNote || null,
    });

    revalidatePath("/governance/support");
    revalidatePath(`/governance/support/${parsed.data.ticketId}`);
    revalidatePath("/notifications");
    return { success: true };
  } catch (error) {
    return governanceSupportActionError(error, "resolveSupportTicketAction");
  }
}

/** 工单关闭（CLOSED）。 */
export async function closeSupportTicketAction(
  formData: FormData,
): Promise<GovernanceSupportActionState> {
  try {
    const parsed = governanceSupportCloseSchema.safeParse({
      ticketId: formData.get("ticketId"),
      internalNote: typeof formData.get("internalNote") === "string"
        ? formData.get("internalNote")
        : undefined,
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const { user, access } = await loadOperatorAccess();
    if (!access.global && access.campusIds.length === 0) {
      return uniformDeny();
    }

    await closeSupportTicket({
      actorId: user.id,
      ticketId: parsed.data.ticketId,
      internalNote: parsed.data.internalNote || null,
    });

    revalidatePath("/governance/support");
    revalidatePath(`/governance/support/${parsed.data.ticketId}`);
    return { success: true };
  } catch (error) {
    return governanceSupportActionError(error, "closeSupportTicketAction");
  }
}
