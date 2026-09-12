import type { Prisma } from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";

/**
 * 交易/履约义务创建的 participant guard（Phase 5 REPAIR 2，BLOCKER B；
 * Phase 6C-3 Repair 2 改造为"锁内校验回调"模型）。
 *
 * 不变量：任何"创建新的持续性 active obligation"的写事务（商品订单 /
 * 服务预约 / 跑腿接单 / 租赁订单）在写入前必须：
 *   1. 对全部 USER 参与方按稳定顺序取得 governance subject 锁
 *      （acquireGovernanceSubjectLocks，去重 + 组合键升序）；
 *   2. 在持锁事务内执行 validateLocked 回调（actor 专用校验 → 全参与方
 *      资格校验，见 capability-gate.marketplaceObligationValidator）；
 *   3. 通过 racePoint（测试 seam）后才执行 run 的 domain 状态检查与创建。
 *
 * 本 guard 只负责"participant serialization boundary + 锁内回调排序"，
 * 不再隐式决定业务错误 taxonomy——错误语义完全由 validateLocked 决定
 * （actor 专用 403 族 / 对手方统一 409，Phase 6C-3 合同）。
 *
 * 与 eraseAccount 的同一把 subject 锁配合，线性化保证只有两种结果：
 *   A. obligation 先取锁 → 校验通过 → 提交 → erase 后取锁 →
 *      active-transaction 检查看到义务 → BLOCKED；
 *   B. erase 先取锁 → 提交匿名化 → obligation 后取锁 → validateLocked
 *      的锁内重读失败 → 创建被拒。
 * 绝不允许"erase 已提交而 obligation 仍在锁外校验后提交"。
 *
 * 锁在数据库侧（advisory lock），多实例安全。
 */

/**
 * 事务内参与方可用性复核（Phase 5 保留工具函数）。
 *
 * Phase 6C-3 起 withObligationGuard 不再自动调用本函数：账号可用性维度
 * 已并入 capability-gate.requireParticipantsMarketplaceEligible 的批量
 * 参与方校验（同一谓词：status ACTIVE && deletedAt null && erasedAt null）。
 * 本导出仅供独立测试与未来治理路径复用；必须在 governance subject 锁
 * 取得之后调用（否则 READ COMMITTED 下的重读不构成 serialization boundary）。
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

/** 测试 seam：participant 锁 + validateLocked 校验之后、义务写入之前的受控暂停点。 */
export type ObligationRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

/**
 * obligation 创建的统一入口包装（Phase 6C-3 Repair 2 冻结序列）：
 *   participant 锁（稳定锁序）→ validateLocked → racePoint → 业务回调。
 * 回调拿到同一个 tx；任何失败整体回滚（锁随事务释放）。
 *
 * 精确次序约束：racePoint 绝不先于 validateLocked；run 绝不先于
 * validateLocked；参与方锁一次性完整取得（部分锁定 = 破坏锁序纪律）。
 */
export async function withObligationGuard<T>(
  tx: Prisma.TransactionClient,
  participantUserIds: string[],
  validateLocked: (tx: Prisma.TransactionClient) => Promise<void>,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  racePoint?: ObligationRacePoint,
): Promise<T> {
  await acquireGovernanceSubjectLocks(
    tx,
    participantUserIds.map((subjectId) => ({ subjectType: "USER", subjectId })),
  );

  await validateLocked(tx);

  if (racePoint) {
    await racePoint(tx);
  }

  return run(tx);
}
