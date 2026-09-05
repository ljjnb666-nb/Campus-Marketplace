import { Prisma, type UserRoleAssignment } from "@prisma/client";

import { acquireGovernanceSubjectLock } from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { rbacError } from "@/lib/rbac/errors";
import {
  campusScopeKey,
  GLOBAL_SCOPE_KEY,
} from "@/lib/rbac/roles";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { withTransaction } from "@/lib/prisma";

/**
 * Phase 6A：角色授予/撤回服务（permissioned action）。
 *
 * 安全不变量：
 * - 授予/撤回角色本身需要 `rbac.role.assign` permission（DEFAULT_DENY）
 * - 禁止变更自己的角色（self-escalation 面，fail closed）
 * - CAMPUS 角色必须指明 campusId；GLOBAL 角色必须不指明 campusId
 * - campus-scoped 的 rbac.role.assign 只能授予本校区 CAMPUS 角色，
 *   不能授予 GLOBAL 角色（防跨校区/全局提权）
 * - 目标账号必须 active（与 Phase 5 erasure 共享 subject 治理锁：
 *   锁内复核账号状态，erased/deleted 账号不能被授角色——与注销严格先后）
 *
 * 锁序：subject 锁（USER:target）→ 授权/状态复核 → 行写。
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
};

async function lockAndLoadTarget(
  tx: Prisma.TransactionClient,
  targetUserId: string,
): Promise<{ id: string; status: string; deletedAt: Date | null; erasedAt: Date | null }> {
  const firstRead = await tx.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, status: true, deletedAt: true, erasedAt: true },
  });

  if (!firstRead) {
    throw rbacError("AUTH_PERMISSION_DENIED", "目标用户不存在");
  }

  await acquireGovernanceSubjectLock(tx, "USER", targetUserId);

  // 锁内重读：check 与 commit 之间的窗口由 subject 锁互斥关闭（TOCTOU）
  const target = await tx.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, status: true, deletedAt: true, erasedAt: true },
  });

  if (!target || target.deletedAt || target.erasedAt || target.status !== "ACTIVE") {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }

  return target;
}

/**
 * 角色授予权限的精确判定（区别于通用 permission 拒绝）：
 * - 完全不持有 rbac.role.assign → AUTH_PERMISSION_DENIED
 * - 持有但 scope 不匹配（campus 授权授予 GLOBAL 角色 / 跨 campus）→
 *   ROLE_ASSIGNMENT_CAMPUS_MISMATCH
 * - 账号非 active → AUTH_ACCOUNT_INACTIVE
 */
function assertRoleAssignPermission(
  context: Awaited<ReturnType<typeof loadAuthorizationContext>>,
  roleScope: "GLOBAL" | "CAMPUS",
  targetCampusId: string | null,
): void {
  if (!context) {
    throw rbacError("AUTH_PERMISSION_DENIED");
  }
  if (!context.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }

  const holdsPermission = (grant: { scope: string; campusId: string | null; permissionKeys: string[] }) =>
    grant.permissionKeys.includes("rbac.role.assign");

  if (!context.grants.some(holdsPermission)) {
    throw rbacError("AUTH_PERMISSION_DENIED");
  }

  const scopeMatched =
    roleScope === "GLOBAL"
      ? context.grants.some((grant) => grant.scope === "GLOBAL" && holdsPermission(grant))
      : context.grants.some(
          (grant) =>
            grant.scope === "CAMPUS" &&
            grant.campusId === targetCampusId &&
            holdsPermission(grant),
        );

  if (!scopeMatched) {
    throw rbacError("ROLE_ASSIGNMENT_CAMPUS_MISMATCH");
  }
}

/** 授予角色。幂等：同一 (user, role, scope) 重复授予返回既有行。 */
export async function assignRole(input: RoleGrantContext): Promise<RoleAssignmentResult> {
  return withTransaction(async (tx) => {
    const target = await lockAndLoadTarget(tx, input.targetUserId);

    if (input.targetUserId === input.actorId) {
      throw rbacError("ROLE_ASSIGNMENT_SELF_DENIED");
    }

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

    // 授权复核在 subject 锁之后（Phase 6A TOCTOU 契约），按角色 scope 精确判定
    const actorContext = await loadAuthorizationContext(input.actorId, tx);
    assertRoleAssignPermission(actorContext, role.scope, role.scope === "GLOBAL" ? null : input.campusId!);

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

/** 撤回角色。幂等：角色未授予时为 no-op。 */
export async function revokeRole(
  input: RoleGrantContext,
): Promise<{ removed: boolean }> {
  return withTransaction(async (tx) => {
    const target = await lockAndLoadTarget(tx, input.targetUserId);

    if (input.targetUserId === input.actorId) {
      throw rbacError("ROLE_ASSIGNMENT_SELF_DENIED");
    }

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

    const actorContext = await loadAuthorizationContext(input.actorId, tx);
    assertRoleAssignPermission(actorContext, role.scope, role.scope === "GLOBAL" ? null : input.campusId!);

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
