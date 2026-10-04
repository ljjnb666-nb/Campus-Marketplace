import { PrismaClient } from "@prisma/client";

/**
 * RB06（Review Repair Round 3）— E2E TEST-ONLY cross-process mutex：
 * async-worker protocol lock。
 *
 * 背景隔离缺陷：E2E 中多个 spec（Phase 9A / 9B / 9C-02）各自 spawn 真实
 * `scripts/ops/async-worker.ts --run-once`，但 runtime env 不同——尤其
 * Phase 9B 的 worker 持有专属 fake Resend env（RESEND_API_BASE_URL 指向
 * 该 spec 自己的 fake provider）。它们竞争同一个共享 E2E AsyncJob durable
 * queue：普通 env 的 worker 可能 claim 走需要 fake provider env 的
 * NOTIFICATION_DELIVERY job，破坏 9B 的 provider 行为断言（providerAcceptedAt
 * / providerMessageId / 逻辑邮件计数）。
 *
 * 语义（§21）：本锁不是 job ownership——它只保证"任何时刻，E2E suite 中至多
 * 一个依赖特定 runtime config 的 production async-worker protocol 活跃"。
 * 持锁 worker 仍消费真实 shared queue；不需要也不允许清空共享队列。
 *
 * 机制（§7/§8/§10/§12）：
 *   - PostgreSQL **session-level** advisory lock
 *     （pg_try_advisory_lock / pg_advisory_unlock，非 xact 版本）——critical
 *     section 跨多个独立 DB transaction、worker subprocess、UI step 与
 *     backoff 等待，transaction-level lock 无法覆盖完整 protocol；
 *   - 专用 PrismaClient（connection_limit=1）：整个 acquire → callback →
 *     unlock 生命周期始终是同一物理连接 = 同一 PG session，杜绝连接池
 *     checkout 归还导致的 ownership 丢失；
 *   - 独立 TEST-ONLY lock key，不复用 governance/policy 等生产 domain
 *     advisory lock namespace；
 *   - 有界获取（默认 180s：9B protocol 含多秒 backoff cycle，30s 会误伤；
 *     超时抛 E2E_ASYNC_WORKER_LOCK_TIMEOUT，绝不无限等待挂住 CI）；
 *   - finally 中 unlock + disconnect——任何 expect 失败 / worker crash /
 *     Playwright 异常都会释放；进程崩溃时 DB session 关闭，session lock
 *     由 PostgreSQL 自动释放（额外的安全网）。
 *
 * TEST ONLY — not production domain serialization。
 * 禁止在生产代码中使用本 helper 或其 lock key。
 */

/** TEST ONLY：E2E async-worker protocol 互斥的专用 advisory lock key。 */
const E2E_ASYNC_WORKER_PROTOCOL_LOCK_KEY = "740110100";

/** 有界获取默认上界：覆盖 9B 全 protocol（UI + 3 worker cycles + backoff）。 */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 180_000;

/** 锁获取轮询间隔（TEST-ONLY，仅为避免密集空轮询；有明确 timeout 上界）。 */
const ACQUIRE_POLL_INTERVAL_MS = 100;

function resolveLockDatabaseUrl(): string {
  return (
    process.env.E2E_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public"
  );
}

export type E2EAsyncWorkerLockOptions = {
  /** 有界获取上界；超时抛 E2E_ASYNC_WORKER_LOCK_TIMEOUT。 */
  acquireTimeoutMs?: number;
};

/**
 * 在唯一的 E2E async-worker protocol 互斥锁下执行 callback。
 * 所有 queue-sensitive specs 竞争同一个 lock key（label 仅用于错误信息，
 * 不映射成不同 key）。
 */
export async function withE2EAsyncWorkerProtocolLock<T>(
  label: string,
  callback: () => Promise<T>,
  options: E2EAsyncWorkerLockOptions = {},
): Promise<T> {
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  // connection_limit=1 ⇒ 单一物理连接/单一 PG session（session affinity，
  // §12）；try/finally 中 disconnect 兜底释放 session lock（§27）。
  const lockClient = new PrismaClient({
    datasources: {
      db: { url: `${resolveLockDatabaseUrl()}&connection_limit=1&pool_timeout=${acquireTimeoutMs}` },
    },
    log: ["error"],
  });

  let acquired = false;
  try {
    const deadline = Date.now() + acquireTimeoutMs;
    for (;;) {
      const rows = await lockClient.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${E2E_ASYNC_WORKER_PROTOCOL_LOCK_KEY}::bigint) AS locked
      `;
      if (rows[0]?.locked === true) {
        acquired = true;
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `E2E_ASYNC_WORKER_LOCK_TIMEOUT label=${label} waitedMs=${acquireTimeoutMs} ` +
            `lockKey=${E2E_ASYNC_WORKER_PROTOCOL_LOCK_KEY}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, ACQUIRE_POLL_INTERVAL_MS));
    }

    return await callback();
  } finally {
    if (acquired) {
      try {
        await lockClient.$executeRaw`SELECT pg_advisory_unlock(${E2E_ASYNC_WORKER_PROTOCOL_LOCK_KEY}::bigint)`;
      } catch {
        // unlock 失败（连接已断等）：session 关闭时 PostgreSQL 自动释放
      }
    }
    await lockClient.$disconnect().catch(() => {
      // disconnect 兜底：session 终止 ⇒ session lock 必然释放（§27）
    });
  }
}
