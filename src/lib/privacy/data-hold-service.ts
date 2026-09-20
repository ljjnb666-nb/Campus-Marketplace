import { Prisma, type DataHold, type DataHoldType } from "@prisma/client";

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
 *
 * Phase 7G 增量（source-linked hold）：
 * - DataHold.sourceType/sourceId 记录 hold 的业务来源（如 RENTAL_DISPUTE +
 *   disputeId）；同一 (type, subjectType, subjectId, sourceType, sourceId)
 *   至多一个 ACTIVE 行（迁移 partial unique index "DataHold_source_active_key"
 *   强制 DB 级重复防护）；
 * - createHoldTxLocked / releaseHoldsBySourceTxLocked 是 TxLocked seam
 *   （6C-1A 同款合同）：**前置条件 = 调用方已在同一事务内持有全部必需的
 *   subject 治理锁**（dispute 创建/终局事务在锁 owner+renter 之后调用）。
 *   绝不在 dispute 事务内调用会自己另开事务的 createHold / releaseHold。
 */

/** dispute 派生 hold 的 sourceType（DataHold.sourceType 唯一 7G 值）。 */
export const DATA_HOLD_SOURCE_TYPE_RENTAL_DISPUTE = "RENTAL_DISPUTE";

/** dispute 派生 hold 的 reasonCode（owner/renter 同码）。 */
export const DISPUTE_HOLD_REASON_CODE = "ACTIVE_RENTAL_DISPUTE";

/** P2002 目标列判定（meta.target 存在 string / string[] 双形态）。 */
function isUniqueViolationOn(error: unknown, column: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const target = error.meta?.target;
  // P2002 的 meta.target 对 partial unique index 呈现两种形态：列名数组或
  // 索引名字符串/数组——两者都按包含判定（DataHold_source_active_key）。
  const NAMES = [column, "DataHold_source_active_key"];
  const candidates = Array.isArray(target)
    ? target.map(String)
    : typeof target === "string"
      ? [target]
      : [];
  return candidates.some((part) => NAMES.some((name) => part.includes(name)));
}

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
 * TxLocked seam：在"调用方已持有 subject 治理锁"的事务内创建 source-linked
 * hold。前置条件（调用方合同）：tx 内已通过 acquireGovernanceSubjectLock(s)
 * 持有 subjectType:subjectId 对应的治理锁——本函数绝不自行取锁、绝不另开事务。
 *
 * 重复防护：partial unique index（DataHold_source_active_key）兜底并发重复；
 * P2002 → 幂等 no-op（经 SAVEPOINT 回滚到插入点后收敛到既有 ACTIVE 行），
 * 语义 = "duplicate initiation cannot duplicate active holds"（H02）。
 */
export async function createHoldTxLocked(
  tx: Prisma.TransactionClient,
  input: {
    type: DataHoldType;
    subjectId: string;
    subjectType?: string;
    reasonCode: string;
    sourceType: string;
    sourceId: string;
    note?: string;
    createdById?: string;
  },
): Promise<DataHold> {
  const subjectType = input.subjectType ?? "USER";

  // PG 事务内语句失败后整事务进入 aborted 态（25P02）：幂等收敛路径必须
  // 先 SAVEPOINT 包裹插入点，P2002 时 ROLLBACK TO SAVEPOINT 后才能继续查询。
  await tx.$executeRaw`SAVEPOINT data_hold_create`;
  try {
    const hold = await tx.dataHold.create({
      data: {
        type: input.type,
        subjectId: input.subjectId,
        subjectType,
        reasonCode: input.reasonCode,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        note: input.note,
        createdById: input.createdById,
      },
    });

    logger.info("data_hold_created", "privacy", {
      holdId: hold.id,
      holdType: hold.type,
      subjectType: hold.subjectType,
      sourceType: hold.sourceType,
    });

    return hold;
  } catch (error) {
    if (isUniqueViolationOn(error, "sourceType")) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT data_hold_create`;
      // DB 级重复防护兜底命中：收敛到既有 ACTIVE source-linked hold（幂等）
      const existing = await tx.dataHold.findFirst({
        where: {
          type: input.type,
          subjectType,
          subjectId: input.subjectId,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          status: "ACTIVE",
        },
      });
      if (existing) {
        logger.warn("data_hold_duplicate_suppressed", "privacy", {
          holdId: existing.id,
          sourceType: input.sourceType,
        });
        return existing;
      }
    }
    throw error;
  }
}

/**
 * TxLocked seam：按 source 精确解除全部 ACTIVE hold（dispute terminal 时调用）。
 * 前置条件（调用方合同）：tx 内已持有相关 subject 治理锁（dispute 终局事务
 * 持 owner+renter 锁）。只解除 sourceType+sourceId 精确匹配的 ACTIVE 行——
 * 无关的 LEGAL/手动 hold 一律不触碰（H06）。幂等：无匹配行时返回 0（H05）。
 */
export async function releaseHoldsBySourceTxLocked(
  tx: Prisma.TransactionClient,
  input: { sourceType: string; sourceId: string; releasedById?: string },
): Promise<number> {
  const result = await tx.dataHold.updateMany({
    where: {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      status: "ACTIVE",
    },
    data: {
      status: "RELEASED",
      releasedAt: new Date(),
      releasedById: input.releasedById,
    },
  });

  if (result.count > 0) {
    logger.info("data_holds_released_by_source", "privacy", {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      count: result.count,
    });
  }

  return result.count;
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
