import type { Prisma } from "@prisma/client";

/**
 * Phase 9B：NotificationDelivery 渠道投递常量与 durable 原语
 * （canonical notification 域）。
 *
 * channel 是开放集合（String，不用 Prisma enum）：9B 实现 IN_APP / EMAIL；
 * IN_APP 是站内投影，不产生 external delivery row（Notification 本身即
 * 投影）；未来 WEB_PUSH / EXTERNAL 按需扩展，禁止为未实现渠道预建 provider。
 */

export const NOTIFICATION_CHANNEL_IN_APP = "IN_APP";
export const NOTIFICATION_CHANNEL_EMAIL = "EMAIL";

export type NotificationChannel =
  | typeof NOTIFICATION_CHANNEL_IN_APP
  | typeof NOTIFICATION_CHANNEL_EMAIL;

/**
 * 抑制语义（§28/§35/§42）：suppressedAt != null ⇒ 该 delivery 永不发起
 * provider request；对应 NOTIFICATION_DELIVERY AsyncJob 重放必须以
 * COMPLETED_IDEMPOTENT 结束（0 次 provider call）。suppressionCode 是
 * 受控机器码（RB05 同合同），只描述抑制原因，绝不携带 raw payload。
 */

/** 收件人已注销（erasure 事务内收敛，destination 同步置 redacted sentinel）。 */
export const NOTIFICATION_DELIVERY_SUPPRESSION_RECIPIENT_ERASED = "RECIPIENT_ERASED";

/** 目的地缺失/非法（snapshot 前校验失败；In-App 通知不受影响）。 */
export const NOTIFICATION_DELIVERY_SUPPRESSION_INVALID_DESTINATION = "INVALID_DESTINATION";

/** EMAIL provider 处于 disabled 配置（开发/无外部依赖环境）。 */
export const NOTIFICATION_DELIVERY_SUPPRESSION_PROVIDER_DISABLED = "PROVIDER_DISABLED";

/**
 * Phase 9C-04（§13/§14）：NOTIFICATION_DELIVERY AsyncJob DEAD_LETTER 的
 * bounded reconcile 收敛码（SSOT，选定为更明确的 NOTIFICATION_JOB_DEAD_LETTER）。
 * job DEAD_LETTER = delivery intent 已无法由 canonical worker 继续发送
 *（如 EMAIL_PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED / provider permanent failure /
 * retry budget 耗尽）——9B 已冻结"超过幂等安全窗口或 dead-letter 的投递不得
 * blind resend"（重发必须显式新 intent，绝不 revive 原 external-delivery
 * intent），因此 terminal suppression 是正确收敛。
 */
export const NOTIFICATION_DELIVERY_SUPPRESSION_JOB_DEAD_LETTER =
  "NOTIFICATION_JOB_DEAD_LETTER";

/**
 * destination 的 redacted sentinel（erasure 收敛值）：固定不可反查字符串，
 * 与 ERASED_USER_CONTENT_MARKER 同惯例（DERIVED/CONTACT 面允许牺牲原文）。
 */
export const REDACTED_EMAIL_DESTINATION = "";

/**
 * provider 幂等键（§25/§15）：deterministic——同一 notification 的 EMAIL
 * 渠道永远生成同一 key，provider 侧在其幂等保留窗口内对重复 request 只
 * 产生一次真实投递。绝不允许每次 retry 生成随机 UUID。
 */
export function buildEmailIdempotencyKey(notificationId: string): string {
  return `notification/${notificationId}/email/v1`;
}

/**
 * AsyncJob dedupeKey（§13/§15）：NOTIFICATION_DELIVERY:<deliveryId>。
 * 重复 canonical emit（dedupe 命中同一条 delivery）→ 同一 dedupeKey →
 * createMany skipDuplicates 恰好一个 EMAIL job。
 */
export function buildNotificationDeliveryJobDedupeKey(deliveryId: string): string {
  return `NOTIFICATION_DELIVERY:${deliveryId}`;
}

// ============================================================
// RB01：firstAttemptAt = durable idempotency-window anchor。
//
// 语义精度（§4）：firstAttemptAt 是【provider attempt safety-window
// anchor】——在第一次 external provider attempt 即将执行前，以独立短事务
// durable COMMIT（NULL → timestamp 单向迁移）；它【不是】provider
// acceptance timestamp（后者是 providerAcceptedAt，只在 provider 返回
// successful acceptance 后写入）。
//
// 冻结合同：
//   - 只允许 NULL → timestamp；
//   - 禁止 timestamp → newer timestamp、timestamp → NULL；
//   - 此后任何 execution transaction rollback / process crash / lease
//     recovery 都不得回退或重置 23h local safety window 的起算点。
//
// RB02：FOR UPDATE 行锁——EMAIL 执行事务在整个关键区间（suppression
// recheck → accepted recheck → window check → provider.send → accepted
// update → COMMIT）持有 delivery 行锁；account erasure 的
// notificationDelivery.updateMany 与该锁天然串行，关闭
// "erasure 先提交 → worker 用 stale destination 发送" 穿透窗口。
// ============================================================

/** anchor/锁面读取的 delivery 权威行形状（handler 关键区间使用）。 */
export type LockedNotificationDeliveryRow = {
  id: string;
  notificationId: string;
  channel: string;
  provider: string;
  destination: string;
  senderSnapshot: string;
  replyToSnapshot: string | null;
  providerIdempotencyKey: string;
  firstAttemptAt: Date | null;
  providerAcceptedAt: Date | null;
  suppressedAt: Date | null;
  suppressionCode: string | null;
};

/**
 * RB01 durable anchor（独立短事务，必须 COMMIT 后才允许 provider.send）：
 * UPDATE ... WHERE id AND firstAttemptAt IS NULL AND suppressedAt IS NULL
 * AND providerAcceptedAt IS NULL——条件迁移保证 NULL → timestamp 单向、
 * 永不覆盖既有 anchor、永不给已抑制/已接受行补锚。
 *
 * 使用 root Prisma client（独立连接/事务）——绝不在 execution transaction
 * 内调用（否则 anchor 随 execution rollback 一起消失，正是 RB01 修复的
 * bug；且会与 execution tx 的 FOR UPDATE 行锁自等待）。
 */
export async function ensureEmailFirstAttemptAnchor(
  rootClient: {
    notificationDelivery: {
      updateMany(args: {
        where: {
          id: string;
          firstAttemptAt: null;
          suppressedAt: null;
          providerAcceptedAt: null;
        };
        data: { firstAttemptAt: Date };
      }): Promise<{ count: number }>;
    };
  },
  deliveryId: string,
  now: Date,
): Promise<void> {
  await rootClient.notificationDelivery.updateMany({
    where: {
      id: deliveryId,
      firstAttemptAt: null,
      suppressedAt: null,
      providerAcceptedAt: null,
    },
    data: { firstAttemptAt: now },
  });
}

/**
 * RB02 权威行锁读取（必须在 EMAIL execution transaction 内调用——行锁保持
 * 到该事务 COMMIT，与 erasure 的行更新串行）。返回锁后权威行；禁止继续
 * 使用锁前 snapshot。
 */
export async function lockNotificationDeliveryRow(
  tx: Prisma.TransactionClient,
  deliveryId: string,
): Promise<LockedNotificationDeliveryRow | null> {
  const rows = await tx.$queryRaw<LockedNotificationDeliveryRow[]>`
    SELECT
      "id",
      "notificationId",
      "channel",
      "provider",
      "destination",
      "senderSnapshot",
      "replyToSnapshot",
      "providerIdempotencyKey",
      "firstAttemptAt",
      "providerAcceptedAt",
      "suppressedAt",
      "suppressionCode"
    FROM "NotificationDelivery"
    WHERE "id" = ${deliveryId}
    FOR UPDATE`;
  return rows[0] ?? null;
}
