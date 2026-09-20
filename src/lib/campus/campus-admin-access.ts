import { notFound } from "next/navigation";

import { requireUser } from "@/lib/server-auth";
import { hasPermission, loadAuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7H：校区治理面（/governance/campuses）访问派生（DEFAULT_DENY）。
 *
 * 授权模型（Planning §17 冻结）：campus.manage = GLOBAL ONLY——
 * Campus entity mutation 修改的是租户边界本身，不存在 campus-scoped
 * Campus Admin：即使错误存在 campus.manage @ CAMPUS:A 的 grant 也绝不
 * 获得 Campus Administration（与 hasPermission 不传 campusId 时仅 GLOBAL
 * grant 放行的中央语义一致）。
 *
 * campus.manage 是 existing permission（Phase 6A）：7H 只为它补 canonical
 * governance surface——零 rename / 零 delete / 零第二同义 permission。
 * 现有消费点（membership enforcement / risk service / appeal canGrant 提示）
 * 语义零变化；本派生仅供 /governance/campuses 子树与 canonical
 * campus mutation service（锁后授权重读）使用。
 *
 * 绝不使用 requireAdmin()（那是 legacy 11-key 全量桥）与 User.role。
 */

export const CAMPUS_MANAGE_PERMISSION = "campus.manage" as const;

export type CampusManageAccess = {
  /** GLOBAL campus.manage（唯一有效形态） */
  global: boolean;
};

export function deriveCampusManageAccess(
  context: Parameters<typeof hasPermission>[0],
): CampusManageAccess {
  if (!context || !context.accountActive) {
    return { global: false };
  }
  // 不传 targetCampusId：CAMPUS grant 一律不命中 → GLOBAL-only 语义
  return { global: hasPermission(context, CAMPUS_MANAGE_PERMISSION) };
}

/** root gate / 导航可见性用。 */
export function hasAnyCampusManageAccess(access: CampusManageAccess): boolean {
  return access.global;
}

export type CampusManagerPageSession = {
  user: Awaited<ReturnType<typeof requireUser>>;
};

/**
 * /governance/campuses 页面统一入口（每次请求独立执行，绝不缓存）：
 *   requireUser()（session → DB ACTIVE 复查 → consent）
 *   → loadAuthorizationContext
 *   → deriveCampusManageAccess
 *   → 非 GLOBAL campus.manage → notFound()（不泄露治理面存在性）。
 *
 * 与 legacy requireAdmin() 完全分离；canonical mutation（campus-governance
 * service）在锁内经 requirePermissionInContext 独立复核，本门只是子树自守。
 */
export async function requireCampusManager(): Promise<CampusManagerPageSession> {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveCampusManageAccess(context);

  if (!access.global) {
    notFound();
  }

  return { user };
}
