"use server";

import { revalidatePath } from "next/cache";

import {
  activateGovernanceCampus,
  createGovernanceCampus,
  deactivateGovernanceCampus,
  updateGovernanceCampusMetadata,
} from "@/lib/campus/campus-governance-service";
import {
  createGovernanceVerificationPolicyDraft,
  publishGovernanceVerificationPolicy,
  retireGovernanceVerificationPolicy,
  updateGovernanceVerificationPolicyDraft,
} from "@/lib/campus/policy-governance-service";
import { isGovernanceError } from "@/lib/governance/domain-errors";
import { actionErrorMessage } from "@/lib/error-handler";
import { isRbacError } from "@/lib/rbac/errors";
import { requireUser } from "@/lib/server-auth";
import {
  governanceCampusCreateSchema,
  governanceCampusToggleSchema,
  governanceCampusUpdateSchema,
  governancePolicyDraftCreateSchema,
  governancePolicyDraftUpdateSchema,
  governancePolicyPublishSchema,
  governancePolicyRetireSchema,
} from "@/validators/governance-campus";

/**
 * Phase 7H：校区治理面薄 Server Action 适配层（7B/7G 同款冻结）。
 *
 * 硬合同：
 * - actorId 一律来自 requireUser()（session → DB ACTIVE 复查 → consent），
 *   绝不信 FormData 的任何身份字段；
 * - 零域逻辑复制：授权/锁定/校验/mutation/审计全部在 canonical
 *   campus-governance-service / policy-governance-service（锁内授权重读），
 *   本层只做 validate → 身份 → service → 统一映射 → revalidate；
 * - GovernanceError 的稳定机器码映射为安全 userMessage（服务端文案集中
 *   管理）；RBAC 错误族整体统一 deny 文案（授权结构不可暴露）；
 * - slug IMMUTABLE（§21）：update/activate/deactivate/publish/retire 的
 *   schema 结构性不含 slug——客户端永远无法通过任何 action 修改 slug。
 */

export type GovernanceCampusActionState = {
  success: boolean;
  message?: string;
  error?: string;
};

const UNIFORM_DENY_MESSAGE = "没有权限执行该校区管理操作";

function uniformDeny(): GovernanceCampusActionState {
  return { success: false, error: UNIFORM_DENY_MESSAGE };
}

function campusActionError(error: unknown, context: string): GovernanceCampusActionState {
  if (isRbacError(error)) {
    return uniformDeny();
  }
  if (isGovernanceError(error)) {
    return { success: false, error: error.message };
  }
  return { success: false, error: actionErrorMessage(error, context) };
}

function formEntries(formData: FormData): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      entries[key] = value;
    }
  }
  return entries;
}

function revalidateCampusPaths(campusId?: string) {
  revalidatePath("/governance/campuses");
  if (campusId) {
    revalidatePath(`/governance/campuses/${campusId}`);
  }
}

export async function createGovernanceCampusAction(
  _prev: GovernanceCampusActionState,
  formData: FormData,
): Promise<GovernanceCampusActionState> {
  try {
    const parsed = governanceCampusCreateSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "输入不合法" };
    }

    const actor = await requireUser();
    const campus = await createGovernanceCampus({
      actorId: actor.id,
      name: parsed.data.name,
      slug: parsed.data.slug,
      schoolName: parsed.data.schoolName,
      district: parsed.data.district,
    });

    revalidateCampusPaths(campus.id);
    return { success: true, message: `校区已创建：${campus.name}` };
  } catch (error) {
    return campusActionError(error, "createGovernanceCampusAction");
  }
}

export async function updateGovernanceCampusMetadataAction(
  _prev: GovernanceCampusActionState,
  formData: FormData,
): Promise<GovernanceCampusActionState> {
  try {
    const parsed = governanceCampusUpdateSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "输入不合法" };
    }

    const actor = await requireUser();
    await updateGovernanceCampusMetadata({
      actorId: actor.id,
      campusId: parsed.data.campusId,
      name: parsed.data.name,
      schoolName: parsed.data.schoolName,
      district: parsed.data.district,
    });

    revalidateCampusPaths(parsed.data.campusId);
    return { success: true, message: "校区信息已更新" };
  } catch (error) {
    return campusActionError(error, "updateGovernanceCampusMetadataAction");
  }
}

async function toggleCampusActive(
  formData: FormData,
  nextIsActive: boolean,
  context: string,
): Promise<GovernanceCampusActionState> {
  try {
    const parsed = governanceCampusToggleSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return uniformDeny();
    }

    const actor = await requireUser();
    const campus = nextIsActive
      ? await activateGovernanceCampus({ actorId: actor.id, campusId: parsed.data.campusId })
      : await deactivateGovernanceCampus({ actorId: actor.id, campusId: parsed.data.campusId });

    revalidateCampusPaths(campus.id);
    return {
      success: true,
      message: nextIsActive ? "校区已启用" : "校区已停用（不影响既有成员与在途义务）",
    };
  } catch (error) {
    return campusActionError(error, context);
  }
}

export async function activateGovernanceCampusAction(
  _prev: GovernanceCampusActionState,
  formData: FormData,
): Promise<GovernanceCampusActionState> {
  return toggleCampusActive(formData, true, "activateGovernanceCampusAction");
}

export async function deactivateGovernanceCampusAction(
  _prev: GovernanceCampusActionState,
  formData: FormData,
): Promise<GovernanceCampusActionState> {
  return toggleCampusActive(formData, false, "deactivateGovernanceCampusAction");
}

export async function createVerificationPolicyDraftAction(
  _prev: GovernanceCampusActionState,
  formData: FormData,
): Promise<GovernanceCampusActionState> {
  try {
    const parsed = governancePolicyDraftCreateSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "输入不合法" };
    }

    const actor = await requireUser();
    const policy = await createGovernanceVerificationPolicyDraft({
      actorId: actor.id,
      campusId: parsed.data.campusId,
      title: parsed.data.title,
      instructions: parsed.data.instructions,
      effectiveAt: parsed.data.effectiveAt ?? undefined,
    });

    revalidateCampusPaths(parsed.data.campusId);
    return {
      success: true,
      message: `认证策略草稿 v${policy.version} 已创建`,
    };
  } catch (error) {
    return campusActionError(error, "createVerificationPolicyDraftAction");
  }
}

export async function updateVerificationPolicyDraftAction(
  _prev: GovernanceCampusActionState,
  formData: FormData,
): Promise<GovernanceCampusActionState> {
  try {
    const parsed = governancePolicyDraftUpdateSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "输入不合法" };
    }

    const actor = await requireUser();
    await updateGovernanceVerificationPolicyDraft({
      actorId: actor.id,
      policyId: parsed.data.policyId,
      title: parsed.data.title,
      instructions: parsed.data.instructions,
      effectiveAt: parsed.data.effectiveAt ?? undefined,
    });

    revalidateCampusPaths(parsed.data.campusId);
    return { success: true, message: "草稿已更新" };
  } catch (error) {
    return campusActionError(error, "updateVerificationPolicyDraftAction");
  }
}

export async function publishVerificationPolicyAction(
  _prev: GovernanceCampusActionState,
  formData: FormData,
): Promise<GovernanceCampusActionState> {
  try {
    const parsed = governancePolicyPublishSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return uniformDeny();
    }

    const actor = await requireUser();
    const policy = await publishGovernanceVerificationPolicy({
      actorId: actor.id,
      policyId: parsed.data.policyId,
    });

    revalidateCampusPaths(parsed.data.campusId);
    return { success: true, message: `认证策略 v${policy.version} 已发布` };
  } catch (error) {
    return campusActionError(error, "publishVerificationPolicyAction");
  }
}

export async function retireVerificationPolicyAction(
  _prev: GovernanceCampusActionState,
  formData: FormData,
): Promise<GovernanceCampusActionState> {
  try {
    const parsed = governancePolicyRetireSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return uniformDeny();
    }

    const actor = await requireUser();
    await retireGovernanceVerificationPolicy({
      actorId: actor.id,
      policyId: parsed.data.policyId,
    });

    revalidateCampusPaths(parsed.data.campusId);
    return { success: true, message: "认证策略已退役" };
  } catch (error) {
    return campusActionError(error, "retireVerificationPolicyAction");
  }
}
