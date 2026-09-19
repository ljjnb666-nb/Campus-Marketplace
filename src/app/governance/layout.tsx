import Link from "next/link";
import { notFound } from "next/navigation";

import { deriveAppealReviewAccess } from "@/lib/appeals/reviewer-access";
import { deriveAuditAccess, hasAnyAuditAccess } from "@/lib/audit/audit-access";
import { deriveVerificationReviewAccess, hasAnyVerificationReviewAccess } from "@/lib/campus/verification-review-access";
import {
  deriveEnforcementReadAccess,
  hasAnyEnforcementReadAccess,
} from "@/lib/enforcement/enforcement-read-access";
import {
  deriveListingModerationAccess,
  hasAnyListingModerationAccess,
} from "@/lib/moderation/listing-moderation-access";
import {
  deriveReportReviewAccess,
  hasAnyReportReviewAccess,
} from "@/lib/reports/report-access";
import {
  deriveRoleManageAccess,
  hasAnyRoleManageAccess,
} from "@/lib/rbac/role-manage-access";
import {
  deriveUserOperationsAccess,
  hasAnyUserOperationsAccess,
} from "@/lib/governance/user-operations-access";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";

/**
 * Phase 7A：/governance 独立路由树（Planning 冻结：绝不置于 /admin 子树）。
 *
 * Phase 7B：root gate 扩宽为 appealReview OR roleManage 的 union。
 * Phase 7C：root gate 再扩宽为 OR listingModeration 的三元 union。
 * Phase 7D：root gate 扩为五元 union（OR audit ∨ enforcementRead），并首次
 * 提供治理控制台跨区导航——**导航可见性由精确 capability 派生**：无权限
 * sibling 一律不渲染链接（不得因 root access 显示无权限 sibling）。
 * Phase 7E：root gate 扩为六元 union（OR reportReview——report.review 是
 * pre-7D legacy 11-key 的既有 capability，此处仅以 CAMPUS scope 供给治理面，
 * 不改 legacy /admin 判定）。
 * Phase 7F：root gate 扩为八元 union（OR verificationReview ∨ userOperations
 * ——前者是既有 verification.review capability 的 CAMPUS scope 供给，后者是
 * GLOBAL user.suspend ONLY 的用户运营面）。
 *
 * 八棵子树仍各自自守（双层纵深不变，sibling 互不扩权）：
 * /governance/appeals 走 requireAppealReviewer，/governance/roles 自守
 * roleManage access，/governance/listings 自守 listing moderation access，
 * /governance/audit 自守 audit read access，/governance/enforcement 自守
 * enforcement read access，/governance/reports 自守 report review access，
 * /governance/verifications 自守 verification review access，
 * /governance/users 自守 GLOBAL user.suspend。requireAdmin() 零修改，
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
  const auditAccess = deriveAuditAccess(context);
  const enforcementAccess = deriveEnforcementReadAccess(context);
  const reportAccess = deriveReportReviewAccess(context);
  const verificationAccess = deriveVerificationReviewAccess(context);
  const userOperationsAccess = deriveUserOperationsAccess(context);

  const hasAppealAccess =
    appealAccess.global || appealAccess.campusIds.length > 0;
  if (
    !hasAppealAccess &&
    !hasAnyRoleManageAccess(roleManageAccess) &&
    !hasAnyListingModerationAccess(listingModerationAccess) &&
    !hasAnyAuditAccess(auditAccess) &&
    !hasAnyEnforcementReadAccess(enforcementAccess) &&
    !hasAnyReportReviewAccess(reportAccess) &&
    !hasAnyVerificationReviewAccess(verificationAccess) &&
    !hasAnyUserOperationsAccess(userOperationsAccess)
  ) {
    notFound();
  }

  // 导航可见性 = 精确 capability（root union 放行 ≠ sibling 可见）
  const navItems = [
    { href: "/governance/appeals", label: "申诉审核", visible: hasAppealAccess },
    {
      href: "/governance/roles",
      label: "角色管理",
      visible: hasAnyRoleManageAccess(roleManageAccess),
    },
    {
      href: "/governance/listings",
      label: "列表治理",
      visible: hasAnyListingModerationAccess(listingModerationAccess),
    },
    { href: "/governance/audit", label: "审计日志", visible: hasAnyAuditAccess(auditAccess) },
    {
      href: "/governance/enforcement",
      label: "执法记录",
      visible: hasAnyEnforcementReadAccess(enforcementAccess),
    },
    {
      href: "/governance/reports",
      label: "举报处理",
      visible: hasAnyReportReviewAccess(reportAccess),
    },
    {
      href: "/governance/verifications",
      label: "认证审核",
      visible: hasAnyVerificationReviewAccess(verificationAccess),
    },
    {
      href: "/governance/users",
      label: "用户管理",
      visible: hasAnyUserOperationsAccess(userOperationsAccess),
    },
  ].filter((item) => item.visible);

  return (
    <div className="min-h-screen bg-slate-50">
      <nav
        aria-label="治理控制台"
        className="sticky top-0 z-10 border-b border-slate-200 bg-white"
      >
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
          <span className="mr-2 text-sm font-semibold text-slate-950">治理控制台</span>
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
            >
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
      {children}
    </div>
  );
}
