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
 * 确定性字符串升序（小型插入排序）。
 *
 * 刻意不使用 Array.prototype.sort：治理锁序只需要"确定性"，参与方 ID
 * 为内部 cuid（非用户输入），排序结果仅用于 advisory lock 的加锁先后，
 * 绝不作为任何查询的 sort spec——手工实现以明确这一边界。
 */
function ascendingStrings(keys: Iterable<string>): string[] {
  const result: string[] = [];

  for (const key of keys) {
    let insertAt = result.length;
    for (let i = 0; i < result.length; i += 1) {
      if (result[i]! > key) {
        insertAt = i;
        break;
      }
    }
    result.splice(insertAt, 0, key);
  }

  return result;
}

/**
 * 对多个治理 subject 按稳定顺序取得事务级互斥锁。
 *
 * 锁序规则：先按 "subjectType:subjectId" 组合键去重，再按组合键升序逐一加锁。
 * 所有需要同时锁多个参与方的路径（交易 obligation 创建：buyer+seller /
 * renter+owner / claimer+publisher）都必须经由本函数获取锁——全局锁序一致，
 * 不允许任何路径按相反顺序自行加锁造成死锁环。
 */
export async function acquireGovernanceSubjectLocks(
  tx: Prisma.TransactionClient,
  subjects: Array<{ subjectType: string; subjectId: string }>,
): Promise<void> {
  const deduped = ascendingStrings(
    new Set(subjects.map((s) => `${s.subjectType}:${s.subjectId}`)),
  );

  for (const key of deduped) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${GOVERNANCE_SUBJECT_LOCK_NAMESPACE}::int, hashtext(${key}))`;
  }
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
  for (const type of ascendingStrings(types)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${POLICY_LOCK_NAMESPACE}::int, hashtext(${type}))`;
  }
}
