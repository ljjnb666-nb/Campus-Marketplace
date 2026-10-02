import type { Prisma } from "@prisma/client";

import { logger } from "@/lib/logger";
import {
  PermanentJobFailure,
  notificationDeliveryPayloadSchema,
  type ClaimedAsyncJob,
  type JobExecutionOutcome,
} from "@/lib/async/job-types";
import {
  EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS,
  resolveEmailSendConfig,
} from "@/lib/notifications/email-config";
import {
  EmailProviderPermanentError,
  EmailProviderRetryableError,
  isEmailIdempotencyWindowExpired,
} from "@/lib/notifications/email-provider";
import { renderNotificationEmailFromEnv } from "@/lib/notifications/email-renderer";
import { ResendEmailProvider } from "@/lib/notifications/providers/resend";

/**
 * Phase 9B：NOTIFICATION_DELIVERY@1 handler（§13/§26/§28/§55/§56）。
 *
 * 运行于 9A runner 合同之下：beginAsyncJobExecutionTx（leaseToken fencing，
 * 行锁保持到 COMMIT）→ 本 handler → 条件 completion marker。external
 * side effect（provider HTTP）发生在本执行事务内——crash window
 * （provider accepted → 本事务未 COMMIT）由 deterministic provider 幂等键
 * 收敛（同一 key 重放 → provider 幂等保留窗口内仅一次真实投递，§56/§57）。
 *
 * 幂等顺序（§55）：
 *   strict parse { deliveryId }
 *   → fresh 读取 delivery（结构性缺失 = PERMANENT，fail closed）
 *   → suppressed → COMPLETED_IDEMPOTENT（0 provider call；erasure/
 *     INVALID_DESTINATION/provider-disabled 收敛语义）
 *   → providerAcceptedAt != null → COMPLETED_IDEMPOTENT（crash-after-accept
 *     replay：不重复发送）
 *   → 幂等窗口（§26）：firstAttemptAt 起算 >= 23h → no provider request
 *     → PermanentJobFailure(EMAIL_PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED)
 *     → DEAD_LETTER（禁止超窗盲目重发；重发必须显式新 intent，§27）
 *   → canonical Notification fresh 读取（legacy 无 kind 行 = 结构性损坏
 *     → PERMANENT；EMAIL 只可能由 canonical service 创建）
 *   → registry 模板渲染（strict payload re-validation，§6 read-time）
 *   → provider.send（deterministic 快照：destination/sender/replyTo 全部
 *     来自 delivery 行，§33）
 *   → 条件落 providerMessageId + providerAcceptedAt → COMMIT
 *
 * 语义（§28）：providerAcceptedAt = provider 接受发送请求，绝不声称
 * mailbox delivered/opened/read。9B 不做 delivery webhook。
 *
 * 隐私（§32）：本 handler 的结构化日志只允许 notificationId / deliveryId /
 * jobId / provider / kind / attempt / durationMs / 安全错误码——收件地址、
 * 主题、正文、API key、provider raw response 绝不出现。
 */

const EMAIL_PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED = "EMAIL_PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED";

function logEmail(
  event: string,
  input: {
    job: ClaimedAsyncJob;
    deliveryId: string;
    notificationId?: string;
    kind?: string | null;
    provider?: string;
    code?: string;
    startedAt?: number;
  },
): void {
  logger.info(event, "notification-delivery", {
    event,
    jobId: input.job.id,
    deliveryId: input.deliveryId,
    ...(input.notificationId ? { notificationId: input.notificationId } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    attempt: input.job.attempts,
    ...(input.code ? { code: input.code } : {}),
    ...(input.startedAt !== undefined ? { durationMs: Date.now() - input.startedAt } : {}),
  });
}

export const notificationDeliveryHandler = async (
  tx: Prisma.TransactionClient,
  job: ClaimedAsyncJob,
): Promise<JobExecutionOutcome> => {
  const startedAt = Date.now();

  // 1) strict payload（RB04：形状非法 = 结构性损坏 → PERMANENT）
  const parsed = notificationDeliveryPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new PermanentJobFailure(
      "NOTIFICATION_DELIVERY_PAYLOAD_INVALID",
      `NOTIFICATION_DELIVERY payload 形状非法（job=${job.id}）`,
    );
  }
  const { deliveryId } = parsed.data;

  // 2) fresh 读取 delivery（单 job ⇔ 单 delivery；AsyncJob lease 保证无并发执行者）
  const delivery = await tx.notificationDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery || delivery.channel !== "EMAIL") {
    throw new PermanentJobFailure(
      "NOTIFICATION_DELIVERY_AGGREGATE_MISSING",
      `EMAIL NotificationDelivery 缺失或渠道不符：${deliveryId}`,
    );
  }

  // 3) suppressed → 幂等成功（erasure / INVALID_DESTINATION / provider-disabled；
  //    §35：provider call = 0）
  if (delivery.suppressedAt !== null) {
    logEmail("email_delivery_suppressed", {
      job,
      deliveryId,
      provider: delivery.provider,
      code: delivery.suppressionCode ?? "SUPPRESSED",
      startedAt,
    });
    return { kind: "COMPLETED_IDEMPOTENT" };
  }

  // 4) crash-after-accept replay → 幂等成功（不重复发送，§56）
  if (delivery.providerAcceptedAt !== null) {
    logEmail("email_delivery_provider_accepted", {
      job,
      deliveryId,
      provider: delivery.provider,
      code: "IDEMPOTENT_REPLAY",
      startedAt,
    });
    return { kind: "COMPLETED_IDEMPOTENT" };
  }

  // 5) 幂等窗口（§26）：firstAttemptAt = 首次实际 provider attempt 基准。
  //    条件 stamp 保证 fenced replay 不改写既有基准；超窗 no-provider-call。
  const now = new Date();
  if (delivery.firstAttemptAt === null) {
    await tx.notificationDelivery.updateMany({
      where: { id: delivery.id, firstAttemptAt: null },
      data: { firstAttemptAt: now },
    });
  }
  const firstAttemptAt = delivery.firstAttemptAt ?? now;
  if (isEmailIdempotencyWindowExpired(firstAttemptAt, now, EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS)) {
    // §27：9B 不提供 blind requeue——provider 幂等保证已过期，重发必须
    // 显式新 notification/delivery intent。0 次 provider request。
    logEmail("email_delivery_dead_lettered", {
      job,
      deliveryId,
      provider: delivery.provider,
      code: EMAIL_PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED,
      startedAt,
    });
    throw new PermanentJobFailure(
      EMAIL_PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED,
      `EMAIL 幂等安全窗口（${EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS / 3_600_000}h）已过期：delivery=${deliveryId}`,
    );
  }

  // 6) canonical Notification fresh 读取 + registry 渲染（read-time strict）
  const notification = await tx.notification.findUnique({
    where: { id: delivery.notificationId },
    select: { id: true, kind: true, schemaVersion: true, payload: true, userId: true },
  });
  if (
    !notification ||
    notification.kind === null ||
    notification.schemaVersion === null
  ) {
    throw new PermanentJobFailure(
      "NOTIFICATION_DELIVERY_SOURCE_MISSING",
      `EMAIL delivery 的 canonical Notification 缺失或非 canonical 行：delivery=${deliveryId}`,
    );
  }

  const rendered = renderNotificationEmailFromEnv(
    { kind: notification.kind, schemaVersion: notification.schemaVersion, payload: notification.payload },
    notification.userId,
  );

  // 7) provider send（deterministic 快照，§33；resend 为 9B 唯一 production provider）
  const sendConfig = resolveEmailSendConfig();
  const provider = new ResendEmailProvider({
    apiKey: sendConfig.apiKey,
    baseUrl: sendConfig.baseUrl,
    timeoutMs: sendConfig.timeoutMs,
  });

  logEmail("email_delivery_attempted", {
    job,
    deliveryId,
    notificationId: notification.id,
    kind: notification.kind,
    provider: provider.name,
    startedAt,
  });

  let result: { providerMessageId: string };
  try {
    result = await provider.sendTransactionalEmail({
      idempotencyKey: delivery.providerIdempotencyKey,
      from: delivery.senderSnapshot,
      to: delivery.destination,
      replyTo: delivery.replyToSnapshot,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
  } catch (error) {
    if (error instanceof EmailProviderPermanentError) {
      logEmail("email_delivery_dead_lettered", {
        job,
        deliveryId,
        notificationId: notification.id,
        kind: notification.kind,
        provider: provider.name,
        code: error.code,
        startedAt,
      });
      throw error;
    }
    const code = error instanceof EmailProviderRetryableError ? error.code : "EMAIL_PROVIDER_UNKNOWN";
    // 9A central backoff：attempts < maxAttempts → RETRY，否则 DEAD_LETTER
    if (job.attempts < job.maxAttempts) {
      logEmail("email_delivery_retry_scheduled", {
        job,
        deliveryId,
        notificationId: notification.id,
        kind: notification.kind,
        provider: provider.name,
        code,
        startedAt,
      });
    } else {
      logEmail("email_delivery_dead_lettered", {
        job,
        deliveryId,
        notificationId: notification.id,
        kind: notification.kind,
        provider: provider.name,
        code,
        startedAt,
      });
    }
    throw error;
  }

  // 8) 条件落 provider accepted 状态（suppressed 并发竞态防御：erasure 在
  //    本 job 执行期间抑制 delivery 时，信件可能已发出——如实记录 provenance
  //    并幂等完成，provider accepted 事实不可回滚）
  const accepted = await tx.notificationDelivery.updateMany({
    where: { id: delivery.id, providerAcceptedAt: null, suppressedAt: null },
    data: {
      providerMessageId: result.providerMessageId,
      providerAcceptedAt: new Date(),
    },
  });
  if (accepted.count === 0) {
    logger.warn("email 已发送但 delivery 在执行期间被抑制（erasure 竞态）", "notification-delivery", {
      event: "email_delivery_suppressed_after_send",
      jobId: job.id,
      deliveryId,
      provider: provider.name,
    });
    return { kind: "COMPLETED_IDEMPOTENT" };
  }

  logEmail("email_delivery_provider_accepted", {
    job,
    deliveryId,
    notificationId: notification.id,
    kind: notification.kind,
    provider: provider.name,
    startedAt,
  });

  return { kind: "COMPLETED" };
};
