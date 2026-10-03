import type { Prisma } from "@prisma/client";

import { expireErrandDeadlineTx } from "@/lib/errand-lifecycle";
import {
  PermanentJobFailure,
  errandDeadlineExpirePayloadSchema,
  type ClaimedAsyncJob,
  type JobExecutionOutcome,
} from "@/lib/async/job-types";

/**
 * Phase 9C-02（§17）：ERRAND_DEADLINE_EXPIRE@1 handler。
 *
 * canonical expiry 复用合同（§14）——worker 绝不自持第二份 expiry state
 * machine，只能调用 expireErrandDeadlineTx()（errand-lifecycle 唯一权威）；
 * 本 handler 的职责只是 wake up → invoke canonical lifecycle → 表达
 * outcome（§17 冻结映射）：
 *   EXPIRED            → COMPLETED（业务事务已提交：OPEN → CANCELLED）
 *   NOT_OPEN / MISSING → COMPLETED_IDEMPOTENT（其他合法 lifecycle 已先赢 /
 *                         实体已不存在或软删除——幂等 no-op，绝不重复写入）
 *   NOT_DUE            → RESCHEDULE 到锁内 fresh 权威 deadline（one-shot
 *                         intent 的 stale-schedule 防御——discovery 后
 *                         publisher 合法 edit 延长；**不是 recurrence**，
 *                         与 PRODUCT_RESERVATION_EXPIRE 同一语义）
 *   STRUCTURAL_INVALID → PERMANENT → DEAD_LETTER（fail closed，绝不猜测
 *                         修复异常数据）
 */
export const errandDeadlineExpireHandler = async (
  tx: Prisma.TransactionClient,
  job: ClaimedAsyncJob,
): Promise<JobExecutionOutcome> => {
  const parsed = errandDeadlineExpirePayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // payload 形状非法 = 结构性损坏，重试不可能成功（§6/§9 fail closed）
    throw new PermanentJobFailure(
      "ERRAND_DEADLINE_EXPIRE_PAYLOAD_INVALID",
      "ERRAND_DEADLINE_EXPIRE payload 形状非法（期望 { errandId: string }）",
    );
  }

  const outcome = await expireErrandDeadlineTx(tx, parsed.data.errandId);

  if (outcome.kind === "EXPIRED") {
    return { kind: "COMPLETED" };
  }

  if (outcome.kind === "NOT_OPEN" || outcome.kind === "MISSING") {
    return { kind: "COMPLETED_IDEMPOTENT" };
  }

  if (outcome.kind === "NOT_DUE") {
    return { kind: "RESCHEDULE", runAt: outcome.deadline };
  }

  throw new PermanentJobFailure(
    "ERRAND_DEADLINE_STRUCTURAL_INVALID",
    `ERRAND deadline 过期目标行结构异常（OPEN + accepter / OPEN + active order / deadline 缺失）：${parsed.data.errandId}`,
  );
};
