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
 * 角色授予 scope 精确判定（Repair 1）：
 * - GLOBAL 角色：须存在 GLOBAL 授予权
 * - CAMPUS 角色：须存在该 campus 的 CAMPUS 授予权，且 actor 当前持有
 *   该校区的 ACTIVE membership（activeCampusIds 命中）
 */
function assertRoleAssignScope(
  context: AuthorizationContext,
  roleScope: "GLOBAL" | "CAMPUS",
  targetCampusId: string | null,
): void {
  const holdsAssign = (grant: { permissionKeys: string[] }) =>
    grant.permissionKeys.includes("rbac.role.assign");

  const scopeMatched =
    roleScope === "GLOBAL"
      ? context.grants.some((grant) => grant.scope === "GLOBAL" && holdsAssign(grant))
      : targetCampusId != null &&
        context.grants.some(
          (grant) =>
            grant.scope === "CAMPUS" &&
            grant.campusId === targetCampusId &&
            holdsAssign(grant),
        ) &&
        context.activeCampusIds.includes(targetCampusId);

  if (!scopeMatched) {
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
