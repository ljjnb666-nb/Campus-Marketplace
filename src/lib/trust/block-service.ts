import type { Prisma } from "@prisma/client";

import {
  assertActiveAccountMutationAllowed,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";

/**
 * RB-03 REVIEW FIX / Phase 8A-03：拉黑/解除拉黑的领域逻辑（从 server action
 * 抽出）。
 *
 * ACTIVE_ACCOUNT_MUTATION_CONTRACT：治理锁 + 锁内 fresh active 复核 →
 * durable 关系写入，同一事务边界。
 *
 * 8A-03 锁定范围（原仅 USER:<actorId>）= sorted USER participant pair
 * （USER:A + USER:B，经 acquireGovernanceSubjectLocks 统一升序，禁止
 * actor-first 手工顺序扩大 deadlock surface）。原因：BlockedUser 是
 * communication policy 的序列化点——block/unblock 必须与 conversation
 * create / message send（同样取 sorted pair locks）线性化，否则
 * "check-then-commit block" 与并发 send/create 之间存在 TOCTOU 窗口。
 * Pair 锁取得后直接 assertActiveAccountMutationAllowed(actor) 复核（完整
 * 参与方锁已持有，不得再经 prepareActiveAccountMutation 以错误顺序重取
 * actor-only 锁）。
 *
 * BlockedUser 行本身保持 directional（blocker→blocked 单行 = canonical
 * preference truth）；pair 锁只是通信授权的序列化域，不代表双向关系行。
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
  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: actorUserId },
    { subjectType: "USER", subjectId: input.targetUserId },
  ]);

  await assertActiveAccountMutationAllowed(tx, actorUserId);

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

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
  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: actorUserId },
    { subjectType: "USER", subjectId: targetUserId },
  ]);

  await assertActiveAccountMutationAllowed(tx, actorUserId);

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  await tx.blockedUser.deleteMany({
    where: { blockerId: actorUserId, blockedUserId: targetUserId },
  });
}
