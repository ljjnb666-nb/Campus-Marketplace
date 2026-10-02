import {
  EmailProviderConfigError,
  resolveEmailAppBaseUrl,
} from "@/lib/notifications/email-config";
import {
  parseNotificationPayload,
  PRODUCT_RESERVATION_EXPIRED_KIND,
  resolveNotificationDefinition,
} from "@/lib/notifications/notification-registry";
import type { EmailRenderedContent } from "@/lib/notifications/notification-registry";

/**
 * Phase 9B：transactional email 渲染层（§38/§39/§40/§41）。
 *
 * - template version 随 registry definition 冻结（PRODUCT_RESERVATION_
 *   EXPIRED@1 等）；渲染 = 纯函数(payload, appBaseUrl)。
 * - §39 template safety：9B 邮件模板禁止 user-authored 内容——固定中文
 *   文案 + safe application URL（listing title / 留言 / note 绝不进模板）。
 * - §40 HTML escaping：所有 dynamic value 必须经 escapeHtml（本文件提供
 *   reusable helper 并有专测：< > & " ' 不可形成 injection）；即使当前
 *   模板只含 machine-safe 值，helper 依然强制使用。
 * - §41 link origin：唯一来源 = canonical NEXTAUTH_URL（resolveEmailApp
 *   BaseUrl），绝不受 Host header / request origin / client input 影响。
 * - §38 必须同时提供 subject / plain text / HTML。
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** reusable HTML escape helper（§40；全部五个危险字符强制转义）。 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** 邮件正文 footer（固定中文文案；不含任何动态用户内容）。 */
const EMAIL_FOOTER_TEXT = "本邮件为校园集市系统事务邮件，请勿直接回复。";

type ReservationExpiredEmailPayload = {
  orderId: string;
  buyerId: string;
  sellerId: string;
};

/**
 * PRODUCT_RESERVATION_EXPIRED@1 邮件模板（固定文案，§39）。
 * role = 收件人视角（buyer / seller），决定正文一句固定描述。
 */
export function renderReservationExpiredEmail(
  payload: ReservationExpiredEmailPayload,
  recipientUserId: string,
  appBaseUrl: string,
): EmailRenderedContent {
  const isBuyer = recipientUserId === payload.buyerId;
  const roleSentence = isBuyer
    ? "卖家未在确认期限内接受订单，商品预留已自动释放。"
    : "该商品订单已超过确认期限，预留已自动释放。";
  const subject = "商品预留已过期";
  const ordersUrl = `${appBaseUrl}/my/orders`;

  const text = [
    "您有一条交易通知：商品预留已过期。",
    "",
    roleSentence,
    "",
    `请登录平台查看详情：${ordersUrl}`,
    "",
    EMAIL_FOOTER_TEXT,
  ].join("\n");

  const html = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<body>",
    '  <p>您有一条交易通知：<strong>商品预留已过期</strong>。</p>',
    `  <p>${escapeHtml(roleSentence)}</p>`,
    `  <p><a href="${escapeHtml(ordersUrl)}">请登录平台查看详情</a></p>`,
    `  <p>${escapeHtml(EMAIL_FOOTER_TEXT)}</p>`,
    "</body>",
    "</html>",
  ].join("\n");

  return { subject, text, html };
}

/**
 * registry 驱动的统一渲染入口（email delivery handler 执行边界使用）：
 * strict parse payload → definition.renderEmail（未注册 EMAIL 渲染器 =
 * 结构性损坏 → PERMANENT）。
 */
export function renderNotificationEmail(
  notification: { kind: string; schemaVersion: number; payload: unknown },
  recipientUserId: string,
  appBaseUrl: string,
): EmailRenderedContent {
  const definition = resolveNotificationDefinition(notification.kind, notification.schemaVersion);
  if (!definition || !definition.renderEmail) {
    throw new EmailProviderConfigError(
      "EMAIL_TEMPLATE_UNREGISTERED",
      `notification kind 未注册 EMAIL 渲染器：${notification.kind}@${notification.schemaVersion}`,
    );
  }

  if (notification.kind === PRODUCT_RESERVATION_EXPIRED_KIND) {
    const payload = parseNotificationPayload(notification, definition.payloadSchema);
    return renderReservationExpiredEmail(
      payload as ReservationExpiredEmailPayload,
      recipientUserId,
      appBaseUrl,
    );
  }

  // 未来 email-capable kind 在 registry definition 上声明 renderEmail；
  // 本文件保持模板集中，防止 handler 侧出现第二套渲染路径。
  throw new EmailProviderConfigError(
    "EMAIL_TEMPLATE_UNREGISTERED",
    `notification kind 缺少模板渲染分支：${notification.kind}`,
  );
}

/** handler 便捷入口：origin 解析 + 渲染一步完成（env 显式传入便于测试）。 */
export function renderNotificationEmailFromEnv(
  notification: { kind: string; schemaVersion: number; payload: unknown },
  recipientUserId: string,
  env: Record<string, string | undefined> = process.env,
): EmailRenderedContent {
  return renderNotificationEmail(notification, recipientUserId, resolveEmailAppBaseUrl(env));
}
