import { GLOBAL_SCOPE_KEY } from "@/lib/rbac/roles";

/**
 * Phase 6B 风险作用域编码（与 Phase 6A UserRoleAssignment 同一 scopeKey 方案，
 * 解决 Postgres nullable unique 不把 NULL 视为相等的问题）。
 */

export { GLOBAL_SCOPE_KEY };

/** CAMPUS 作用域行的 scopeKey 编码（与 campusId 的一致性由 service 维护）。 */
export function riskScopeKey(campusId: string | null): string {
  return campusId == null ? GLOBAL_SCOPE_KEY : `CAMPUS:${campusId}`;
}

/** 显式风险状态机（禁止任意跳转；同状态重复设置为幂等 no-op）。 */
export const RISK_STATE_TRANSITIONS: Record<string, string[]> = {
  NORMAL: ["WATCH", "RESTRICTED"],
  WATCH: ["NORMAL", "RESTRICTED"],
  RESTRICTED: ["NORMAL", "WATCH"],
};

export function assertRiskStateTransition(
  from: string | null,
  to: string,
): void {
  // 无行 = NORMAL（真实默认态）
  if ((from ?? "NORMAL") === to) {
    return; // 幂等
  }
  if (!RISK_STATE_TRANSITIONS[from ?? "NORMAL"]?.includes(to)) {
    throw new Error(`RISK_STATE_INVALID_TRANSITION:${from ?? "NORMAL"}->${to}`);
  }
}

/** EnforcementAction 的 resultState 快照编码（仅历史证据，非 operational source）。 */
export function resultStateFor(kind: "USER" | "CAMPUS_MEMBERSHIP" | "RISK_STATE", value: string, campusId?: string | null): string {
  if (kind === "RISK_STATE") {
    return `RISK_STATE:${value}@${riskScopeKey(campusId ?? null)}`;
  }
  return `${kind}:${value}`;
}
