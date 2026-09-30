/**
 * Phase 7G：campus-scoped dispute canonical scope 的唯一事实源（SSOT）。
 * Phase 8C-02 起同时服务 RentalDispute 与 General OrderDispute 两个独立
 * aggregate（同构 (campusId, scopeKey) 合同，scope 逻辑零改写）。
 *
 * scope 冻结（指令）：来源唯一 = dispute 创建时从各自订单 → 标的 listing /
 * errand task 的 campusId immutable 快照：
 *   campusId 非空 + scopeKey = CAMPUS:<campusId>。
 * dispute 恒 campus-scoped（无 UNSCOPED 分支）；DB CHECK
 * （RentalDispute_scope_pair_check / OrderDispute 同款）使 malformed 结构
 * 不可能，读取面仍 fail closed。
 *
 * 禁止以 User.campusId / initiator / 当事人的 membership 作为
 * dispute authorization truth（directive 冻结）。
 */

/**
 * 两类 dispute 共享的 lifecycle 状态（字符串字面量，不再绑定
 * RentalDisputeStatus enum——两个 aggregate 的状态值集合一致）。
 */
export type DisputeLifecycleStatus = "OPEN" | "IN_REVIEW" | "RESOLVED" | "CLOSED";

export const DISPUTE_ACTIVE_STATUSES: readonly DisputeLifecycleStatus[] = ["OPEN", "IN_REVIEW"];

export type DisputeReviewScope = { kind: "CAMPUS"; campusId: string };

/** CAMPUS 形状 scopeKey 派生（与 campusScopeKey / reportCampusScopeKey 同规则）。 */
export function disputeCampusScopeKey(campusId: string): string {
  return `CAMPUS:${campusId}`;
}

/**
 * 从 immutable (campusId, scopeKey) 快照解析 canonical scope（fail closed）。
 * 返回 null = malformed（campusId 缺失 / scopeKey 不构成 exact pair）——
 * 调用方一律拒绝（读面 notFound / 不可发现；DB CHECK 下结构不可能，纵深防御）。
 */
export function resolveDisputeScope(row: {
  campusId: string | null;
  scopeKey: string;
}): DisputeReviewScope | null {
  if (
    row.campusId !== null &&
    row.scopeKey === disputeCampusScopeKey(row.campusId)
  ) {
    return { kind: "CAMPUS", campusId: row.campusId };
  }
  return null;
}

/**
 * 队列 WHERE 的单个校区 exact-pair 分支（campusId 与 scopeKey 同源派生）。
 * 禁止 `campusId IN (...) ∧ scopeKey IN (...)` 叉积（7A Repair 1 同款冻结）。
 */
export function disputeReviewCampusBranch(campusId: string): {
  campusId: string;
  scopeKey: string;
} {
  return { campusId, scopeKey: disputeCampusScopeKey(campusId) };
}
