import { notFound } from "next/navigation";

import { requireUser } from "@/lib/server-auth";
import {
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@/lib/rbac/service";

/**
 * Phase 7G：dispute reviewer 有效 access 派生（纯函数，DEFAULT_DENY）。
 *
 * 语义与中央 RBAC `hasPermission` / 7A `deriveAppealReviewAccess` 逐条同构：
 * - null / 非激活账号 → 空 access；
 * - GLOBAL grant 含 dispute.review → global=true（不要求任何 membership，
 *   与 hasPermission 的 GLOBAL-supersedes-campus 合同一致 → 全部 dispute 校区）；
 * - CAMPUS grant 含 dispute.review@A → 仅当 A ∈ activeCampusIds（grant ∧
 *   ACTIVE membership 同时成立）才纳入 campusIds（→ 仅 exact campus A）；
 * - campusIds 去重；绝不读取 User.role 字段。
 *
 * permission 为 7G 新增 dispute.review（不在 legacy 11-key 集合内——
 * requireAdmin 资格与 privileged-target 分类零变化）。
 * 本派生仅供发现/呈现与查询分支构造；canonical mutation（claim/release/
 * resolve/close 锁后授权重读）始终是最终权威。
 */

export const DISPUTE_REVIEW_PERMISSION = "dispute.review" as const;
export const DISPUTE_EVIDENCE_PERMISSION = "dispute.evidence.read" as const;

export type DisputeReviewAccess = {
  /** GLOBAL dispute.review：可发现全部 dispute 校区 */
  global: boolean;
  /** 有效的 campus-scoped 审核 scope（grant ∧ ACTIVE membership 已求交） */
  campusIds: string[];
};

export function deriveDisputeReviewAccess(
  context: AuthorizationContext | null,
): DisputeReviewAccess {
  const access: DisputeReviewAccess = { global: false, campusIds: [] };
  if (!context || !context.accountActive) {
    return access;
  }

  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes(DISPUTE_REVIEW_PERMISSION)) {
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

/**
 * 单个 campus 的授权判定（与 hasPermission 同语义）：
 * GLOBAL 读者放行任意校区；campus reviewer 仅 exact campus。
 */
export function canReviewDisputeCampus(
  access: DisputeReviewAccess,
  campusId: string,
): boolean {
  return access.global || access.campusIds.includes(campusId);
}

/** root gate / 导航可见性用：是否持有任何有效 dispute review scope。 */
export function hasAnyDisputeReviewAccess(access: DisputeReviewAccess): boolean {
  return access.global || access.campusIds.length > 0;
}

// ── Phase 7G 治理页入口 resolver（独立于 requireAdmin，零桥接）────────────────

export type DisputeReviewerPageSession = {
  user: Awaited<ReturnType<typeof requireUser>>;
  context: AuthorizationContext;
  access: DisputeReviewAccess;
};

/**
 * /governance/disputes 页面统一入口（每次请求独立执行，绝不缓存）：
 *   requireUser()（session → DB ACTIVE 复查 → consent）
 *   → loadAuthorizationContext
 *   → deriveDisputeReviewAccess
 *   → 无任何有效 scope → notFound()（不泄露治理面存在性）。
 *
 * 与 legacy requireAdmin() 完全分离：CAMPUS_DISPUTE_REVIEWER 经本门进入，
 * 但 hasFullAdminSurfaceAccess 对其恒 false（7A 隔离不变）。
 */
export async function requireDisputeReviewer(): Promise<DisputeReviewerPageSession> {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveDisputeReviewAccess(context);

  if (!context || (!access.global && access.campusIds.length === 0)) {
    notFound();
  }

  return { user, context, access };
}
