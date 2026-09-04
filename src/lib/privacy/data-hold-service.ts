import type { DataHold, DataHoldType, Prisma } from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Data Hold foundation（Legal Hold / Dispute Hold）。
 *
 * Phase 5 边界：这里只提供 domain model + service + enforcement seam。
 * 管理界面（谁创建/解除 hold）属于 Phase 6 RBAC / Phase 7 运营后台；
 * 测试与 seed 通过 createHold / releaseHold seam 直接操作，不设生产 debug endpoint。
 */

export async function createHold(input: {
  type: DataHoldType;
  subjectId: string;
  reasonCode: string;
  subjectType?: string;
  note?: string;
  createdById?: string;
}): Promise<DataHold> {
  const hold = await prisma.dataHold.create({
    data: {
      type: input.type,
      subjectId: input.subjectId,
      subjectType: input.subjectType ?? "USER",
      reasonCode: input.reasonCode,
      note: input.note,
      createdById: input.createdById,
    },
  });

  logger.info("data_hold_created", "privacy", {
    holdId: hold.id,
    holdType: hold.type,
    subjectType: hold.subjectType,
  });

  return hold;
}

export async function releaseHold(holdId: string, releasedById?: string): Promise<DataHold> {
  return prisma.dataHold.update({
    where: { id: holdId },
    data: { status: "RELEASED", releasedAt: new Date(), releasedById },
  });
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
 * hold 拦截断言。破坏性操作（擦除/匿名化/保留期清理）在打开事务之后必须
 * 再次调用本函数（tx 参数），保证 check 与 destruction 处于同一事务快照，
 * 消除 check→race→delete→hold created 的 TOCTOU 窗口。
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
