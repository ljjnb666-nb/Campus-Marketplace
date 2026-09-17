import type { ReportTargetType } from "@prisma/client";

/**
 * Phase 7E：Report canonical scope 快照的唯一事实源（SSOT）。
 *
 * frozen fail-closed rule（规划冻结）：
 * - PRODUCT / ERRAND_TASK / SERVICE_LISTING / RENTAL_LISTING → 目标对象
 *   campusId 快照，scopeKey = `CAMPUS:<campusId>`（目标对象不存在或 campus
 *   不可解析 → UNSCOPED，绝不猜测）；
 * - USER / MESSAGE → 恒 UNSCOPED（campusId = null）——禁止从
 *   User.campusId / sender campus 推断（同 6B resolveReportTargetContext
 *   既有语义，此处仅把派生规则收敛为唯一实现）。
 *
 * 快照创建后 immutable：任何读取面（queue/detail 授权谓词、campus 过滤）
 * 必须消费 (campusId, scopeKey) exact pair，禁止只按 campusId IN (...) 放行
 * （会命中 malformed 交叉对——DB CHECK 使其结构不可能，读取面仍 fail closed）。
 */

export const UNSCOPED_SCOPE_KEY = "UNSCOPED";
export const GLOBAL_SCOPE_KEY_VALUE = "GLOBAL";

/** CAMPUS 形状 scopeKey 派生（与 campusScopeKey / riskScopeKey 同规则）。 */
export function reportCampusScopeKey(campusId: string): string {
  return `CAMPUS:${campusId}`;
}

/** 四类 listing 目标：campus 可解析则 CAMPUS 快照，否则 fail-closed 落 UNSCOPED。 */
const CAMPUS_SCOPED_TARGET_TYPES: ReadonlySet<ReportTargetType> = new Set([
  "PRODUCT",
  "ERRAND_TASK",
  "SERVICE_LISTING",
  "RENTAL_LISTING",
]);

export type ReportScopeSnapshot = {
  campusId: string | null;
  scopeKey: string;
};

/**
 * 由 target context 解析结果派生 immutable scope 快照（创建路径唯一入口）。
 * - listing 目标 + campusId 非空 → (campusId, CAMPUS:<campusId>)；
 * - USER / MESSAGE，或 campus 不可解析 → (null, UNSCOPED)。
 */
export function deriveReportScopeSnapshot(
  targetType: ReportTargetType,
  targetCampusId: string | null,
): ReportScopeSnapshot {
  if (CAMPUS_SCOPED_TARGET_TYPES.has(targetType) && targetCampusId !== null) {
    return { campusId: targetCampusId, scopeKey: reportCampusScopeKey(targetCampusId) };
  }
  return { campusId: null, scopeKey: UNSCOPED_SCOPE_KEY };
}

/** 读取/授权面的 canonical scope 形状。 */
export type ReportReviewScope = { kind: "UNSCOPED" } | { kind: "CAMPUS"; campusId: string };

/**
 * 从 immutable (campusId, scopeKey) 快照解析 canonical scope（fail closed）。
 * 返回 null = malformed（campusId/scopeKey 不构成合法对）——调用方一律拒绝
 * （读面 notFound / 不可发现；DB CHECK 下结构不可能，此处为纵深防御）。
 */
export function resolveReportReviewScope(row: {
  campusId: string | null;
  scopeKey: string;
}): ReportReviewScope | null {
  if (row.scopeKey === UNSCOPED_SCOPE_KEY) {
    return row.campusId === null ? { kind: "UNSCOPED" } : null;
  }
  if (
    row.campusId !== null &&
    row.scopeKey === reportCampusScopeKey(row.campusId)
  ) {
    return { kind: "CAMPUS", campusId: row.campusId };
  }
  return null;
}

/**
 * 队列 WHERE 的单个校区 exact-pair 分支（campusId 与 scopeKey 同源派生）。
 * 禁止 `campusId IN (...) ∧ scopeKey IN (...)` 叉积（7A Repair 1 同款冻结）。
 */
export function reportReviewCampusBranch(campusId: string): {
  campusId: string;
  scopeKey: string;
} {
  return { campusId, scopeKey: reportCampusScopeKey(campusId) };
}

/** 队列 WHERE 的 UNSCOPED 分支（仅 GLOBAL 读者进入）。 */
export function reportReviewUnscopedBranch(): {
  campusId: null;
  scopeKey: string;
} {
  return { campusId: null, scopeKey: UNSCOPED_SCOPE_KEY };
}
