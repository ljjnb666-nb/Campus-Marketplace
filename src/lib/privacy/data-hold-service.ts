import type { DataHold, DataHoldType, Prisma } from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
import { withGovernanceSubjectLock } from "@/lib/governance/governance-lock";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Data Hold foundation（Legal Hold / Dispute Hold）。
 *
 * Phase 5 边界：这里只提供 domain model + service + enforcement seam。
 * 管理界面（谁创建/解除 hold）属于 Phase 6 RBAC / Phase 7 运营后台；
 * 测试与 seed 通过 createHold / releaseHold seam 直接操作，不设生产 debug endpoint。
 *
 * Serialization contract（REPAIR 后语义）：
 * createHold / releaseHold / eraseAccount 在各自事务内先取同一把
 * subject advisory lock（governance-lock.ts），hold 状态检查与破坏性写
 * 之间的窗口被数据库级互斥关闭。READ COMMITTED 下"事务内多查一次"
 * 不构成 serialization boundary——锁才是。
 */

export async function createHold(input: {
  type: DataHoldType;
  subjectId: string;
  reasonCode: string;
  subjectType?: string;
  note?: string;
  createdById?: string;
}): Promise<DataHold> {
  const subjectType = input.subjectType ?? "USER";

  // 与 eraseAccount 同一把 subject 锁：hold 的生效（commit）要么整体
  // 先于 erase（erase 必见），要么被推迟到 erase 提交之后（结果 1）。
  const hold = await withGovernanceSubjectLock(subjectType, input.subjectId, (tx) =>
    tx.dataHold.create({
      data: {
        type: input.type,
        subjectId: input.subjectId,
        subjectType,
        reasonCode: input.reasonCode,
        note: input.note,
        createdById: input.createdById,
      },
    }),
  );

  logger.info("data_hold_created", "privacy", {
    holdId: hold.id,
    holdType: hold.type,
    subjectType: hold.subjectType,
  });

  return hold;
}

/**
 * 解除 hold。release 会改变 active 语义（使破坏性操作重新可行），
 * 因此同样必须经过 subject 锁：release 与 erase 的先后顺序被严格
 * 线性化，不会出现"release 提交但 erase 仍按旧快照拒绝"或其反向
 * 的不可解释交错。
 */
export async function releaseHold(holdId: string, releasedById?: string): Promise<DataHold> {
  const existing = await prisma.dataHold.findUnique({
    where: { id: holdId },
    select: { subjectType: true, subjectId: true },
  });

  if (!existing) {
    throw governanceError("PRIVACY_REQUEST_NOT_FOUND", "hold 不存在");
  }

  return withGovernanceSubjectLock(existing.subjectType, existing.subjectId, (tx) =>
    tx.dataHold.update({
      where: { id: holdId },
      data: { status: "RELEASED", releasedAt: new Date(), releasedById },
    }),
  );
}

export async function listActiveHolds(
  subjectId: string,
  tx?: Prisma.TransactionClient,
): Promise<DataHold[]> {
  const client = tx ?? prisma;
  return client.dataHold.findMany({
    where: { subjectId, status: "ACTIVE" },
  });
}

export async function hasActiveHold(
  subjectId: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const holds = await listActiveHolds(subjectId, tx);
  return holds.length > 0;
}

/**
 * hold 拦截断言。必须在满足以下全部条件的破坏性事务内调用：
 * 1. 事务已通过 acquireGovernanceSubjectLock 取得 subject 锁；
 * 2. assertNoActiveHold 与破坏性写处于同一事务。
 * 单独满足 2 不满足 1 时（无锁的 READ COMMITTED 事务），本函数只能
 * 检测"调用时点已提交"的 hold，不能关闭 check→commit 窗口内的并发
 * hold 创建——这是引入 subject 锁的原因。
 */
export async function assertNoActiveHold(
  subjectId: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const holds = await listActiveHolds(subjectId, tx);

  if (holds.length > 0) {
    logger.warn("account_erasure_blocked", "privacy", {
      subjectId,
      reasonCode: "ACTIVE_DATA_HOLD",
      holdCount: holds.length,
    });
    throw governanceError("ACTIVE_DATA_HOLD");
  }
}
