import { notFound } from "next/navigation";

import { deriveAppealReviewAccess } from "@/lib/appeals/reviewer-access";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";

/**
 * Phase 7A：/governance 独立路由树（Planning 冻结：绝不置于 /admin 子树）。
 *
 * 路由级授权门（与页面级 requireAppealReviewer 双层纵深）：campus-scoped
 * 申诉审核员经此进入治理面；requireAdmin() 零修改，legacy /admin 隔离不变
 * （hasFullAdminSurfaceAccess 对 campus grant / 非全量 GLOBAL grant 恒 false）。
 * 私有治理数据：强制动态渲染，零缓存。
 */
export const dynamic = "force-dynamic";

export default async function GovernanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveAppealReviewAccess(context);

  if (!access.global && access.campusIds.length === 0) {
    notFound();
  }

  return <div className="min-h-screen bg-slate-50">{children}</div>;
}
