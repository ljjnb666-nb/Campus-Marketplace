import type { Prisma } from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";

/**
 * 交易/履约义务创建的 participant guard（Phase 5 REPAIR 2，BLOCKER B）。
 *
 * 不变量：任何"创建新的持续性 active obligation"的写事务（商品订单 /
 * 服务预约 / 跑腿接单 / 租赁订单）在创建义务前必须：
 *   1. 对全部 USER 参与方按稳定顺序取得 governance subject 锁
 *      （acquireGovernanceSubjectLocks，去重 + 组合键升序）；
 *   2. 在持锁事务内重读所有参与方：status==ACTIVE && deletedAt==null
 *      && erasedAt==null；
 *   3. 全部通过后才执行 domain 状态检查与义务创建。
 *
 * 与 eraseAccount 的同一把 subject 锁配合，线性化保证只有两种结果：
 *   A. obligation 先取锁 → 提交 → erase 后取锁 → active-transaction
 *      检查看到义务 → BLOCKED；
 *   B. erase 先取锁 → 提交匿名化 → obligation 后取锁 → participant
 *      重读失败 → 创建被拒。
 * 绝不允许"erase 的 active 计数为零 → 并发新义务提交 → erase 提交 →
 * 已注销用户持有 active obligation"。
 *
 * 这不是 Phase 6 RBAC：不引入权限体系，只做"参与方账号可用性"的
 * 事务内复核。锁在数据库侧（advisory lock），多实例安全。
 */

/**
 * 事务内参与方可用性复核。必须在 governance subject 锁取得之后调用
 * （否则 READ COMMITTED 下的重读不构成 serialization boundary）。
 */
export async function assertActiveGovernanceSubjects(
  tx: Prisma.TransactionClient,
  userIds: string[],
): Promise<void> {
  const uniqueIds = [...new Set(userIds)];

  const users = await tx.user.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, status: true, deletedAt: true, erasedAt: true },
  });

  const byId = new Map(users.map((user) => [user.id, user]));

  for (const userId of uniqueIds) {
    const user = byId.get(userId);
    const active =
      user &&
      user.status === "ACTIVE" &&
      user.deletedAt === null &&
      user.erasedAt === null;

    if (!active) {
      throw governanceError("GOVERNANCE_SUBJECT_INACTIVE");
    }
  }
}

/** 测试 seam：participant 锁 + active 复核之后、义务写入之前的受控暂停点。 */
export type ObligationRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

/**
 * obligation 创建的统一入口包装：
 * participant 锁（稳定锁序）→ 活跃复核 → racePoint（测试 seam）→ 业务回调。
 * 回调拿到同一个 tx；任何失败整体回滚（锁随事务释放）。
 */
export async function withObligationGuard<T>(
  tx: Prisma.TransactionClient,
  participantUserIds: string[],
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  racePoint?: ObligationRacePoint,
): Promise<T> {
  await acquireGovernanceSubjectLocks(
    tx,
    participantUserIds.map((subjectId) => ({ subjectType: "USER", subjectId })),
  );

  await assertActiveGovernanceSubjects(tx, participantUserIds);

  if (racePoint) {
    await racePoint(tx);
  }

  return run(tx);
}
