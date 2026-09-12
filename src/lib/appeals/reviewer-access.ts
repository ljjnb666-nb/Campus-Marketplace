import type { AppealStatus } from "@prisma/client";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/server-auth";
import { loadAuthorizationContext, hasPermission, type AuthorizationContext } from "@/lib/rbac/service";
import type { AppealReviewScope } from "@/lib/appeals/review-scope";

/**
 * Phase 7A：reviewer 有效申诉审核 access 派生（纯函数，DEFAULT_DENY）。
 *
 * 语义与中央 RBAC `hasPermission` 逐条同构：
 * - null / 非激活账号 → 空 access（不可进入治理面）；
 * - GLOBAL grant 含 appeal.review → global=true（**不要求任何 membership**，
 *   与 hasPermission 的 GLOBAL-supersedes-campus 合同一致——Repair 1 冻结）；
 * - CAMPUS grant 含 appeal.review@A → 仅当 A ∈ activeCampusIds（grant ∧
 *   ACTIVE membership 同时成立）才纳入 campusIds；
 * - campusIds 去重；绝不读取 User.role 字段。
 *
 * 本派生仅供发现/呈现（页面入口判定、队列分支、capability hints）；
 * canonical 域 mutation（beginAppealReview / decideAppeal 锁后
 * requireAppealReviewAuthorization）始终是最终权威。
 */

export type AppealReviewAccess = {
  /** GLOBAL appeal.review：可发现全部 canonical scope（GLOBAL + 任意校区） */
  global: boolean;
  /** 有效的 campus-scoped 审核 scope（grant ∧ ACTIVE membership 已求交） */
  campusIds: string[];
};

export function deriveAppealReviewAccess(
  context: AuthorizationContext | null,
): AppealReviewAccess {
  const access: AppealReviewAccess = { global: false, campusIds: [] };
  if (!context || !context.accountActive) {
    return access;
  }

  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes("appeal.review")) {
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
 * 单个 canonical scope 的发现/呈现授权判定（与 hasPermission 同语义）：
 * GLOBAL scope 仅 global reviewer 可见；CAMPUS scope 对 global reviewer
 * 或该校区有效 grant 放行。
 */
export function canReviewScope(
  access: AppealReviewAccess,
  scope: AppealReviewScope,
): boolean {
  if (scope.kind === "GLOBAL") {
    return access.global;
  }
  return access.global || access.campusIds.includes(scope.campusId);
}

// ── Phase 7A 治理页入口 resolver（独立于 requireAdmin，零桥接）────────────────

export type AppealReviewerPageSession = {
  user: Awaited<ReturnType<typeof requireUser>>;
  context: AuthorizationContext;
  access: AppealReviewAccess;
};

/**
 * /governance/** 页面统一入口（每次请求独立执行，绝不缓存、绝不信任
 * 队列渲染结果作为持久授权）：
 *   requireUser()（session → DB ACTIVE 复查 → consent，frozen GOVERNANCE_
 *   OPERATOR_REQUIRE_CONSENT = YES）
 *   → loadAuthorizationContext
 *   → deriveAppealReviewAccess
 *   → 无任何有效 scope → notFound()（不泄露治理面存在性）。
 *
 * 与 legacy requireAdmin() 完全分离：campus-scoped reviewer 通过本门，
 * 但 hasFullAdminSurfaceAccess 对其恒 false（/admin 不可入，Phase 7A 隔离证明）。
 */
export async function requireAppealReviewer(): Promise<AppealReviewerPageSession> {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveAppealReviewAccess(context);

  if (!context || (!access.global && access.campusIds.length === 0)) {
    notFound();
  }

  return { user, context, access };
}

// ── capability hints（W1 呈现便利，域服务恒为最终权威）────────────────────────

export type AppealReviewCapabilities = {
  canBeginReview: boolean;
  canUphold: boolean;
  canGrant: boolean;
};

/**
 * 服务端逐请求计算的 UI 便利提示（Planning §24 冻结）：
 * - canBeginReview：W1 下仅 SUBMITTED 呈现"开始审核"；
 * - canUphold：W1 下仅 IN_REVIEW 呈现终局控件（域仍允许 SUBMITTED→terminal，
 *   UI 只是收敛呈现，不改状态机）；
 * - canGrant：canUphold ∧ 恢复权（GLOBAL scope→GLOBAL user.suspend；
 *   CAMPUS scope→exact campus campus.manage）——纯 hasPermission 探测，
 *   绝不复刻恢复/溯源逻辑；程序性条件由域在锁内判定。
 * 伪造 GRANTED 提交仍被 canonical restoreFromAppealTxLocked 的 seam 权限
 * 复核拒绝并整体回滚（A-15）。
 */
export function deriveAppealReviewCapabilities(input: {
  context: AuthorizationContext | null;
  status: AppealStatus;
  scope: AppealReviewScope;
}): AppealReviewCapabilities {
  const access = deriveAppealReviewAccess(input.context);
  const scopeAuthorized = canReviewScope(access, input.scope);
  const canBeginReview = scopeAuthorized && input.status === "SUBMITTED";
  const canUphold = scopeAuthorized && input.status === "IN_REVIEW";
  const canGrant =
    canUphold &&
    (input.scope.kind === "GLOBAL"
      ? hasPermission(input.context, "user.suspend")
      : hasPermission(input.context, "campus.manage", input.scope.campusId));

  return { canBeginReview, canUphold, canGrant };
}
