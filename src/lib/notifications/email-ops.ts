import { prisma } from "@/lib/prisma";

/**
 * Phase 9B（§82）：email ops read-only seam——dead-letter / 最老 pending /
 * provider-accepted 计数等运营查询。本阶段无 public admin UI；Phase 11C
 * ops console 后续消费。查询面绝不返回 destination 明文以外的免费文本，
 * destination 属 CONTACT_INFO——消费方（未来 UI）必须遵守同低调性
 * （不对非 operator 暴露；不在日志中输出）。
 *
 * 全部 read-only：不提供 9B blind requeue（§27——超出幂等窗口的投递
 * 重发必须显式新 notification/delivery intent，不能复用原 delivery）。
 */

export type DeadLetteredEmailDelivery = {
  deliveryId: string;
  notificationId: string;
  provider: string;
  /** 投递状态诊断机器码（NOTIFICATION_DELIVERY job 的 lastErrorCode）。 */
  jobErrorCode: string | null;
  deadLetteredAt: Date | null;
  suppressedAt: Date | null;
  suppressionCode: string | null;
  providerAcceptedAt: Date | null;
};

/** dead-letter 的 EMAIL 投递（以 NOTIFICATION_DELIVERY dead-letter job 为驱动；最多 limit 条）。 */
export async function getDeadLetteredEmailDeliveries(
  limit = 50,
): Promise<DeadLetteredEmailDelivery[]> {
  const jobs = await prisma.asyncJob.findMany({
    where: { kind: "NOTIFICATION_DELIVERY", status: "DEAD_LETTER" },
    orderBy: { deadLetteredAt: "desc" },
    take: limit,
    select: { payload: true, lastErrorCode: true, deadLetteredAt: true },
  });

  const deliveryIds = jobs
    .map((job) =>
      typeof job.payload === "object" &&
      job.payload !== null &&
      typeof (job.payload as { deliveryId?: unknown }).deliveryId === "string"
        ? (job.payload as { deliveryId: string }).deliveryId
        : null,
    )
    .filter((id): id is string => id !== null);
  if (deliveryIds.length === 0) return [];

  const deliveries = await prisma.notificationDelivery.findMany({
    where: { id: { in: deliveryIds }, channel: "EMAIL" },
    select: {
      id: true,
      notificationId: true,
      provider: true,
      suppressedAt: true,
      suppressionCode: true,
      providerAcceptedAt: true,
    },
  });
  const byId = new Map(deliveries.map((row) => [row.id, row]));

  return jobs
    .map((job) => {
      const deliveryId =
        typeof job.payload === "object" &&
        job.payload !== null &&
        typeof (job.payload as { deliveryId?: unknown }).deliveryId === "string"
          ? (job.payload as { deliveryId: string }).deliveryId
          : null;
      const delivery = deliveryId ? byId.get(deliveryId) : undefined;
      if (!delivery) return null;
      return {
        deliveryId: delivery.id,
        notificationId: delivery.notificationId,
        provider: delivery.provider,
        jobErrorCode: job.lastErrorCode,
        deadLetteredAt: job.deadLetteredAt,
        suppressedAt: delivery.suppressedAt,
        suppressionCode: delivery.suppressionCode,
        providerAcceptedAt: delivery.providerAcceptedAt,
      } satisfies DeadLetteredEmailDelivery;
    })
    .filter((row): row is DeadLetteredEmailDelivery => row !== null);
}

export type OldestPendingEmailDelivery = {
  deliveryId: string;
  notificationId: string;
  provider: string;
  jobRunAt: Date | null;
  jobAttempts: number | null;
  ageMs: number | null;
};

/** 最老 pending/retry 的 EMAIL 投递（job runAt 权威；age 相对 now）。 */
export async function getOldestPendingEmailDelivery(
  now = new Date(),
): Promise<OldestPendingEmailDelivery | null> {
  const job = await prisma.asyncJob.findFirst({
    where: {
      kind: "NOTIFICATION_DELIVERY",
      status: { in: ["PENDING", "RETRY"] },
    },
    orderBy: { runAt: "asc" },
    select: { payload: true, runAt: true, attempts: true },
  });
  if (!job) return null;

  const deliveryId =
    typeof job.payload === "object" &&
    job.payload !== null &&
    typeof (job.payload as { deliveryId?: unknown }).deliveryId === "string"
      ? (job.payload as { deliveryId: string }).deliveryId
      : null;
  if (!deliveryId) return null;

  const delivery = await prisma.notificationDelivery.findUnique({
    where: { id: deliveryId },
    select: { id: true, notificationId: true, provider: true },
  });
  if (!delivery) return null;

  return {
    deliveryId: delivery.id,
    notificationId: delivery.notificationId,
    provider: delivery.provider,
    jobRunAt: job.runAt,
    jobAttempts: job.attempts,
    ageMs: Math.max(0, now.getTime() - job.runAt.getTime()),
  };
}

export type EmailDeliveryAcceptanceStats = {
  providerAccepted: number;
  suppressed: number;
  pendingUnsent: number;
};

/** provider-accepted / suppressed / 未发送计数（operator 观测面）。 */
export async function getEmailDeliveryAcceptanceStats(): Promise<EmailDeliveryAcceptanceStats> {
  const [accepted, suppressed] = await Promise.all([
    prisma.notificationDelivery.count({
      where: { channel: "EMAIL", providerAcceptedAt: { not: null } },
    }),
    prisma.notificationDelivery.count({
      where: { channel: "EMAIL", suppressedAt: { not: null } },
    }),
  ]);
  const pendingUnsent = await prisma.notificationDelivery.count({
    where: { channel: "EMAIL", providerAcceptedAt: null, suppressedAt: null },
  });
  return { providerAccepted: accepted, suppressed, pendingUnsent };
}
