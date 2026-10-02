/**
 * Phase 9B：NotificationDelivery 渠道投递常量（canonical notification 域）。
 *
 * channel 是开放集合（String，不用 Prisma enum）：9B 实现 IN_APP / EMAIL；
 * IN_APP 是站内投影，不产生 external delivery row（Notification 本身即
 * 投影）；未来 WEB_PUSH / EXTERNAL 按需扩展，禁止为未实现渠道预建 provider。
 */

export const NOTIFICATION_CHANNEL_IN_APP = "IN_APP";
export const NOTIFICATION_CHANNEL_EMAIL = "EMAIL";

export type NotificationChannel = typeof NOTIFICATION_CHANNEL_IN_APP | typeof NOTIFICATION_CHANNEL_EMAIL;

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
