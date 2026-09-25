import type { Prisma } from "@prisma/client";

import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import {
  loadAuthorizationContext,
  requirePermissionInContext,
  type AuthorizationContext,
} from "@/lib/rbac/service";
import type { PermissionKey } from "@/lib/rbac/permissions";

/**
 * RB-05 GOVERNANCE_MUTATION_AUTHORITY：
 *
 * 治理/管理员发起的 durable mutation 的 canonical 权威判定必须与业务写、
 * 审计写同处一个 locked transaction，且顺序冻结为全局锁序：
 *
 *   optional beforeLock 测试 seam
 *   → USER:<actorId> governance subject 锁
 *     （与 assignRole/revokeRole 的 sorted {USER:actor, USER:target} 同
 *     命名空间、同键——target 即本 actor 时两路径共享同一锁，形成严格
 *     serializable authority boundary：revoke 先提交 → stale mutation
 *     锁内 fresh 复核被拒；mutation 先持锁 → revoke 真实排队等待）
 *   → loadAuthorizationContext 锁内重读（fresh，非入口快照）
 *   → requirePermissionInContext 精确 permission（DEFAULT_DENY；inactive
 *     actor 一并拒绝）
 *   → optional afterCheck 测试 seam
 *   → 返回 fresh context（调用方继续 domain write → same-tx audit → commit）
 *
 * entry auth（requireAdmin / hasFullAdminSurfaceAccess 等）只是 legacy
 * /admin 粗粒度入口门 + 身份发现，ENTRY AUTH != MUTATION AUTHORITY：
 * 入口快照可能在并发 role revoke 后过期，本 helper 的锁内 fresh 复核
 * 才是唯一最终授权依据。
 *
 * 与 RB-03 prepareActiveAccountMutation 的关系：设计同源（subject 锁 +
 * 锁内 fresh 复核），但 ACTIVE != AUTHORIZED ADMIN——本 helper 要求
 * fresh permission 而非仅账号 active；两 helper 各自独立，互不替代，
 * RB-03 helper 本身零变更。
 *
 * seams（仅测试注入；生产一律不传）：
 * - beforeLock：锁前挂起（构造 "entry auth 先于 revoke 提交" 的 stale 请求）
 * - afterCheck：锁内 fresh check 通过后、首个域写前挂起（锁等待竞态用）
 */
export type GovernanceMutationAuthoritySeams = {
  beforeLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  afterCheck?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export async function prepareGovernanceMutationAuthority(
  tx: Prisma.TransactionClient,
  actorId: string,
  permission: PermissionKey,
  seams?: GovernanceMutationAuthoritySeams,
): Promise<AuthorizationContext> {
  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await acquireGovernanceSubjectLocks(tx, [{ subjectType: "USER", subjectId: actorId }]);

  const context = await loadAuthorizationContext(actorId, tx);
  const fresh = await requirePermissionInContext(context, permission);

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  return fresh;
}
