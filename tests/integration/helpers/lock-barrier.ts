import { PrismaClient } from "@prisma/client";

/**
 * Phase 6B Repair 1 Blocker H：确定性 advisory-lock race barrier。
 *
 * 旧 barrier 轮询 "任意未授予锁"——在 vitest 文件级并行下，其他集成文件
 * （如 Phase 5 治理域）自身的 advisory lock 等待会误触发屏障，导致
 * barrier 与目标事务无关（非确定性）。
 *
 * 确定性合同：governance subject 锁的键是
 *   pg_advisory_xact_lock(classid=730501, objid=hashtext("USER:<id>"))
 * 本 helper 轮询「预期锁键集合中至少一个键存在未授予的 advisory lock」。
 * 由于 (a) 锁键集合只属于被测事务的 fixture 用户（uid 全局唯一），
 * (b) 事务按升序取锁、阻塞发生在第一个争用键上——"至少一个预期键在等待"
 * 即证明目标事务已进入锁等待队列；其他文件的无关键不会命中本集合。
 */
export const GOVERNANCE_LOCK_NAMESPACE = 730_501;

export async function waitForAdvisoryLockWaiter(
  client: PrismaClient,
  subjectKeys: string[],
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await client.$queryRaw<{ objid: number }[]>`
      SELECT locks.objid
      FROM pg_locks locks
      WHERE locks.locktype = 'advisory'
        AND NOT locks.granted
        AND locks.classid = ${GOVERNANCE_LOCK_NAMESPACE}::int
        AND EXISTS (
          SELECT 1
          FROM unnest(${subjectKeys}::text[]) AS expected(key)
          -- hashtext 是有符号 int4，pg_locks.objid 是无符号 oid：
          -- 必须经 bit(32) 重解释到同一无符号域，负 hash 键才能匹配
          WHERE hashtext(expected.key)::bit(32)::bigint = locks.objid
        )`;

    if (rows.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(
    `advisory-lock barrier 超时：预期等待键 [${subjectKeys.join(", ")}] 均未进入锁等待`,
  );
}
