import type { Prisma } from "@prisma/client";

import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  PermanentJobFailure,
  notificationDeliveryPayloadSchema,
  type ClaimedAsyncJob,
  type JobExecutionOutcome,
} from "@/lib/async/job-types";
import {
  EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS,
  EmailRuntimeConfigUnavailableError,
  EMAIL_RUNTIME_CONFIG_UNAVAILABLE,
  resolveEmailAppBaseUrl,
  resolveEmailSendConfig,
} from "@/lib/notifications/email-config";
import {
  EmailProviderPermanentError,
  EmailProviderRetryableError,
  isEmailIdempotencyWindowExpired,
} from "@/lib/notifications/email-provider";
import { renderNotificationEmail } from "@/lib/notifications/email-renderer";
import { ResendEmailProvider } from "@/lib/notifications/providers/resend";
import {
  ensureEmailFirstAttemptAnchor,
  lockNotificationDeliveryRow,
  type LockedNotificationDeliveryRow,
} from "@/lib/notifications/notification-delivery";

/**
 * Phase 9B：NOTIFICATION_DELIVERY@1 handler（§13/§26/§28/§55/§56）。
 *
 * 运行于 9A runner 合同之下：beginAsyncJobExecutionTx（leaseToken fencing，
 * 行锁保持到 COMMIT）→ 本 handler → 条件 completion marker。external
 * side effect（provider HTTP）发生在本执行事务内——crash window
 * （provider accepted → 本事务未 COMMIT）由 deterministic provider 幂等键
 * 收敛（同一 key 重放 → provider 幂等保留窗口内仅一次真实投递，§56/§57）。
 *
 * 幂等顺序（§55 + Review RB01/RB02）：
 *   strict parse { deliveryId }
 *   → execution tx 预读 delivery（结构性缺失 = PERMANENT，fail closed；
 *     suppressed / providerAcceptedAt 预检快速幂等出口）
 *   → RB01 durable anchor：独立短事务（root client）COMMIT
 *     firstAttemptAt（NULL → timestamp 单向；绝不在 execution tx 内写——
 *     否则 provider accept 后 rollback 会把 anchor 一起回滚，23h local
 *     safety window 在 crash replay 后重新起算）。anchor 是【provider
 *     attempt safety-window anchor】，不是 acceptance timestamp。
 *   → execution tx 内 SELECT ... FOR UPDATE 行锁 + 权威 re-read
 *     （suppressedAt / providerAcceptedAt / destination / firstAttemptAt；
 *     RB02：禁止使用锁前 snapshot）——erasure 的行更新与本锁天然串行：
 *     erasure 先提交 → worker 见 suppressed（0 provider call）；
 *     worker 先拿到锁 → erasure 阻塞至本事务提交后再 redact destination。
 *   → 幂等窗口（§26）：权威 firstAttemptAt 起算 >= 23h → no provider
 *     request → PermanentJobFailure(EMAIL_PROVIDER_IDEMPOTENCY_WINDOW_
 *     EXPIRED) → DEAD_LETTER（禁止超窗盲目重发；重发必须显式新 intent，
 *     §27）
 *   → registry 模板渲染（strict payload re-validation，§6 read-time）；
 *     结构性 contract 缺陷 = EmailTemplateContractError → PERMANENT；
 *     runtime config 不可用（NEXTAUTH_URL 等）= RETRYABLE
 *   → provider.send（deterministic 快照：destination/sender/replyTo 全部
 *     来自锁后权威行，§33；runtime config 不可用 → RETRYABLE，0 provider
 *     call，等已配置 worker 接管——滚动发布安全）
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

/**
 * TEST-ONLY seam（生产绝不调用）：在 delivery 行锁 + 权威 re-read 之后、
 * provider.send 之前的受控暂停点（ERASURE-RACE-02 确定性 barrier）。
 */
type NotificationDeliveryHandlerSeam = {
  afterDeliveryRowLock?: (delivery: LockedNotificationDeliveryRow) => Promise<void>;
};

let handlerTestSeam: NotificationDeliveryHandlerSeam | null = null;

/** 仅测试注入；生产路径必须保持 null。 */
export function setNotificationDeliveryHandlerSeamForTests(
  seam: NotificationDeliveryHandlerSeam | null,
): void {
  handlerTestSeam = seam;
}

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

/** runtime config 不可用 → 统一转 RETRYABLE（0 provider call，等配置 worker 接管）。 */
function toRetryableIfConfigUnavailable(error: unknown, deliveryId: string): unknown {
  if (error instanceof EmailRuntimeConfigUnavailableError) {
    logger.warn("worker EMAIL runtime config 不可用（retryable）", "notification-delivery", {
      event: "email_delivery_config_unavailable",
      deliveryId,
      code: error.code,
    });
    return new EmailProviderRetryableError(
      EMAIL_RUNTIME_CONFIG_UNAVAILABLE,
      "当前 worker 缺少可用 EMAIL 配置：RETRYABLE（等待已配置 worker 接管）",
    );
  }
  return error;
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

  // 2) execution tx 预读（无行锁；仅快速幂等出口与结构校验）
  const preRead = await tx.notificationDelivery.findUnique({ where: { id: deliveryId } });
  if (!preRead || preRead.channel !== "EMAIL") {
    throw new PermanentJobFailure(
      "NOTIFICATION_DELIVERY_AGGREGATE_MISSING",
      `EMAIL NotificationDelivery 缺失或渠道不符：${deliveryId}`,
    );
  }

  // 3) suppressed 预检（§35：erasure / INVALID_DESTINATION / provider-disabled；
  //    0 provider call）
  if (preRead.suppressedAt !== null) {
    logEmail("email_delivery_suppressed", {
      job,
      deliveryId,
      provider: preRead.provider,
      code: preRead.suppressionCode ?? "SUPPRESSED",
      startedAt,
    });
    return { kind: "COMPLETED_IDEMPOTENT" };
  }

  // 4) crash-after-accept 预检 → 幂等成功（不重复发送，§56）
  if (preRead.providerAcceptedAt !== null) {
    logEmail("email_delivery_provider_accepted", {
      job,
      deliveryId,
      provider: preRead.provider,
      code: "IDEMPOTENT_REPLAY",
      startedAt,
    });
    return { kind: "COMPLETED_IDEMPOTENT" };
  }

  // 5) RB01 durable anchor：独立短事务（root client）先 COMMIT firstAttemptAt，
  //    然后才允许 provider attempt。条件迁移（WHERE firstAttemptAt IS NULL
  //    AND suppressedAt IS NULL AND providerAcceptedAt IS NULL）保证：
  //    NULL → timestamp 单向；绝不覆盖/回退既有 anchor；绝不给已抑制/已
  //    接受行补锚。erasure 并发持有行锁时本 UPDATE 阻塞至其提交，随后
  //    no-op（suppressed 已置位）→ 下一步锁后 re-read 幂等出口。
  const anchorNow = new Date();
  await ensureEmailFirstAttemptAnchor(prisma, deliveryId, anchorNow);

  // 6) RB02 权威行锁 + re-read（关键区间起点：锁保持到 execution tx COMMIT，
  //    erasure 的行更新与本区间串行；禁止使用锁前 snapshot）
  const delivery = await lockNotificationDeliveryRow(tx, deliveryId);
  if (!delivery || delivery.channel !== "EMAIL") {
    throw new PermanentJobFailure(
      "NOTIFICATION_DELIVERY_AGGREGATE_MISSING",
      `EMAIL NotificationDelivery 锁后缺失：${deliveryId}`,
    );
  }

  // 7) 锁后幂等 recheck（权威行；erasure 可能在 anchor 与锁之间提交）
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

  // 8) RB01 幂等窗口（§26）：以 durable anchor 起算；超窗 no-provider-call
  //    → PERMANENT → DEAD_LETTER（§27：重发必须显式新 intent）
  const firstAttemptAt = delivery.firstAttemptAt ?? anchorNow;
  const windowNow = new Date();
  if (isEmailIdempotencyWindowExpired(firstAttemptAt, windowNow, EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS)) {
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

  // 9) TEST-ONLY seam（ERASURE-RACE-02 barrier；生产恒 null）
  await handlerTestSeam?.afterDeliveryRowLock?.(delivery);

  // 10) 渲染（read-time strict validation）：结构性 contract 缺陷 →
  //     EmailTemplateContractError（PERMANENT）；runtime config 不可用
  //     （NEXTAUTH_URL 等）→ RETRYABLE
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

  let rendered;
  try {
    const appBaseUrl = resolveEmailAppBaseUrl();
    rendered = renderNotificationEmail(
      { kind: notification.kind, schemaVersion: notification.schemaVersion, payload: notification.payload },
      notification.userId,
      appBaseUrl,
    );
  } catch (error) {
    throw toRetryableIfConfigUnavailable(error, deliveryId);
  }

  // 11) provider send config：runtime config 不可用 → RETRYABLE（0 provider
  //     call；resend 为 9B 唯一 production provider）
  let sendConfig;
  try {
    sendConfig = resolveEmailSendConfig();
  } catch (error) {
    throw toRetryableIfConfigUnavailable(error, deliveryId);
  }
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

  // 12) 条件落 provider accepted 状态（行锁保持中——erasure 在本事务提交前
  //     无法改写本行；suppressed 竞态在锁后 recheck 已排除，此处防御性
  //     条件谓词保留）
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
