"use server";

import { revalidatePath } from "next/cache";

import { actionErrorMessage } from "@/lib/error-handler";
import {
  claimDispute,
  closeDispute,
  releaseDispute,
  resolveDispute,
} from "@/lib/disputes/dispute-service";
import {
  claimOrderDispute,
  closeOrderDispute,
  releaseOrderDispute,
  resolveOrderDispute,
} from "@/lib/disputes/order-dispute-service";
import { isDisputeError } from "@/lib/disputes/errors";
import { deriveDisputeReviewAccess } from "@/lib/disputes/dispute-access";
import { revalidateOrderViews } from "@/lib/revalidate";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import {
  governanceDisputeClaimSchema,
  governanceDisputeCloseSchema,
  governanceDisputeKindSchema,
  governanceDisputeResolveSchema,
} from "@/validators/governance-dispute";

/**
 * Phase 7G 纠纷运营治理面薄 Server Action 适配层；Phase 8C-02 起按显式
 * disputeKind dispatch 到 RentalDispute / OrderDispute 两个 canonical 服务
 * （7A/7E 同款冻结约定）。
 *
 * 硬合同：
 * - actorId 一律来自 requireUser()，绝不信 FormData 的任何身份字段；
 * - 仅做：validate（含 disputeKind discriminator，missing → RENTAL 兼容旧
 *   form contract）→ 服务端身份 → 有效 access fail-fast → canonical 域服务
 *   （全部锁/锁后授权重读/状态机/order 收敛/hold 生命周期/审计/通知都在
 *   canonical 服务内）→ revalidate。零域逻辑复制；
 * - wrong kind / missing ID / 越权：两域共享统一 deny 文案（anti-oracle，
 *   不区分"不存在/另一种纠纷/无权限"）；领用冲突/终局/RESTORE 不可用保留
 *   域内安全文案；
 * - ORDER 终局成功后除治理面外另 revalidateOrderViews（domain result 携带
 *   locked Order 的 type-FK 上下文）。
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

/**
 * 显式 discriminator 解析（§7）：missing → RENTAL（旧 Rental bookmark/form
 * contract 兼容）；非法值 → null（调用方映射统一 deny——所有新渲染 form
 * 必须显式提交，非法输入不产生"另一种"错误语义）。
 */
function parseDisputeKind(formData: FormData): "RENTAL" | "ORDER" | null {
  const raw = formData.get("disputeKind");
  const parsed = governanceDisputeKindSchema.safeParse(raw === null ? undefined : raw);
  return parsed.success ? parsed.data : null;
}

/** 终局 ORDER 成功后的用户视图刷新（§49：Order/ErrandTask/Product/notifications）。 */
function revalidateOrderTerminalViews(result: {
  productId: string | null;
  serviceListingId: string | null;
  errandTaskId: string | null;
}) {
  revalidateOrderViews({
    productId: result.productId ?? undefined,
    serviceId: result.serviceListingId ?? undefined,
    errandId: result.errandTaskId ?? undefined,
  });
}

function revalidateGovernanceDisputeViews(disputeId: string) {
  revalidatePath("/governance/disputes");
  revalidatePath(`/governance/disputes/${disputeId}`);
}

/** 纠纷领用（self claim；OPEN → IN_REVIEW，并发由行锁串行）。 */
export async function claimGovernanceDispute(
  formData: FormData,
): Promise<GovernanceDisputeActionState> {
  try {
    const kind = parseDisputeKind(formData);
    if (kind === null) {
      return uniformDeny();
    }
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

    const result =
      kind === "ORDER"
        ? await claimOrderDispute({ actorId: user.id, disputeId: parsed.data.disputeId })
        : await claimDispute({ actorId: user.id, disputeId: parsed.data.disputeId });

    revalidateGovernanceDisputeViews(parsed.data.disputeId);
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
    const kind = parseDisputeKind(formData);
    if (kind === null) {
      return uniformDeny();
    }
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

    const result =
      kind === "ORDER"
        ? await releaseOrderDispute({ actorId: user.id, disputeId: parsed.data.disputeId })
        : await releaseDispute({ actorId: user.id, disputeId: parsed.data.disputeId });

    revalidateGovernanceDisputeViews(parsed.data.disputeId);
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
    const kind = parseDisputeKind(formData);
    if (kind === null) {
      return uniformDeny();
    }
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

    if (kind === "ORDER") {
      const result = await resolveOrderDispute({
        actorId: user.id,
        disputeId: parsed.data.disputeId,
        resolutionCode: parsed.data.resolutionCode,
        resolutionAction: parsed.data.resolutionAction,
        adminNote: parsed.data.adminNote || null,
      });
      revalidateOrderTerminalViews(result);
    } else {
      await resolveDispute({
        actorId: user.id,
        disputeId: parsed.data.disputeId,
        resolutionCode: parsed.data.resolutionCode,
        resolutionAction: parsed.data.resolutionAction,
        adminNote: parsed.data.adminNote || null,
      });
    }

    revalidateGovernanceDisputeViews(parsed.data.disputeId);
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
    const kind = parseDisputeKind(formData);
    if (kind === null) {
      return uniformDeny();
    }
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

    if (kind === "ORDER") {
      const result = await closeOrderDispute({
        actorId: user.id,
        disputeId: parsed.data.disputeId,
        resolutionAction: parsed.data.resolutionAction,
        adminNote: parsed.data.adminNote || null,
      });
      revalidateOrderTerminalViews(result);
    } else {
      await closeDispute({
        actorId: user.id,
        disputeId: parsed.data.disputeId,
        resolutionAction: parsed.data.resolutionAction,
        adminNote: parsed.data.adminNote || null,
      });
    }

    revalidateGovernanceDisputeViews(parsed.data.disputeId);
    return { success: true };
  } catch (error) {
    return governanceDisputeActionError(error, "closeGovernanceDispute");
  }
}
