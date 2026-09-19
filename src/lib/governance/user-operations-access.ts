import { notFound } from "next/navigation";

import { requireUser } from "@/lib/server-auth";
import { hasPermission, loadAuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7F：用户运营面（/governance/users）访问派生（DEFAULT_DENY）。
 *
 * 授权模型（指令冻结）：USER MANAGEMENT = GLOBAL user.suspend ONLY——
 * 不存在 campus-scoped account suspension。hasPermission 不传 campusId 时
 * 仅 GLOBAL grant 放行（campus-scoped user.suspend 即使误配也进不来），
 * 与 account-enforcement-service 的 GLOBAL-only 复核同一语义。
 *
 * 绝不使用 requireAdmin()（那是 legacy 11-key 全量桥）与 User.role。
 */

export const USER_OPERATIONS_PERMISSION = "user.suspend" as const;

export type UserOperationsAccess = {
  /** GLOBAL user.suspend（唯一有效形态） */
  global: boolean;
};

export function deriveUserOperationsAccess(
  context: Parameters<typeof hasPermission>[0],
): UserOperationsAccess {
  if (!context || !context.accountActive) {
    return { global: false };
  }
  // 不传 targetCampusId：CAMPUS grant 一律不命中 → GLOBAL-only 语义
  return { global: hasPermission(context, USER_OPERATIONS_PERMISSION) };
}

/** root gate / 导航可见性用。 */
export function hasAnyUserOperationsAccess(access: UserOperationsAccess): boolean {
  return access.global;
}

export type UserOperationsPageSession = {
  user: Awaited<ReturnType<typeof requireUser>>;
};

/**
 * /governance/users 页面统一入口（每次请求独立执行，绝不缓存）：
 *   requireUser()（session → DB ACTIVE 复查 → consent）
 *   → loadAuthorizationContext
 *   → deriveUserOperationsAccess
 *   → 非 GLOBAL user.suspend → notFound()（不泄露治理面存在性）。
 *
 * 与 legacy requireAdmin() 完全分离（requireAdmin 是 11-key 全量桥，此处
 * 只要求 user.suspend 的 GLOBAL grant——两者交集是 PLATFORM_ADMIN-like
 * 全量管理员，但语义上互不复用）。
 */
export async function requireUserOperationsAdmin(): Promise<UserOperationsPageSession> {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveUserOperationsAccess(context);

  if (!access.global) {
    notFound();
  }

  return { user };
}
