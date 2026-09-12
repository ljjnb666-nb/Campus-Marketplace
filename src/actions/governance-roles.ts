"use server";

import { revalidatePath } from "next/cache";

import { assignRole, revokeRole } from "@/lib/rbac/assignment-service";
import { actionErrorMessage } from "@/lib/error-handler";
import {
  resolveGrantCandidate,
  resolveGrantEligibleCampus,
  resolveRevocableAssignment,
} from "@/lib/rbac/role-assignment-query";
import {
  canManageCampus,
  deriveRoleManageAccess,
  isManageableGovernanceRoleKey,
} from "@/lib/rbac/role-manage-access";
import { CAMPUS_APPEAL_REVIEWER_ROLE_KEY } from "@/lib/rbac/roles";
import { isRbacError } from "@/lib/rbac/errors";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import {
  governanceRoleGrantSchema,
  governanceRoleLookupSchema,
  governanceRoleRevokeSchema,
} from "@/validators/governance-role";

/**
 * Phase 7B 角色供给面薄 Server Action 适配层（Planning Repair + P1 冻结）。
 *
 * 硬合同：
 * - actorId 一律来自 requireUser()（session → DB ACTIVE 复查 → consent），
 *   绝不信 FormData 的任何身份字段；roleKey 为服务器所有（v1 固定
 *   CAMPUS_APPEAL_REVIEWER，validator .strict() 结构性拒绝客户端注入）；
 * - grant/lookup 冻结顺序：validate → 身份 → access 派生 → campus manage
 *   授权 → ACTIVE CAMPUS eligibility（resolveGrantEligibleCampus）→ allowlist
 *   结构校验 → exact-email candidate → canonical assignRole（锁/锁后授权
 *   重读/幂等收敛/审计全在 canonical 服务内）→ 统一映射 → revalidate；
 *   Campus 查询恒先于 User email 查询（P1）；
 * - revoke 冻结链：{assignmentId} → resolver（minimal load → allowlist →
 *   CAMPUS exact pair → manage 授权）→ canonical revokeRole（不要求 target
 *   membership ACTIVE、不检查 Campus.isActive——stale 清理例外为 canonical
 *   既有语义，零削弱）→ 统一映射 → revalidate；
 * - 授权结构不可暴露（§16）：malformed/missing/越权/inactive/跨校区/
 *   unmanaged 统一文案，canonical RbacError 机器码仅在服务端内部判别；
 * - 零域逻辑复制、零第二份审计/通知写入。
 */

export type GovernanceRoleActionState = {
  success: boolean;
  /** lookup 命中时的 candidate 展示名（唯一 client-visible candidate 字段） */
  displayName?: string;
  /** grant/revoke 的成功/中性幂等反馈文案 */
  message?: string;
  error?: string;
};

const UNIFORM_DENY_MESSAGE = "没有权限执行该角色管理操作";

const GRANT_SUCCESS_MESSAGE = "已授予校区申诉审核员角色";
const GRANT_IDEMPOTENT_MESSAGE = "该用户已持有该角色";
const REVOKE_SUCCESS_MESSAGE = "已撤回该角色授予";
const REVOKE_MISSING_MESSAGE = "该授予已不存在或已被撤回";

function uniformDeny(): GovernanceRoleActionState {
  return { success: false, error: UNIFORM_DENY_MESSAGE };
}

/**
 * 全量 FormData 条目进入 strict 解析：注入的 roleKey/actorId/targetUserId 等
 * 服务端所有字段被 .strict() 显式拒绝（不做静默 strip——"ignore 不够安全"，
 * 与 6C-2 appealSubmit 同约定）。
 */
function formEntries(formData: FormData): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      entries[key] = value;
    }
  }
  return entries;
}

function roleActionError(error: unknown, context: string): GovernanceRoleActionState {
  // canonical RBAC 错误族整体统一为 deny 文案（self-deny/账号停用/scope
  // mismatch 等不可区分），绝不回传 userMessage 中的域内结构信息。
  if (isRbacError(error)) {
    return uniformDeny();
  }
  return { success: false, error: actionErrorMessage(error, context) };
}

/**
 * allowlist 结构校验（fail-closed 常量哨兵）：v1 服务器所有 roleKey 必须在
 * 显式 allowlist 内。这是恒真结构不变量——为 false 只可能意味着 allowlist
 * 配置被改动，此时整体 fail closed。
 */
function assertServerOwnedRoleAllowed(): boolean {
  return isManageableGovernanceRoleKey(CAMPUS_APPEAL_REVIEWER_ROLE_KEY);
}

/** exact-email candidate 预查（仅 UX 便利；grant 不信任其结果）。 */
export async function lookupRoleGrantCandidate(
  formData: FormData,
): Promise<GovernanceRoleActionState> {
  try {
    const parsed = governanceRoleLookupSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return uniformDeny();
    }

    const actor = await requireUser();
    const context = await loadAuthorizationContext(actor.id);
    const access = deriveRoleManageAccess(context);
    if (!canManageCampus(access, parsed.data.campusId)) {
      return uniformDeny();
    }

    // P1 顺序：Campus eligibility gate 必须先于 User email lookup
    const campus = await resolveGrantEligibleCampus({
      access,
      campusId: parsed.data.campusId,
    });
    if (!campus) {
      return uniformDeny();
    }

    if (!assertServerOwnedRoleAllowed()) {
      return uniformDeny();
    }

    const candidate = await resolveGrantCandidate({
      campusId: parsed.data.campusId,
      email: parsed.data.email,
    });
    if (!candidate) {
      return uniformDeny();
    }

    return { success: true, displayName: candidate.name };
  } catch (error) {
    return roleActionError(error, "lookupRoleGrantCandidate");
  }
}

/**
 * 授予 v1 唯一可管角色（CAMPUS_APPEAL_REVIEWER）。canonical assignRole
 * 锁后重验 actor / target 账号 / role / scope / target membership；
 * created=false 为幂等中性结局（原样成功，不作为错误）。
 */
export async function grantGovernanceRole(
  formData: FormData,
): Promise<GovernanceRoleActionState> {
  try {
    const parsed = governanceRoleGrantSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return uniformDeny();
    }

    const actor = await requireUser();
    const context = await loadAuthorizationContext(actor.id);
    const access = deriveRoleManageAccess(context);
    if (!canManageCampus(access, parsed.data.campusId)) {
      return uniformDeny();
    }

    const campus = await resolveGrantEligibleCampus({
      access,
      campusId: parsed.data.campusId,
    });
    if (!campus) {
      return uniformDeny();
    }

    if (!assertServerOwnedRoleAllowed()) {
      return uniformDeny();
    }

    const candidate = await resolveGrantCandidate({
      campusId: parsed.data.campusId,
      email: parsed.data.email,
    });
    if (!candidate) {
      return uniformDeny();
    }

    const result = await assignRole({
      actorId: actor.id,
      targetUserId: candidate.id,
      roleKey: CAMPUS_APPEAL_REVIEWER_ROLE_KEY,
      campusId: parsed.data.campusId,
    });

    revalidatePath("/governance/roles");
    return {
      success: true,
      message: result.created ? GRANT_SUCCESS_MESSAGE : GRANT_IDEMPOTENT_MESSAGE,
    };
  } catch (error) {
    return roleActionError(error, "grantGovernanceRole");
  }
}

/**
 * 按 assignmentId 撤回（客户端唯一入口）。role/scope/target 全由服务器从
 * assignment 行解析；removed=false（已不存在/已撤回）为中性幂等结局。
 */
export async function revokeGovernanceRole(
  formData: FormData,
): Promise<GovernanceRoleActionState> {
  try {
    const parsed = governanceRoleRevokeSchema.safeParse(formEntries(formData));
    if (!parsed.success) {
      return uniformDeny();
    }

    const actor = await requireUser();
    const context = await loadAuthorizationContext(actor.id);
    const access = deriveRoleManageAccess(context);

    const assignment = await resolveRevocableAssignment({
      access,
      assignmentId: parsed.data.assignmentId,
    });
    if (!assignment) {
      return uniformDeny();
    }

    const result = await revokeRole({
      actorId: actor.id,
      targetUserId: assignment.userId,
      roleKey: assignment.roleKey,
      campusId: assignment.campusId,
      // FR-02（ABA 身份守卫）：撤回的必须正是客户端提交 assignmentId 所指的
      // 那一行——元组在解析后被 revoke→re-grant 轮换时 canonical 幂等 no-op。
      expectedAssignmentId: assignment.id,
    });

    revalidatePath("/governance/roles");
    return {
      success: true,
      message: result.removed ? REVOKE_SUCCESS_MESSAGE : REVOKE_MISSING_MESSAGE,
    };
  } catch (error) {
    return roleActionError(error, "revokeGovernanceRole");
  }
}
