import {
  EmailTemplateContractError,
  resolveEmailAppBaseUrl,
} from "@/lib/notifications/email-config";
import {
  hasEmailChannel,
  parseNotificationPayload,
  resolveNotificationDefinition,
} from "@/lib/notifications/notification-registry";
import type { EmailRenderedContent } from "@/lib/notifications/notification-registry";

/**
 * Phase 9B：transactional email 渲染入口（email delivery handler 执行边界）。
 *
 * 模板本体在 notification-registry definition 上（§7：template version 与
 * kind/version 契约同源冻结；本模块保持单一 dispatch 路径，防止 handler
 * 侧出现第二套渲染逻辑）：
 *
 *   definition = registry(kind, schemaVersion)（缺失/未开通 EMAIL → 结构性
 *   损坏 fail closed）→ strict parse payload（READ-TIME validation，§6）→
 *   definition.renderEmail(payload, recipientUserId, { appBaseUrl })。
 *
 * §41 link origin：appBaseUrl 唯一来源 = canonical NEXTAUTH_URL
 * （resolveEmailAppBaseUrl），绝不受 Host header / request origin /
 * client input 影响；§40 escaping 由 email-escape.ts 在模板内强制。
 */

export type NotificationEmailInput = {
  kind: string;
  schemaVersion: number;
  payload: unknown;
};

export function renderNotificationEmail(
  notification: NotificationEmailInput,
  recipientUserId: string,
  appBaseUrl: string,
): EmailRenderedContent {
  const definition = resolveNotificationDefinition(notification.kind, notification.schemaVersion);
  if (!definition || !hasEmailChannel(definition) || !definition.renderEmail) {
    // RB03（§14）：结构性 contract 缺陷 → PERMANENT（重试不可能成功）
    throw new EmailTemplateContractError(
      "EMAIL_TEMPLATE_UNREGISTERED",
      `notification kind 未开通 EMAIL 渠道/渲染器：${notification.kind}@${notification.schemaVersion}`,
    );
  }

  const payload = parseNotificationPayload(notification, definition.payloadSchema);
  return definition.renderEmail(payload as never, recipientUserId, { appBaseUrl });
}

/** handler 便捷入口：origin 解析 + 渲染一步完成（env 显式传入便于测试）。 */
export function renderNotificationEmailFromEnv(
  notification: NotificationEmailInput,
  recipientUserId: string,
  env: Record<string, string | undefined> = process.env,
): EmailRenderedContent {
  return renderNotificationEmail(notification, recipientUserId, resolveEmailAppBaseUrl(env));
}
