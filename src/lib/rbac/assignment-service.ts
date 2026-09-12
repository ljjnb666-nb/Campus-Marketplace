import { Prisma, type UserRoleAssignment } from "@prisma/client";

import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { rbacError } from "@/lib/rbac/errors";
import {
  campusScopeKey,
  GLOBAL_SCOPE_KEY,
} from "@/lib/rbac/roles";
import {
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@/lib/rbac/service";
import { withTransaction } from "@/lib/prisma";

/**
 * Phase 6A：角色授予/撤回服务（permissioned action）。
 *
 * 安全不变量：
 * - 授予/撤回角色本身需要 `rbac.role.assign` permission（DEFAULT_DENY）
 * - 禁止变更自己的角色（self-escalation 面，锁前 fail closed）
 * - CAMPUS 角色必须指明 campusId；GLOBAL 角色必须不指明 campusId
 * - CAMPUS-scoped 的 rbac.role.assign 要求 actor 持有该校区 grant
 *   且 actor 当前是该校区 ACTIVE member（Repair 1：不能只看 grant.campusId）
 * - 授予 CAMPUS 角色要求 target 是该校区 ACTIVE member（Repair 1）；
 *   撤回不要求（stale assignment 必须可清理，Repair 1 #8）
 * - campus-scoped 的授予权不能授予 GLOBAL 角色（防跨校区/全局提权）
 * - target 账号必须 active（与 Phase 5 erasure 共享 subject 治理锁）
 *
 * Actor serialization（Repair 1，Blocker C）：
 * 统一 acquireGovernanceSubjectLocks 排序锁 {USER:actor, USER:target}，
 * 消除"actor 权限检查 → actor 注销/撤权提交 → 特权写随后提交"的 TOCTOU。
 *
 * 锁序（PHASE_6A_LOCK_ORDER）：
 *   governance subject locks（sorted USER:actor + USER:target）
 *   → actor active/permission 复核 → target active/membership 复核
 *   → 行写 + 审计
 */

export type RoleAssignmentResult = {
  assignment: UserRoleAssignment;
  /** 幂等语义：true = 本次新建；false = 已存在，原样返回 */
  created: boolean;
};

type RoleGrantContext = {
  actorId: string;
  targetUserId: string;
  roleKey: string;
  campusId?: string | null;
  /** 测试 seam：subject 锁取得之后、全部复核之前的受控暂停点（并发测试用） */
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
  /**
   * Phase 7B FR-02：assignment 身份守卫（仅 revokeRole 消费；assignRole 忽略）。
   * assignmentId 可经 revoke→re-grant 轮换（ABA）：调用方解析 assignment 后、
   * canonical 元组撤回前，同一 (userId, roleKey, scopeKey) 元组可能已被删除并
   * 重建为新 id。提供本字段时，锁内 existing.id 与其不一致 → 幂等 no-op
   * （removed=false，不删除、不写 ROLE_REVOKED 审计）。省略 = canonical 既有
   * 语义零变化（CLI/内部路径不受影响）。锁序/授权/membership 例外均不变。
   */
  expectedAssignmentId?: string;
};

/** 排序取得 {USER:actor, USER:target} subject 锁（自指时去重为单锁）。 */
async function acquireActorTargetLocks(
  tx: Prisma.TransactionClient,
  actorId: string,
  targetUserId: string,
): Promise<void> {
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: actorId },
    { subjectType: "USER", subjectId: targetUserId },
  ]);
}

/**
 * actor 前置复核（锁内）：账号 active + 至少持有 rbac.role.assign。
 * 角色相关的 scope 精确匹配在 role 读出后判定（避免向未授权者泄露角色存在性）。
 * 返回收窄后的非空 context。
 */
function assertActorMayManageRoles(
  context: AuthorizationContext | null,
): AuthorizationContext {
  if (!context) {
    throw rbacError("AUTH_PERMISSION_DENIED");
  }
  if (!context.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  if (!context.grants.some((grant) => grant.permissionKeys.includes("rbac.role.assign"))) {
    throw rbacError("AUTH_PERMISSION_DENIED");
  }
  return context;
}

/**
 * 角色授予 scope 精确判定（Phase 7A 窄修：解除首个校区审核员的
 * provisioning chicken-and-egg）：
 * - GLOBAL rbac.role.assign：可管理 GLOBAL 角色，也可管理任意校区的
 *   CAMPUS 角色（不要求 actor membership——与全仓 hasPermission 的
 *   GLOBAL-supersedes-campus 语义一致：GLOBAL grant 对任意 targetCampusId
 *   放行且不要求 membership）；
 * - CAMPUS rbac.role.assign@A：仅可管理 CAMPUS 角色且仅 @A，且 actor 当前
 *   持有该校区的 ACTIVE membership（activeCampusIds 命中）；
 *   永不可管理 GLOBAL 角色（防跨校区/全局提权）。
 * target 侧规则（ACTIVE/membership/self-deny/锁序/审计）不在本函数，零变更。
 */
function assertRoleAssignScope(
  context: AuthorizationContext,
  roleScope: "GLOBAL" | "CAMPUS",
  targetCampusId: string | null,
): void {
  const holdsAssign = (grant: { permissionKeys: string[] }) =>
    grant.permissionKeys.includes("rbac.role.assign");

  // GLOBAL 授予权：任意目标（GLOBAL 角色或任意校区 CAMPUS 角色）
  if (context.grants.some((grant) => grant.scope === "GLOBAL" && holdsAssign(grant))) {
    return;
  }

  // CAMPUS 授予权：仅同校区 CAMPUS 角色
  const campusMatched =
    roleScope === "CAMPUS" &&
    targetCampusId != null &&
    context.grants.some(
      (grant) =>
        grant.scope === "CAMPUS" &&
        grant.campusId === targetCampusId &&
        holdsAssign(grant),
    ) &&
    context.activeCampusIds.includes(targetCampusId);

  if (!campusMatched) {
    throw rbacError("ROLE_ASSIGNMENT_CAMPUS_MISMATCH");
  }
}

/** 授予角色。幂等：同一 (user, role, scope) 重复授予返回既有行。 */
export async function assignRole(input: RoleGrantContext): Promise<RoleAssignmentResult> {
  return withTransaction(async (tx) => {
    // self-mutation 锁前 fail closed（不制造重复锁）
    if (input.targetUserId === input.actorId) {
      throw rbacError("ROLE_ASSIGNMENT_SELF_DENIED");
    }

    await acquireActorTargetLocks(tx, input.actorId, input.targetUserId);

    if (input.racePoint) {
      await input.racePoint(tx);
    }

    // 锁内重读 target：erased/deleted/suspended 账号不能被授角色（与注销严格先后）
    const target = await tx.user.findUnique({
      where: { id: input.targetUserId },
      select: { id: true, status: true, deletedAt: true, erasedAt: true },
    });

    if (!target) {
      throw rbacError("AUTH_PERMISSION_DENIED", "目标用户不存在");
    }
    if (target.deletedAt || target.erasedAt || target.status !== "ACTIVE") {
      throw rbacError("AUTH_ACCOUNT_INACTIVE");
    }

    // actor 复核在锁之后（先于 role 探测，防未授权角色存在性枚举）
    const actorContext = assertActorMayManageRoles(
      await loadAuthorizationContext(input.actorId, tx),
    );

    const role = await tx.role.findUnique({ where: { key: input.roleKey } });
    if (!role) {
      throw rbacError("ROLE_NOT_FOUND");
    }

    if (role.scope === "GLOBAL" && input.campusId != null) {
      throw rbacError("ROLE_ASSIGNMENT_INVALID_SCOPE");
    }
    if (role.scope === "CAMPUS" && !input.campusId) {
      throw rbacError("ROLE_ASSIGNMENT_INVALID_SCOPE");
    }

    assertRoleAssignScope(actorContext, role.scope, role.scope === "GLOBAL" ? null : input.campusId!);

    // Repair 1 #7：授予 CAMPUS 角色要求 target 是该校区 ACTIVE member
    if (role.scope === "CAMPUS") {
      const membership = await tx.campusMembership.findUnique({
        where: {
          userId_campusId: { userId: target.id, campusId: input.campusId! },
        },
        select: { status: true },
      });
      if (!membership || membership.status !== "ACTIVE") {
        throw rbacError("ROLE_ASSIGNMENT_TARGET_MEMBERSHIP_INACTIVE");
      }
    }

    const scopeKey =
      role.scope === "GLOBAL"
        ? GLOBAL_SCOPE_KEY
        : campusScopeKey(input.campusId!);

    const existing = await tx.userRoleAssignment.findUnique({
      where: {
        userId_roleId_scopeKey: {
          userId: target.id,
          roleId: role.id,
          scopeKey,
        },
      },
    });

    if (existing) {
      return { assignment: existing, created: false };
    }

    let assignment: UserRoleAssignment;
    try {
      assignment = await tx.userRoleAssignment.create({
        data: {
          userId: target.id,
          roleId: role.id,
          campusId: role.scope === "GLOBAL" ? null : input.campusId!,
          scopeKey,
          assignedById: input.actorId,
        },
      });
    } catch (error) {
      // 并发双授予：唯一约束兜底为幂等成功
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const raced = await tx.userRoleAssignment.findUnique({
          where: {
            userId_roleId_scopeKey: { userId: target.id, roleId: role.id, scopeKey },
          },
        });
        if (raced) {
          return { assignment: raced, created: false };
        }
      }
      throw error;
    }

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "ROLE_ASSIGNED",
        targetType: "USER",
        targetId: target.id,
        campusId: assignment.campusId,
        metadata: { roleKey: role.key },
      },
      tx,
    );

    return { assignment, created: true };
  });
}

/** 撤回角色。幂等：角色未授予时为 no-op。target membership 不要求 ACTIVE（遗留清理例外）。 */
export async function revokeRole(input: RoleGrantContext): Promise<{ removed: boolean }> {
  return withTransaction(async (tx) => {
    if (input.targetUserId === input.actorId) {
      throw rbacError("ROLE_ASSIGNMENT_SELF_DENIED");
    }

    await acquireActorTargetLocks(tx, input.actorId, input.targetUserId);

    if (input.racePoint) {
      await input.racePoint(tx);
    }

    const target = await tx.user.findUnique({
      where: { id: input.targetUserId },
      select: { id: true, status: true, deletedAt: true, erasedAt: true },
    });

    if (!target) {
      throw rbacError("AUTH_PERMISSION_DENIED", "目标用户不存在");
    }
    if (target.deletedAt || target.erasedAt || target.status !== "ACTIVE") {
      throw rbacError("AUTH_ACCOUNT_INACTIVE");
    }

    const actorContext = assertActorMayManageRoles(
      await loadAuthorizationContext(input.actorId, tx),
    );

    const role = await tx.role.findUnique({ where: { key: input.roleKey } });
    if (!role) {
      throw rbacError("ROLE_NOT_FOUND");
    }

    if (role.scope === "GLOBAL" && input.campusId != null) {
      throw rbacError("ROLE_ASSIGNMENT_INVALID_SCOPE");
    }
    if (role.scope === "CAMPUS" && !input.campusId) {
      throw rbacError("ROLE_ASSIGNMENT_INVALID_SCOPE");
    }

    // 撤回同样要求 actor 的 scope/active membership 有效（授权仍须成立），
    // 但不要求 target membership ACTIVE（Repair 1 #8 清理例外）
    assertRoleAssignScope(actorContext, role.scope, role.scope === "GLOBAL" ? null : input.campusId!);

    const scopeKey =
      role.scope === "GLOBAL"
        ? GLOBAL_SCOPE_KEY
        : campusScopeKey(input.campusId!);

    const existing = await tx.userRoleAssignment.findUnique({
      where: {
        userId_roleId_scopeKey: { userId: target.id, roleId: role.id, scopeKey },
      },
    });

    if (!existing) {
      return { removed: false };
    }

    // Phase 7B FR-02（ABA 身份守卫）：expectedAssignmentId 与锁内 existing.id
    // 不一致 = 元组已被删除并重建（assignmentId 轮换），本行不是调用方请求的
    // 那一行 → 幂等 no-op：不删除、不写 ROLE_REVOKED 审计。
    if (
      input.expectedAssignmentId !== undefined &&
      existing.id !== input.expectedAssignmentId
    ) {
      return { removed: false };
    }

    await tx.userRoleAssignment.delete({ where: { id: existing.id } });

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: "ROLE_REVOKED",
        targetType: "USER",
        targetId: target.id,
        campusId: existing.campusId,
        metadata: { roleKey: role.key },
      },
      tx,
    );

    return { removed: true };
  });
}
