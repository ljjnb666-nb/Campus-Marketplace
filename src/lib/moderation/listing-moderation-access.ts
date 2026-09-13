import { notFound } from "next/navigation";

import type { AuthorizationContext } from "@/lib/rbac/service";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";

/**
 * Phase 7C：listing 治理 access 派生 SSOT（纯函数，DEFAULT_DENY）。
 *
 * 语义与中央 RBAC `hasPermission` / 7A `deriveAppealReviewAccess` /
 * 7B `deriveRoleManageAccess` 逐条同构：
 * - null / 非激活账号 → 空 access；
 * - GLOBAL grant 含 listing.moderate → global=true（不要求任何 membership，
 *   与 hasPermission 的 GLOBAL-supersedes-campus 合同一致）；
 * - CAMPUS grant 含 listing.moderate@A → 仅当 A ∈ activeCampusIds（grant ∧
 *   ACTIVE membership 同时成立）才纳入 campusIds；
 * - campusIds 去重；绝不读取 User.role 字段。
 *
 * 本派生仅供发现/呈现（页面入口判定、队列 campus 过滤、UI 提示）；
 * canonical moderation mutation（锁后 loadAuthorizationContext + exact-campus
 * 授权）始终是最终权威。
 */

export const LISTING_MODERATE_PERMISSION = "listing.moderate";

export type ListingModerationAccess = {
  /** GLOBAL listing.moderate：可处置任意校区 listing */
  global: boolean;
  /** 有效的 campus-scoped 处置 scope（grant ∧ ACTIVE membership 已求交） */
  campusIds: string[];
};

export function deriveListingModerationAccess(
  context: AuthorizationContext | null,
): ListingModerationAccess {
  const access: ListingModerationAccess = { global: false, campusIds: [] };
  if (!context || !context.accountActive) {
    return access;
  }

  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes(LISTING_MODERATE_PERMISSION)) {
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

/** 单个 campus 的处置授权判定（与 hasPermission 同语义）。 */
export function canModerateCampus(
  access: ListingModerationAccess,
  campusId: string,
): boolean {
  return access.global || access.campusIds.includes(campusId);
}

/** 治理树 root gate 的 union 分量：是否具备任一 listing 处置 scope。 */
export function hasAnyListingModerationAccess(access: ListingModerationAccess): boolean {
  return access.global || access.campusIds.length > 0;
}

// ── 治理页入口 resolver（独立于 requireAdmin，零桥接）────────────────────────

export type ListingModeratorPageSession = {
  user: Awaited<ReturnType<typeof requireUser>>;
  context: AuthorizationContext;
  access: ListingModerationAccess;
};

/**
 * /governance/listings 页面统一入口（每次请求独立执行，绝不缓存）：
 *   requireUser() → loadAuthorizationContext → deriveListingModerationAccess
 *   → 无任何有效 scope → notFound()（不泄露治理面存在性）。
 *
 * 与 legacy requireAdmin() 完全分离：campus-scoped moderator 通过本门，
 * 但 hasFullAdminSurfaceAccess 对其恒 false（/admin 不可入，7A 隔离不变）。
 */
export async function requireListingModerator(): Promise<ListingModeratorPageSession> {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveListingModerationAccess(context);

  if (!context || (!access.global && access.campusIds.length === 0)) {
    notFound();
  }

  return { user, context, access };
}
