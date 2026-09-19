"use server";

import { revalidatePath } from "next/cache";

import { actionErrorMessage } from "@/lib/error-handler";
import { isEnforcementError } from "@/lib/enforcement/errors";
import {
  reinstateAccount,
  suspendAccount,
} from "@/lib/enforcement/account-enforcement-service";
import {
  deriveUserOperationsAccess,
} from "@/lib/governance/user-operations-access";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import { governanceUserActionSchema } from "@/validators/governance-user";

/**
 * Phase 7F：用户运营治理面的薄 Server Action 适配层（7A/7E 同款冻结约定）。
 *
 * 硬合同：
 * - actorId 一律来自 requireUser()（session → DB ACTIVE 复查 → consent），
 *   绝不信 FormData/query/client props 的任何身份字段；
 * - 账号状态唯一 canonical mutation authority =
 *   suspendAccount()/reinstateAccount()（subject 锁 → GLOBAL user.suspend
 *   复核 → self-deny → privileged target 保护 → 幂等 → EnforcementAction +
 *   AdminAudit）。本 action 零域逻辑复制，仅 validate → 身份 → fail-fast →
 *   canonical 调用 → revalidate；
 * - 授权结构不可暴露：missing/deleted/erased/privileged 统一文案
 *   （no-oracle）；already-in-state 保留域内安全文案。
 */

export type GovernanceUserActionState = {
  success: boolean;
  error?: string;
};

const UNIFORM_DENY_MESSAGE = "没有权限管理该账号";

function uniformDeny(): GovernanceUserActionState {
  return { success: false, error: UNIFORM_DENY_MESSAGE };
}

function governanceUserActionError(
  error: unknown,
  context: string,
): GovernanceUserActionState {
  if (isEnforcementError(error)) {
    // deny 家族统一文案（missing/deleted/erased/privileged/self 不可区分，
    // 反 oracle）；幂等/非法转移保留域内用户安全文案。
    if (
      error.code === "ENFORCEMENT_TARGET_NOT_FOUND" ||
      error.code === "ENFORCEMENT_PRIVILEGED_TARGET" ||
      error.code === "ENFORCEMENT_SELF_DENIED"
    ) {
      return uniformDeny();
    }
    return { success: false, error: error.message };
  }
  return { success: false, error: actionErrorMessage(error, context) };
}

/** 停用账号（thin adapter；canonical authority = suspendAccount）。 */
export async function suspendGovernanceUser(
  formData: FormData,
): Promise<GovernanceUserActionState> {
  try {
    const parsed = governanceUserActionSchema.safeParse({
      userId: formData.get("userId"),
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const user = await requireUser();
    const context = await loadAuthorizationContext(user.id);
    if (!deriveUserOperationsAccess(context).global) {
      return uniformDeny();
    }

    await suspendAccount({
      actorId: user.id,
      targetUserId: parsed.data.userId,
      reasonCode: "MANUAL_REVIEW",
      sourceType: "GOVERNANCE_ACTION",
    });

    revalidatePath("/governance/users");
    revalidatePath(`/governance/users/${parsed.data.userId}`);
    revalidatePath("/governance/enforcement");
    return { success: true };
  } catch (error) {
    return governanceUserActionError(error, "suspendGovernanceUser");
  }
}

/** 恢复账号（thin adapter；canonical authority = reinstateAccount）。 */
export async function reinstateGovernanceUser(
  formData: FormData,
): Promise<GovernanceUserActionState> {
  try {
    const parsed = governanceUserActionSchema.safeParse({
      userId: formData.get("userId"),
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const user = await requireUser();
    const context = await loadAuthorizationContext(user.id);
    if (!deriveUserOperationsAccess(context).global) {
      return uniformDeny();
    }

    await reinstateAccount({
      actorId: user.id,
      targetUserId: parsed.data.userId,
      reasonCode: "MANUAL_REVIEW",
      sourceType: "GOVERNANCE_ACTION",
    });

    revalidatePath("/governance/users");
    revalidatePath(`/governance/users/${parsed.data.userId}`);
    revalidatePath("/governance/enforcement");
    return { success: true };
  } catch (error) {
    return governanceUserActionError(error, "reinstateGovernanceUser");
  }
}
