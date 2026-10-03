import type { Prisma } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";

import { enqueueAsyncJobTx } from "@/lib/async/job-repository";
import {
  NOTIFICATION_DELIVERY_JOB_KIND,
  NOTIFICATION_DELIVERY_JOB_SCHEMA_VERSION,
} from "@/lib/async/job-types";
import { PermanentJobFailure } from "@/lib/async/job-types";
import { logger } from "@/lib/logger";
import { resolveEmailChannelConfig } from "@/lib/notifications/email-config";
import {
  buildEmailIdempotencyKey,
  buildNotificationDeliveryJobDedupeKey,
  NOTIFICATION_CHANNEL_EMAIL,
  NOTIFICATION_DELIVERY_SUPPRESSION_INVALID_DESTINATION,
  NOTIFICATION_DELIVERY_SUPPRESSION_PROVIDER_DISABLED,
  NOTIFICATION_DELIVERY_SUPPRESSION_RECIPIENT_ERASED,
  REDACTED_EMAIL_DESTINATION,
} from "@/lib/notifications/notification-delivery";
import {
  NOTIFICATION_SCHEMA_VERSION,
  NotificationIntentContractError,
  hasEmailChannel,
  resolveNotificationDefinition,
  validateNotificationIntent,
} from "./notification-registry";
import { extractEmailAddress } from "./email-config";

/**
 * Phase 9B：canonical notification emit service（§16）。
 *
 * 全仓唯一 production Notification 写入方（§17/§50/§92）：业务域不再持有
 * 任意 title/content 写入能力——只允许 emitNotificationTx({ kind, payload })，
 * title/content 由 registry 渲染器生成。事务边界合同（§14/§22）：
 *
 *   Notification（IN_APP 投影）+ NotificationDelivery（EMAIL 意图）+
 *   AsyncJob(NOTIFICATION_DELIVERY) 必须与调用方业务事务同一 COMMIT；
 *   禁止"先 create Notification COMMIT，稍后 enqueue email"。
 *
 * 并发/重放 exactly-once（§15/§65）：全部 dedupe 走 DB UNIQUE +
 * createMany skipDuplicates（与 Phase 9A enqueueAsyncJobTx 同一合同），
 * 绝不允许 findFirst → create 竞态窗口。同一 dedupeKey 的两个并发事务
 * 收敛到恰好 1 Notification / 1 delivery / 1 job。
 */

export type NotificationIntent = {
  kind: string;
  /** 缺省 = NOTIFICATION_SCHEMA_VERSION（9B 起 1）。 */
  schemaVersion?: number;
  recipientUserId: string;
  /**
   * 调用方组合的确定性幂等键（如 `${KIND}:${orderId}:${recipientUserId}`；
   * outbox 派生路径沿用 `OUTBOX:<eventId>:IN_APP:<userId>`）。可合法重复
   * 的事件（续租请求/认证重新提交等）必须携带 occurrence discriminator。
   */
  dedupeKey: string;
  payload: unknown;
  /** General Order FK（RentalOrder 类事件传 null——RentalOrder 不是 Order 行）。 */
  orderId?: string | null;
  /** 产生本通知的 OutboxEvent.id（outbox 派生路径溯源）。 */
  sourceEventId?: string | null;
};

export type EmittedNotification = {
  notificationId: string;
};

/**
 * canonical 单条 emit（必须在调用方业务事务内执行；contract 校验失败抛
 * NotificationIntentContractError → 整个事务回滚、零行落库）。
 */
export async function emitNotificationTx(
  tx: Prisma.TransactionClient,
  intent: NotificationIntent,
): Promise<EmittedNotification> {
  const schemaVersion = intent.schemaVersion ?? NOTIFICATION_SCHEMA_VERSION;

  const definition = resolveNotificationDefinition(intent.kind, schemaVersion);
  if (!definition) {
    throw new NotificationIntentContractError("UNKNOWN_CONTRACT", intent.kind, schemaVersion);
  }

  const validated = validateNotificationIntent(intent.kind, schemaVersion, intent.payload);
  if (!validated.ok) {
    throw new NotificationIntentContractError(validated.reason, intent.kind, schemaVersion);
  }

  if (intent.dedupeKey.length === 0) {
    throw new NotificationIntentContractError("INVALID_DEDUPE_KEY", intent.kind, schemaVersion);
  }

  // WRITE-TIME 渲染：title/content 由 registry 生成（§17），payload 已过
  // strict schema——渲染只依赖 IDs + 机器状态。
  const rendered = definition.renderInApp(validated.payload as never, intent.recipientUserId);

  // DB 级 exactly-once：dedupeKey UNIQUE + createMany skipDuplicates。
  // 并发事务在 unique index 上线性化（ON CONFLICT DO NOTHING 等待持有者
  // 提交/回滚），随后 READ COMMITTED 新快照 findUnique 必见 winner 行。
  const inserted = await tx.notification.createMany({
    data: [
      {
        userId: intent.recipientUserId,
        orderId: intent.orderId ?? null,
        type: rendered.type,
        title: rendered.title,
        content: rendered.content,
        isRead: false,
        dedupeKey: intent.dedupeKey,
        sourceEventId: intent.sourceEventId ?? null,
        kind: intent.kind,
        schemaVersion,
        payload: validated.payload as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });

  const notification = await tx.notification.findUnique({
    where: { dedupeKey: intent.dedupeKey },
    select: {
      id: true,
      userId: true,
      kind: true,
      schemaVersion: true,
      payload: true,
      orderId: true,
      sourceEventId: true,
    },
  });
  if (!notification) {
    // 结构性不可达（unique index 线性化后 winner 必已提交）；防御 fail closed。
    throw new PermanentJobFailure(
      "NOTIFICATION_MATERIALIZATION_MISSING",
      `notification dedupe winner 缺失：${intent.dedupeKey}`,
    );
  }

  // RB04（Review §18/§19）：dedupe winner 身份验证——仅在本方 insert 被
  // skipDuplicates 跳过（inserted.count === 0，winner 可能是【别的 intent】
  // 的行）时强制执行。same key + same canonical intent → 幂等成功；
  // same key + different intent（caller 拼键错误 / 聚合 ID 复用）→
  // NOTIFICATION_DEDUPE_COLLISION（PERMANENT）→ 整个调用事务回滚：绝不
  // 创建 NotificationDelivery、绝不 enqueue EMAIL job。count === 1 时
  // winner 就是本方刚插入的行，无需校验。
  if (inserted.count === 0) {
    const winnerMatchesIntent =
      notification.userId === intent.recipientUserId &&
      notification.kind === intent.kind &&
      notification.schemaVersion === schemaVersion &&
      isDeepStrictEqual(notification.payload, validated.payload) &&
      (notification.orderId ?? null) === (intent.orderId ?? null) &&
      (notification.sourceEventId ?? null) === (intent.sourceEventId ?? null);
    if (!winnerMatchesIntent) {
      throw new PermanentJobFailure(
        "NOTIFICATION_DEDUPE_COLLISION",
        `dedupeKey 命中不同 canonical intent，拒绝 alias（key=${intent.dedupeKey} kind=${intent.kind}）`,
      );
    }
  }

  // 渠道策略（§8/§9）：EMAIL 渠道 → NotificationDelivery（external intent
  // 快照）+ NOTIFICATION_DELIVERY AsyncJob，与 Notification 同事务原子
  // COMMIT（§14——禁止先 COMMIT Notification 再稍后 enqueue email）。
  if (hasEmailChannel(definition)) {
    await materializeEmailDeliveryTx(tx, {
      notificationId: notification.id,
      recipientUserId: intent.recipientUserId,
      kind: intent.kind,
      schemaVersion,
    });
  }

  return { notificationId: notification.id };
}

/**
 * EMAIL 渠道物化（§11/§13/§15/§33/§35/§42/§43）：
 *
 * 1. 目的地快照：emit 时刻读取 recipient {email, erasedAt} 并校验（§42）。
 *    retry 绝不重读 User.email / EMAIL_FROM——delivery 行固化一切
 *    deterministic 输入（§33）。
 * 2. 抑制语义（suppressedAt != null ⇒ 永不发起 provider request，对应
 *    AsyncJob 重放 → COMPLETED_IDEMPOTENT，0 provider call）：
 *      - 收件人已注销（erasedAt != null，§43）→ RECIPIENT_ERASED +
 *        destination 置 redacted sentinel；
 *      - 无合法邮箱 → INVALID_DESTINATION（不阻塞 In-App 通知）；
 *      - provider=disabled（开发环境）→ PROVIDER_DISABLED（保留合法
 *        destination 供审计；绝不 enqueue 发送 job）。
 * 3. 幂等（§15）：UNIQUE(notificationId, channel) + UNIQUE(providerIdem
 *    potencyKey) + NOTIFICATION_DELIVERY:<deliveryId> dedupeKey——重复
 *    canonical emit 收敛到恰好 1 delivery + 1 EMAIL job。
 *
 * destination 属 CONTACT_INFO（privacy registry：DIRECT_IDENTITY）——
 * 本函数绝不写任何结构化日志携带 destination。
 */
async function materializeEmailDeliveryTx(
  tx: Prisma.TransactionClient,
  input: { notificationId: string; recipientUserId: string; kind: string; schemaVersion: number },
): Promise<{ deliveryId: string; suppressed: boolean }> {
  const channelConfig = resolveEmailChannelConfig();

  const recipient = await tx.user.findUnique({
    where: { id: input.recipientUserId },
    select: { email: true, erasedAt: true },
  });
  if (!recipient) {
    // 结构性损坏（Notification FK 已保证 user 存在）；防御 fail closed。
    throw new PermanentJobFailure(
      "NOTIFICATION_RECIPIENT_MISSING",
      `EMAIL 渠道收件人缺失：${input.recipientUserId}`,
    );
  }

  let destination = recipient.email;
  let suppressedAt: Date | null = null;
  let suppressionCode: string | null = null;

  if (recipient.erasedAt) {
    destination = REDACTED_EMAIL_DESTINATION;
    suppressedAt = new Date();
    suppressionCode = NOTIFICATION_DELIVERY_SUPPRESSION_RECIPIENT_ERASED;
  } else if (extractEmailAddress(destination) === null) {
    destination = REDACTED_EMAIL_DESTINATION;
    suppressedAt = new Date();
    suppressionCode = NOTIFICATION_DELIVERY_SUPPRESSION_INVALID_DESTINATION;
  } else if (channelConfig.provider === "disabled") {
    suppressedAt = new Date();
    suppressionCode = NOTIFICATION_DELIVERY_SUPPRESSION_PROVIDER_DISABLED;
  }

  const providerIdempotencyKey = buildEmailIdempotencyKey(input.notificationId);

  // DB 级 exactly-once：UNIQUE(notificationId, channel) +
  // UNIQUE(providerIdempotencyKey) + skipDuplicates（与 9A 同合同）。
  await tx.notificationDelivery.createMany({
    data: [
      {
        notificationId: input.notificationId,
        channel: NOTIFICATION_CHANNEL_EMAIL,
        provider: channelConfig.provider,
        destination,
        senderSnapshot: channelConfig.from ?? REDACTED_EMAIL_DESTINATION,
        replyToSnapshot: channelConfig.replyTo,
        providerIdempotencyKey,
        suppressedAt,
        suppressionCode,
      },
    ],
    skipDuplicates: true,
  });

  const delivery = await tx.notificationDelivery.findUnique({
    where: {
      notificationId_channel: {
        notificationId: input.notificationId,
        channel: NOTIFICATION_CHANNEL_EMAIL,
      },
    },
    select: { id: true, suppressedAt: true },
  });
  if (!delivery) {
    throw new PermanentJobFailure(
      "NOTIFICATION_DELIVERY_MATERIALIZATION_MISSING",
      `email delivery dedupe winner 缺失：notification=${input.notificationId}`,
    );
  }

  if (delivery.suppressedAt !== null) {
    // 抑制 delivery 不 enqueue 发送 job（provider call = 0 by construction）
    return { deliveryId: delivery.id, suppressed: true };
  }

  await enqueueAsyncJobTx(tx, {
    kind: NOTIFICATION_DELIVERY_JOB_KIND,
    schemaVersion: NOTIFICATION_DELIVERY_JOB_SCHEMA_VERSION,
    dedupeKey: buildNotificationDeliveryJobDedupeKey(delivery.id),
    payload: { deliveryId: delivery.id },
    runAt: new Date(),
  });

  logger.info("notification_email_intent_enqueued", "notification-service", {
    event: "notification_email_intent_enqueued",
    notificationId: input.notificationId,
    deliveryId: delivery.id,
    kind: input.kind,
    schemaVersion: input.schemaVersion,
    provider: channelConfig.provider,
  });

  return { deliveryId: delivery.id, suppressed: false };
}

/** 批量 emit（逐条 canonical 合同；顺序执行保证与单条完全同语义）。 */
export async function emitNotificationsTx(
  tx: Prisma.TransactionClient,
  intents: NotificationIntent[],
): Promise<EmittedNotification[]> {
  const emitted: EmittedNotification[] = [];
  for (const intent of intents) {
    emitted.push(await emitNotificationTx(tx, intent));
  }
  return emitted;
}
