import type { EnforcementActionType } from "@prisma/client";

/**
 * Phase 7A：Appeal review canonical scope 的唯一事实源（SSOT）。
 *
 * `resolveAppealReviewScope` 逐字自 appeal-review-service.ts 搬移（零语义变化）：
 * 域 mutation（beginAppealReview / decideAppeal 锁后复核）与 Phase 7A 读面
 * （队列分支 builder / 详情授权）必须消费同一实现，禁止任何复制。
 *
 * canonical 形状（与 6C-1A enforcement 写入方 riskScopeKey 同一派生规则）：
 * - ACCOUNT_SUSPEND：campusId=null + scopeKey=GLOBAL → GLOBAL；
 * - MEMBERSHIP_SUSPEND：campusId 非空 + scopeKey=CAMPUS:<campusId> → CAMPUS(campusId)；
 * - MARKETPLACE_RESTRICT：GLOBAL 形（campusId=null + GLOBAL）或 CAMPUS 精确对
 *   （campusId 非空 + CAMPUS:<campusId>）。
 * type/campusId/scopeKey 三者不一致（malformed 行）→ null：fail closed。
 * restorative 类型（ACCOUNT_REINSTATE / MEMBERSHIP_REINSTATE / MARKETPLACE_RESTORE）
 * → null：永不可审核、永不可发现。
 *
 * 队列查询分支（exact-pair，Repair 1 冻结）：每个分支是 (type, campusId, scopeKey)
 * 的精确合取，campusId 与 scopeKey 由同一 campusId 派生——**禁止**
 * `campusId IN (...) ∧ scopeKey IN (...)` 叉积（会命中 malformed 交叉对）。
 */

export type AppealReviewScope = { kind: "GLOBAL" } | { kind: "CAMPUS"; campusId: string };

/** GLOBAL 形状的合法执法类型（仅 ACCOUNT_SUSPEND 与 GLOBAL 形 MARKETPLACE_RESTRICT）。 */
export const APPEAL_REVIEW_GLOBAL_TYPES = [
  "ACCOUNT_SUSPEND",
  "MARKETPLACE_RESTRICT",
] as const;

/** CAMPUS 形状的合法执法类型（exact pair：campusId=c ∧ scopeKey=CAMPUS:c）。 */
export const APPEAL_REVIEW_CAMPUS_TYPES = [
  "MEMBERSHIP_SUSPEND",
  "MARKETPLACE_RESTRICT",
] as const;

/** CAMPUS 形状 scopeKey 派生（与 enforcement riskScopeKey 同规则）。 */
export function appealReviewCampusScopeKey(campusId: string): string {
  return `CAMPUS:${campusId}`;
}

/** 队列 WHERE 的 GLOBAL 形状分支（Appeal.enforcementAction 过滤，精确三元）。 */
export function appealReviewGlobalBranch(): {
  type: { in: EnforcementActionType[] };
  campusId: null;
  scopeKey: string;
} {
  return {
    type: { in: [...APPEAL_REVIEW_GLOBAL_TYPES] },
    campusId: null,
    scopeKey: "GLOBAL",
  };
}

/** 队列 WHERE 的单个校区 exact-pair 分支（campusId 与 scopeKey 同源派生）。 */
export function appealReviewCampusBranch(campusId: string): {
  type: { in: EnforcementActionType[] };
  campusId: string;
  scopeKey: string;
} {
  return {
    type: { in: [...APPEAL_REVIEW_CAMPUS_TYPES] },
    campusId,
    scopeKey: appealReviewCampusScopeKey(campusId),
  };
}

/**
 * 从 immutable EnforcementAction 解析并校验 canonical review scope（fail closed）。
 * 返回 null = 无法确立审核 scope（malformed / restorative 类型），
 * 调用方一律拒绝（域内 APPEAL_REVIEW_FORBIDDEN；读面 notFound/不可发现）。
 */
export function resolveAppealReviewScope(action: {
  type: EnforcementActionType;
  campusId: string | null;
  scopeKey: string;
}): AppealReviewScope | null {
  switch (action.type) {
    case "ACCOUNT_SUSPEND":
      return action.campusId === null && action.scopeKey === "GLOBAL"
        ? { kind: "GLOBAL" }
        : null;
    case "MEMBERSHIP_SUSPEND":
      return action.campusId !== null && action.scopeKey === `CAMPUS:${action.campusId}`
        ? { kind: "CAMPUS", campusId: action.campusId }
        : null;
    case "MARKETPLACE_RESTRICT":
      if (action.campusId === null && action.scopeKey === "GLOBAL") {
        return { kind: "GLOBAL" };
      }
      if (action.campusId !== null && action.scopeKey === `CAMPUS:${action.campusId}`) {
        return { kind: "CAMPUS", campusId: action.campusId };
      }
      return null;
    default:
      return null;
  }
}
