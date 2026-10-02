import { prisma } from "@/lib/prisma";

/**
 * Phase 9A：queue observability（§38）。
 *
 * backlog 健康度是 worker 的观测面，不是 /api/ready 的依赖（§40）：
 * queue backlog > 0 不允许把 web readiness 翻成 not_ready；真正的
 * DB unavailable 由既有 readiness 检查负责。接入方式 = 结构化日志
 * （worker 周期 summary）+ 本 service 查询（未来 ops/governance UI 复用），
 * 不新建第二套 observability stack。
 */

export type AsyncJobQueueStats = {
  pending: number;
  retry: number;
  running: number;
  deadLetter: number;
  /** 最老 runnable（PENDING/RETRY）job 的 age（毫秒；无 runnable = null） */
  oldestRunnableAgeMs: number | null;
};

export type OutboxQueueStats = {
  pending: number;
  processing: number;
  deadLetter: number;
  /** 最老 pending event 的 age（毫秒；无 pending = null） */
  oldestPendingAgeMs: number | null;
};

type CountOnly = { _count: { _all: number } };

function ageMsFrom(from: Date | null, now: Date): number | null {
  return from === null ? null : Math.max(0, now.getTime() - from.getTime());
}

export async function getAsyncJobQueueStats(now = new Date()): Promise<AsyncJobQueueStats> {
  const grouped = await prisma.asyncJob.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const countByStatus = new Map<string, number>(
    grouped.map((row: { status: string } & CountOnly) => [row.status, row._count._all]),
  );

  const oldest = await prisma.asyncJob.findFirst({
    where: { status: { in: ["PENDING", "RETRY"] } },
    orderBy: { runAt: "asc" },
    select: { runAt: true },
  });

  return {
    pending: countByStatus.get("PENDING") ?? 0,
    retry: countByStatus.get("RETRY") ?? 0,
    running: countByStatus.get("RUNNING") ?? 0,
    deadLetter: countByStatus.get("DEAD_LETTER") ?? 0,
    oldestRunnableAgeMs: ageMsFrom(oldest?.runAt ?? null, now),
  };
}

export async function getOutboxQueueStats(now = new Date()): Promise<OutboxQueueStats> {
  const grouped = await prisma.outboxEvent.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const countByStatus = new Map<string, number>(
    grouped.map((row: { status: string } & CountOnly) => [row.status, row._count._all]),
  );

  const oldest = await prisma.outboxEvent.findFirst({
    where: { status: "PENDING" },
    orderBy: { availableAt: "asc" },
    select: { availableAt: true },
  });

  return {
    pending: countByStatus.get("PENDING") ?? 0,
    processing: countByStatus.get("PROCESSING") ?? 0,
    deadLetter: countByStatus.get("DEAD_LETTER") ?? 0,
    oldestPendingAgeMs: ageMsFrom(oldest?.availableAt ?? null, now),
  };
}

export type QueueStatsSnapshot = {
  jobs: AsyncJobQueueStats;
  outbox: OutboxQueueStats;
};

export async function getQueueStatsSnapshot(now = new Date()): Promise<QueueStatsSnapshot> {
  return {
    jobs: await getAsyncJobQueueStats(now),
    outbox: await getOutboxQueueStats(now),
  };
}

// ============================================================
// Phase 9B（§81）：NOTIFICATION_DELIVERY 队列观测——无需独立 metrics
// backend，直接基于 AsyncJob（kind = NOTIFICATION_DELIVERY）分组。
// ============================================================

export type NotificationDeliveryQueueStats = {
  pending: number;
  retry: number;
  running: number;
  deadLetter: number;
  completed: number;
  /** 最老 runnable（PENDING/RETRY）email job 的 age（毫秒；无 runnable = null） */
  oldestRunnableAgeMs: number | null;
};

export async function getNotificationDeliveryQueueStats(
  now = new Date(),
): Promise<NotificationDeliveryQueueStats> {
  const grouped = await prisma.asyncJob.groupBy({
    by: ["status"],
    where: { kind: "NOTIFICATION_DELIVERY" },
    _count: { _all: true },
  });
  const countByStatus = new Map<string, number>(
    grouped.map((row: { status: string } & CountOnly) => [row.status, row._count._all]),
  );

  const oldest = await prisma.asyncJob.findFirst({
    where: { kind: "NOTIFICATION_DELIVERY", status: { in: ["PENDING", "RETRY"] } },
    orderBy: { runAt: "asc" },
    select: { runAt: true },
  });

  return {
    pending: countByStatus.get("PENDING") ?? 0,
    retry: countByStatus.get("RETRY") ?? 0,
    running: countByStatus.get("RUNNING") ?? 0,
    deadLetter: countByStatus.get("DEAD_LETTER") ?? 0,
    completed: countByStatus.get("COMPLETED") ?? 0,
    oldestRunnableAgeMs: ageMsFrom(oldest?.runAt ?? null, now),
  };
}
