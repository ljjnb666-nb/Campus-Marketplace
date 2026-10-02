import type { Prisma } from "@prisma/client";

import { PermanentJobFailure } from "@/lib/async/job-types";

import {
  NOTIFICATION_SCHEMA_VERSION,
  NotificationIntentContractError,
  resolveNotificationDefinition,
  validateNotificationIntent,
} from "./notification-registry";

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
  await tx.notification.createMany({
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
    select: { id: true },
  });
  if (!notification) {
    // 结构性不可达（unique index 线性化后 winner 必已提交）；防御 fail closed。
    throw new PermanentJobFailure(
      "NOTIFICATION_MATERIALIZATION_MISSING",
      `notification dedupe winner 缺失：${intent.dedupeKey}`,
    );
  }

  // EMAIL 渠道物化（NotificationDelivery + AsyncJob）随 email slice 在
  // commitChannelDeliveriesTx 接入（Phase 9B commit 4）；9B registry 中
  // EMAIL 渠道 kind 上线时启用。
  return { notificationId: notification.id };
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
