import type { Prisma } from "@prisma/client";

import { withTransaction as withTx } from "@/lib/prisma";

/**
 * 治理域 serialization boundary（Phase 5 REPAIR：真实 TOCTOU 关闭）。
 *
 * 背景：PostgreSQL 默认 READ COMMITTED，事务内多次读之间可能看到其他
 * 事务新提交的行——"在破坏性事务内再查一次 hold/policy"本身并不能
 * 消除 TOCTOU。真正起作用的是：所有会影响破坏性/同意语义的写路径
 * （createHold / releaseHold / eraseAccount / publish / accept）都必须先
 * 取得同一把数据库级锁，使"check"与"commit"之间的窗口被互斥关闭。
 *
 * 实现：PostgreSQL advisory transaction lock（pg_advisory_xact_lock，
 * 事务结束自动释放，跨连接生效，多实例安全——锁在数据库侧，不在进程内）。
 *
 * 锁键（两段 int）：
 *   key1 = 命名空间（governance subject 锁 / policy 锁分开，互不阻塞）
 *   key2 = hashtext(稳定字符串键)
 *
 * 注意 hashtext 理论上可能碰撞：碰撞只会造成额外串行化（误伤性能），
 * 不会破坏正确性（该扩大的互斥只会更严，不会更松）。
 */

/** 治理 subject 锁命名空间（hold/erasure 互斥） */
const GOVERNANCE_SUBJECT_LOCK_NAMESPACE = 730_501;

/** 法务政策锁命名空间（publish/retire/accept 互斥） */
const POLICY_LOCK_NAMESPACE = 730_502;

/**
 * 对治理 subject（当前仅 USER 账号）取得事务级互斥锁。
 *
 * createHold / releaseHold / eraseAccount 必须都在各自事务内先调用本函数
 * 锁同一 subject，之后才允许读 hold 状态或执行破坏性写。由此保证：
 *   1. erase 先取锁 → 完成 → hold creation 随后发生；
 *   2. hold 先取锁 → 创建提交 → erase 随后看到 hold 并 BLOCK；
 * 且"hold 已提交但 erase 未见 hold 便提交"在锁互斥下不可能出现。
 */
export async function acquireGovernanceSubjectLock(
  tx: Prisma.TransactionClient,
  subjectType: string,
  subjectId: string,
): Promise<void> {
  // ::int 显式转型：Prisma 会把 JS number 以 bigint 传递，而两参形式的
  // pg_advisory_xact_lock 签名是 (int4, int4)
  // $executeRaw：锁函数返回 void，$queryRaw 无法反序列化 void 列
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${GOVERNANCE_SUBJECT_LOCK_NAMESPACE}::int, hashtext(${`${subjectType}:${subjectId}`}))`;
}

/** subject 锁 + 事务的快捷组合（单次写路径用）。 */
export async function withGovernanceSubjectLock<T>(
  subjectType: string,
  subjectId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withTx(async (tx) => {
    await acquireGovernanceSubjectLock(tx, subjectType, subjectId);

    return callback(tx);
  });
}

/**
 * 法务政策锁：对给定 document types 按固定顺序取得事务级互斥锁。
 *
 * publish / retire 必须锁自己操作的 type；recordAcceptances 必须
 * 按本函数的同一固定顺序锁全部 required types（一次 acceptance 覆盖
 * 四类文档）。固定顺序保证并发 acceptance / publish 之间无死锁环。
 */
export async function acquirePolicyLocks(
  tx: Prisma.TransactionClient,
  types: readonly string[],
): Promise<void> {
  for (const type of [...types].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${POLICY_LOCK_NAMESPACE}::int, hashtext(${type}))`;
  }
}
