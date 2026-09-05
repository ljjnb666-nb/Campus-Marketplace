import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  ADMIN_SURFACE_PERMISSION_KEYS,
  asPermissionKey,
  type PermissionKey,
} from "@/lib/rbac/permissions";
import { rbacError } from "@/lib/rbac/errors";

/**
 * Phase 6A：中央授权上下文与 permission 判定（唯一授权入口）。
 *
 * 原则（DEFAULT_DENY）：
 * - 用户不存在 / 账号非 active（status!=ACTIVE || deletedAt || erasedAt）→ DENY
 * - 未知 permission → DENY
 * - CAMPUS 角色必须同时满足：grant.campusId == targetCampusId
 *   且 targetCampusId ∈ actor 的 ACTIVE campus memberships
 *   （Repair 1：membership missing / PENDING / REJECTED / SUSPENDED / LEFT
 *   一律 DENY——campus 权限 = role_permission AND scope_match AND active_membership）
 * - GLOBAL 角色不要求 campus membership（平台管理员无 membership 仍可工作）
 * - 任何业务代码不得再以 `role === "ADMIN"` 判权，一律经由本模块
 *
 * 与 Phase 5 的关系：active-account enforcement（server-auth.ts）是授权的
 * 前置门；本模块在 service/事务内部再做一次同语义复核（fail closed），
 * 两者不得互相绕过。
 */

export type AuthorizationGrant = {
  roleKey: string;
  scope: "GLOBAL" | "CAMPUS";
  campusId: string | null;
  permissionKeys: string[];
};

export type AuthorizationContext = {
  userId: string;
  accountActive: boolean;
  /** 全部 ACTIVE membership 的 campusId（模型支持多校区；当前产品单 active campus） */
  activeCampusIds: string[];
  grants: AuthorizationGrant[];
};

function isActiveAccount(user: { status: string; deletedAt: Date | null; erasedAt: Date | null }): boolean {
  return user.status === "ACTIVE" && user.deletedAt === null && user.erasedAt === null;
}

const authorizationSelect = {
  id: true,
  status: true,
  deletedAt: true,
  erasedAt: true,
  memberships: {
    // 只取 ACTIVE membership——PENDING/REJECTED/SUSPENDED/LEFT 不进入授权上下文
    where: { status: "ACTIVE" as const },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }] as const,
    select: { id: true, campusId: true, status: true },
  },
  userRoles: {
    select: {
      campusId: true,
      role: {
        select: {
          key: true,
          scope: true,
          rolePermissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  },
} satisfies Prisma.UserSelect;

/**
 * 加载授权上下文。用户不存在返回 null（调用方按 DENY 处理）；
 * 账号 active 与否在 context.accountActive 中显式给出。
 *
 * tx 变体供事务内部（subject 锁之后）复核使用——READ COMMITTED 下
 * 锁 + 同事务读 = 线性化，避免"先查后锁"窗口。
 */
export async function loadAuthorizationContext(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<AuthorizationContext | null> {
  // 扩展客户端与事务客户端的联合类型会触发 Prisma excessive stack depth
  // （见 legal-document-service.ts 同注），prisma / tx 两条路径显式分开。
  const user = tx
    ? await tx.user.findUnique({ where: { id: userId }, select: authorizationSelect })
    : await prisma.user.findUnique({ where: { id: userId }, select: authorizationSelect });

  if (!user) {
    return null;
  }

  const grants: AuthorizationGrant[] = user.userRoles.map((assignment) => ({
    roleKey: assignment.role.key,
    scope: assignment.role.scope,
    campusId: assignment.campusId,
    permissionKeys: assignment.role.rolePermissions.map((rp) => rp.permission.key),
  }));

  return {
    userId: user.id,
    accountActive: isActiveAccount(user),
    activeCampusIds: user.memberships.map((membership) => membership.campusId),
    grants,
  };
}

/**
 * permission 判定（纯函数，DEFAULT_DENY）。
 *
 * CAMPUS_PERMISSION = ROLE_PERMISSION AND CAMPUS_SCOPE_MATCH AND ACTIVE_MEMBERSHIP_MATCH：
 * campus-scoped grant 必须命中目标校区且 actor 当前持有该校区的 ACTIVE membership。
 *
 * @param targetCampusId campus-scoped permission 的目标校区；GLOBAL 角色无需此参
 *        即可放行，且不因无 membership 被拒。
 */
export function hasPermission(
  context: AuthorizationContext | null,
  permission: PermissionKey,
  targetCampusId?: string | null,
): boolean {
  if (!context || !context.accountActive) {
    return false;
  }

  // 未知 permission 一律 DENY（不依赖调用方传入合法 key）
  if (!asPermissionKey(permission)) {
    return false;
  }

  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes(permission)) {
      continue;
    }
    if (grant.scope === "GLOBAL") {
      return true;
    }
    if (
      targetCampusId != null &&
      grant.campusId === targetCampusId &&
      context.activeCampusIds.includes(targetCampusId)
    ) {
      return true;
    }
  }

  return false;
}

export function hasAnyPermission(
  context: AuthorizationContext | null,
  permissions: readonly PermissionKey[],
  targetCampusId?: string | null,
): boolean {
  return permissions.some((permission) => hasPermission(context, permission, targetCampusId));
}

/**
 * legacy full-admin 等价判定（Repair 1，Blocker D）：
 * 必须存在一个 GLOBAL grant 且其 permission 集合完整覆盖 legacy admin surface
 * （PLATFORM_ADMIN-like full authority）。禁止 any-permission 拼接：
 * 细粒度 GLOBAL/CAMPUS 角色一律不构成旧超管。
 */
export function hasFullAdminSurfaceAccess(context: AuthorizationContext | null): boolean {
  if (!context) {
    return false;
  }

  return context.grants.some(
    (grant) =>
      grant.scope === "GLOBAL" &&
      ADMIN_SURFACE_PERMISSION_KEYS.every((key) => grant.permissionKeys.includes(key)),
  );
}

/**
 * 高权限目标判定（toggleUserStatus 等管理保护用，Repair 1）：
 * 以 RBAC 授权上下文判断 target 是否拥有 full-admin 等价权限，
 * 不读取 User.role 字段。
 */
export async function isPrivilegedTarget(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const context = await loadAuthorizationContext(userId, tx);
  return hasFullAdminSurfaceAccess(context);
}

/**
 * 授权失败即抛错的事务内复核入口（敏感 mutation 用，见 Phase 6A TOCTOU 契约：
 * 必须在 subject 治理锁之后调用，传入同一 tx）。
 */
export async function requirePermissionInContext(
  context: AuthorizationContext | null,
  permission: PermissionKey,
  targetCampusId?: string | null,
): Promise<AuthorizationContext> {
  if (!context) {
    throw rbacError("AUTH_PERMISSION_DENIED");
  }
  if (!context.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  if (!hasPermission(context, permission, targetCampusId)) {
    throw context.grants.some(
      (grant) =>
        grant.scope === "CAMPUS" && grant.permissionKeys.includes(permission),
    )
      ? rbacError("AUTH_CAMPUS_SCOPE_MISMATCH")
      : rbacError("AUTH_PERMISSION_DENIED");
  }
  return context;
}

/** 非事务入口：加载上下文并要求指定 permission（读路径/轻量校验用）。 */
export async function authorize(
  userId: string,
  permission: PermissionKey,
  options: { campusId?: string | null; tx?: Prisma.TransactionClient } = {},
): Promise<AuthorizationContext> {
  const context = await loadAuthorizationContext(userId, options.tx);
  return requirePermissionInContext(context, permission, options.campusId ?? null);
}
