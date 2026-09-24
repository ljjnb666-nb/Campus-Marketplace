import type { Prisma } from "@prisma/client";

import { prepareActiveAccountMutation, type ActiveAccountMutationSeams } from "@/lib/governance/active-account-mutation";

/**
 * RB-03 REVIEW FIX：拉黑/解除拉黑的领域逻辑（从 server action 抽出）。
 *
 * ACTIVE_ACCOUNT_MUTATION_CONTRACT：USER:<actorId> 治理锁 + 锁内 fresh
 * active 复核 → durable 关系写入，同一事务边界。
 *
 * 锁定范围 = 仅 USER:<actorId>（authority 是"actor 是否仍有资格执行
 * 自己的 durable mutation"）；不锁 target user——BlockedUser target 的
 * lifecycle 不参与本判定（目标 erasure 不删除 User row，关系历史/
 * 隐私清理属 RB-04），引入 actor+target 双锁只会扩大锁图与 deadlock
 * surface。
 */

export type BlockUserInput = {
  targetUserId: string;
  reason: string;
};

export async function blockUserTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  input: BlockUserInput,
  seams?: ActiveAccountMutationSeams,
): Promise<void> {
  await prepareActiveAccountMutation(tx, actorUserId, seams);

  await tx.blockedUser.upsert({
    where: {
      blockerId_blockedUserId: {
        blockerId: actorUserId,
        blockedUserId: input.targetUserId,
      },
    },
    create: {
      blockerId: actorUserId,
      blockedUserId: input.targetUserId,
      reason: input.reason,
    },
    update: {
      reason: input.reason,
    },
  });
}

export async function unblockUserTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  targetUserId: string,
  seams?: ActiveAccountMutationSeams,
): Promise<void> {
  await prepareActiveAccountMutation(tx, actorUserId, seams);

  await tx.blockedUser.deleteMany({
    where: { blockerId: actorUserId, blockedUserId: targetUserId },
  });
}
