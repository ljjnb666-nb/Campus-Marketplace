import { notFound } from "next/navigation";

import { requireUser } from "@/lib/server-auth";
import {
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@/lib/rbac/service";

/**
 * Phase 7F：verification reviewer 有效 access 派生（纯函数，DEFAULT_DENY）。
 *
 * 语义与中央 RBAC `hasPermission` / 7A deriveAppealReviewAccess / 7E
 * deriveReportReviewAccess 逐条同构：
 * - null / 非激活账号 → 空 access；
 * - GLOBAL grant 含 verification.review → global=true（不要求任何 membership，
 *   与 hasPermission 的 GLOBAL-supersedes-campus 合同一致）；
 * - CAMPUS grant 含 verification.review@A → 仅当 A ∈ activeCampusIds（grant ∧
 *   ACTIVE membership 同时成立）才纳入 campusIds；
 * - campusIds 去重；绝不读取 User.role 字段。
 *
 * 授权模型（Phase 7F 冻结）：唯一 scope truth =
 * UserVerification.membership.campusId（禁止 User.campusId / User.schoolName /
 * campusName 文本）。Campus reviewer 可见 membership.campusId exact match 且
 * membership.status = ACTIVE 的认证；GLOBAL 可见全部 valid scope。
 * 本派生仅供发现/呈现与查询分支构造，canonical mutation
 * （decideMembershipVerification 锁后授权重读）始终是最终权威。
 */

export const VERIFICATION_REVIEW_PERMISSION = "verification.review" as const;

export type VerificationReviewAccess = {
  /** GLOBAL verification.review：可发现全部 valid verification scope */
  global: boolean;
  /** 有效的 campus-scoped 审核 scope（grant ∧ ACTIVE membership 已求交） */
  campusIds: string[];
};

export function deriveVerificationReviewAccess(
  context: AuthorizationContext | null,
): VerificationReviewAccess {
  const access: VerificationReviewAccess = { global: false, campusIds: [] };
  if (!context || !context.accountActive) {
    return access;
  }

  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes(VERIFICATION_REVIEW_PERMISSION)) {
      continue;
    }
    if (grant.scope === "GLOBAL") {
      access.global = true;
    } else if (
      grant.campusId !== null &&
      context.activeCampusIds.includes(grant.campusId)
    ) {
      if (!access.campusIds.includes(grant.campusId)) {
        access.campusIds.push(grant.campusId);
      }
    }
  }

  return access;
}

/** 单校区授权判定（与 hasPermission 同语义；GLOBAL 或该校区有效 grant 放行）。 */
export function canReviewVerificationCampus(
  access: VerificationReviewAccess,
  campusId: string,
): boolean {
  return access.global || access.campusIds.includes(campusId);
}

// ── Phase 7F 治理页入口 resolver（独立于 requireAdmin，零桥接）────────────────

export type VerificationReviewerPageSession = {
  user: Awaited<ReturnType<typeof requireUser>>;
  context: AuthorizationContext;
  access: VerificationReviewAccess;
};

/**
 * /governance/verifications 页面统一入口（每次请求独立执行，绝不缓存）：
 *   requireUser()（session → DB ACTIVE 复查 → consent）
 *   → loadAuthorizationContext
 *   → deriveVerificationReviewAccess
 *   → 无任何有效 scope → notFound()（不泄露治理面存在性）。
 *
 * 与 legacy requireAdmin() 完全分离：CAMPUS_VERIFICATION_REVIEWER 经本门进入，
 * 但 hasFullAdminSurfaceAccess 对其恒 false（7A 隔离不变）。
 */
export async function requireVerificationReviewer(): Promise<VerificationReviewerPageSession> {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveVerificationReviewAccess(context);

  if (!context || (!access.global && access.campusIds.length === 0)) {
    notFound();
  }

  return { user, context, access };
}

/** root gate / 导航可见性用：是否持有任何有效 verification review scope。 */
export function hasAnyVerificationReviewAccess(access: VerificationReviewAccess): boolean {
  return access.global || access.campusIds.length > 0;
}
