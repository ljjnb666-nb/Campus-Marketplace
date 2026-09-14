import { notFound } from "next/navigation";

import { deriveAppealReviewAccess } from "@/lib/appeals/reviewer-access";
import {
  deriveListingModerationAccess,
  hasAnyListingModerationAccess,
} from "@/lib/moderation/listing-moderation-access";
import {
  deriveRoleManageAccess,
  hasAnyRoleManageAccess,
} from "@/lib/rbac/role-manage-access";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";

/**
 * Phase 7A：/governance 独立路由树（Planning 冻结：绝不置于 /admin 子树）。
 *
 * Phase 7B：root gate 扩宽为 appealReview OR roleManage 的 union。
 * Phase 7C：root gate 再扩宽为 OR listingModeration 的三元 union。三棵子树
 * 仍各自自守：/governance/appeals 走 requireAppealReviewer，/governance/roles
 * 自守 roleManage access，/governance/listings 自守 listing moderation
 * access（双层纵深不变，sibling 互不扩权）。requireAdmin() 零修改，
 * legacy /admin 隔离不变（hasFullAdminSurfaceAccess 对 campus grant /
 * 非全量 GLOBAL grant 恒 false）。私有治理数据：强制动态渲染，零缓存。
 */
export const dynamic = "force-dynamic";

export default async function GovernanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const appealAccess = deriveAppealReviewAccess(context);
  const roleManageAccess = deriveRoleManageAccess(context);
  const listingModerationAccess = deriveListingModerationAccess(context);

  const hasAppealAccess =
    appealAccess.global || appealAccess.campusIds.length > 0;
  if (
    !hasAppealAccess &&
    !hasAnyRoleManageAccess(roleManageAccess) &&
    !hasAnyListingModerationAccess(listingModerationAccess)
  ) {
    notFound();
  }

  return <div className="min-h-screen bg-slate-50">{children}</div>;
}
