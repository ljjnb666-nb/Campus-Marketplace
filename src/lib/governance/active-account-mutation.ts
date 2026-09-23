import type { Prisma } from "@prisma/client";

import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { rbacError } from "@/lib/rbac/errors";

/**
 * RB-03 ACTIVE_ACCOUNT_MUTATION_CONTRACT：
 *
 * 任何用户发起、会在账号生命周期转换后产生/更新 durable 用户所有态的
 * mutation，不得使用先于并发 lifecycle 转换（erase/delete/suspend）的
 * account-active 判定提交。统一序列化结构（同一事务边界内）：
 *
 *   USER governance subject lock（与 eraseAccount 同锁域、同命名空间）
 *   → loadAuthorizationContext 锁内重读（canonical active 定义）
 *   → 非 ACTIVE → AUTH_ACCOUNT_INACTIVE（稳定错误码，零写入）
 *   → 调用方的业务校验 / 写入 / commit
 *
 * 锁序纪律：本 helper 必须在事务内第一个获取锁的位置调用（subject locks
 * → domain locks，与 Phase 5 全局锁序一致）；已持有同一 USER 锁的路径
 * （如 conversation 创建的参与方锁）为 advisory xact lock 同事务重入，
 * 安全但应避免重复 authority boundary。
 *
 * entry auth（requireUser / getVerifiedSession）只是身份发现，不是序列化
 * 边界——入口 auth 与 lock-time auth 双层并存，入口层不动。
 *
 * 软删除扩展不构成安全边界：单行 update 不受其完整保护，本契约依赖的是
 * 显式 lifecycle serialization + fresh state check。
 *
 * seams（仅测试注入；生产一律不传）：
 * - beforeLock：身份发现后、取锁前挂起（构造 "entry auth 先于 erase 提交"
 *   的 stale 请求，RACE-01/RACE-03 用）
 * - afterCheck：锁内 fresh check 通过后、首个写入前挂起（RACE-02 用）
 */
export type ActiveAccountMutationSeams = {
  beforeLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  afterCheck?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export async function prepareActiveAccountMutation(
  tx: Prisma.TransactionClient,
  userId: string,
  seams?: ActiveAccountMutationSeams,
): Promise<void> {
  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await acquireGovernanceSubjectLocks(tx, [{ subjectType: "USER", subjectId: userId }]);

  const context = await loadAuthorizationContext(userId, tx);
  if (!context || !context.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }
}
