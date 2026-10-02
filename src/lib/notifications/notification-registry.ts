import { z } from "zod";
import type { NotificationType } from "@prisma/client";

import { PermanentJobFailure } from "@/lib/async/job-types";
import { escapeHtml } from "@/lib/notifications/email-escape";

/**
 * Phase 9B：canonical notification definition registry（§5/§6/§7）。
 *
 * 本文件是纯 contract registry：kind / schemaVersion / zod strict payload
 * schema / 渠道策略 / IN_APP 与 EMAIL 渲染器的唯一事实源。
 *
 * - 禁止 import DB repository（§7）：registry 是纯函数层，渲染只依赖
 *   payload（IDs + 机器状态）与显式传入的上下文（如 appBaseUrl）。
 * - payload 契约沿用 Phase 9A RB04 原则：只允许 IDs + 机器状态；禁止
 *   Product.title / user message text / report detail / review content /
 *   notes / password / JWT / reset token / provider raw response。
 *   strict schema——未知键即 INVALID（绝不 parse-success + silently strip）。
 * - WRITE-TIME（emitNotificationTx）与 READ/RENDER-TIME（email delivery
 *   handler）双层 strict validation，同一 schema 单一事实源。
 * - NotificationType（SYSTEM/ORDER/...）只是 UI category（§5）；
 *   kind 才是具体事件身份。历史 Notification（9B 前）三列 NULL 保留，
 *   禁止按 title 猜测回填。
 */

/** 9B 起新 production 通知的统一 schemaVersion。 */
export const NOTIFICATION_SCHEMA_VERSION = 1;

/** 渠道策略（§8）：9B 实现 IN_APP / EMAIL；架构允许未来 WEB_PUSH / EXTERNAL。 */
export const NOTIFICATION_CHANNEL_IN_APP = "IN_APP";
export const NOTIFICATION_CHANNEL_EMAIL = "EMAIL";

export type InAppRenderedNotification = {
  type: NotificationType;
  title: string;
  content: string;
};

export type EmailRenderContext = {
  /** 邮件链接唯一 origin 来源（canonical NEXTAUTH_URL，§41；绝不来自 Host header）。 */
  appBaseUrl: string;
};

export type EmailRenderedContent = {
  subject: string;
  text: string;
  html: string;
};

/**
 * 注册后的 erased-typed definition（payload 参数经 never 双变收窄——
 * registry 内部只在 parse 之后以单一 cast 点调用渲染器）。
 */
export type RegisteredNotificationDefinition = {
  kind: string;
  schemaVersion: number;
  payloadSchema: z.ZodType;
  /** IN_APP 必在（站内通知是每个 kind 的基础投影）；EMAIL 按语义开启（§9）。 */
  channels: readonly string[];
  renderInApp: (payload: never, recipientUserId: string) => InAppRenderedNotification;
  /** email-capable kind 必须提供（§38）；template version 随 schemaVersion 冻结。 */
  renderEmail?: (
    payload: never,
    recipientUserId: string,
    context: EmailRenderContext,
  ) => EmailRenderedContent;
};

function defineNotification<P>(definition: {
  kind: string;
  schemaVersion: number;
  payloadSchema: z.ZodType<P>;
  channels: readonly string[];
  renderInApp: (payload: P, recipientUserId: string) => InAppRenderedNotification;
  renderEmail?: (
    payload: P,
    recipientUserId: string,
    context: EmailRenderContext,
  ) => EmailRenderedContent;
}): RegisteredNotificationDefinition {
  return definition;
}

// ============================================================
// payload 类型 + 机器状态 label 映射（纯函数，与既有业务文案逐字一致）
// ============================================================

export const PRODUCT_ORDER_CREATED_KIND = "PRODUCT_ORDER_CREATED";
export const SERVICE_ORDER_CREATED_KIND = "SERVICE_ORDER_CREATED";
export const ERRAND_ORDER_CLAIMED_KIND = "ERRAND_ORDER_CLAIMED";
export const ORDER_STATUS_CHANGED_KIND = "ORDER_STATUS_CHANGED";
export const ERRAND_TASK_STATUS_CHANGED_KIND = "ERRAND_TASK_STATUS_CHANGED";
export const ERRAND_ORDER_COMPLETED_KIND = "ERRAND_ORDER_COMPLETED";
export const ORDER_DISPUTE_OPENED_KIND = "ORDER_DISPUTE_OPENED";
export const ORDER_DISPUTE_RESOLVED_KIND = "ORDER_DISPUTE_RESOLVED";
export const RENTAL_DISPUTE_RESOLVED_KIND = "RENTAL_DISPUTE_RESOLVED";
export const ORDER_REVIEW_PUBLISHED_KIND = "ORDER_REVIEW_PUBLISHED";
export const RENTAL_REVIEW_PUBLISHED_KIND = "RENTAL_REVIEW_PUBLISHED";
export const RENTAL_ORDER_REQUESTED_KIND = "RENTAL_ORDER_REQUESTED";
export const RENTAL_ORDER_APPROVED_KIND = "RENTAL_ORDER_APPROVED";
export const RENTAL_ORDER_REJECTED_KIND = "RENTAL_ORDER_REJECTED";
export const RENTAL_PICKUP_CONFIRMED_KIND = "RENTAL_PICKUP_CONFIRMED";
export const RENTAL_RETURN_REQUESTED_KIND = "RENTAL_RETURN_REQUESTED";
export const RENTAL_RETURN_CONFIRMED_KIND = "RENTAL_RETURN_CONFIRMED";
export const RENTAL_ORDER_CANCELLED_KIND = "RENTAL_ORDER_CANCELLED";
export const RENTAL_EXTENSION_REQUESTED_KIND = "RENTAL_EXTENSION_REQUESTED";
export const RENTAL_EXTENSION_APPROVED_KIND = "RENTAL_EXTENSION_APPROVED";
export const RENTAL_EXTENSION_REJECTED_KIND = "RENTAL_EXTENSION_REJECTED";
export const RENTAL_DAMAGE_CLAIM_FILED_KIND = "RENTAL_DAMAGE_CLAIM_FILED";
export const RENTAL_DAMAGE_CLAIM_RESPONDED_KIND = "RENTAL_DAMAGE_CLAIM_RESPONDED";
export const RENTAL_DISPUTE_OPENED_KIND = "RENTAL_DISPUTE_OPENED";
export const REPORT_SUBMITTED_KIND = "REPORT_SUBMITTED";
export const REPORT_REVIEW_STATUS_CHANGED_KIND = "REPORT_REVIEW_STATUS_CHANGED";
export const APPEAL_SUBMITTED_KIND = "APPEAL_SUBMITTED";
export const APPEAL_DECIDED_KIND = "APPEAL_DECIDED";
export const VERIFICATION_SUBMITTED_KIND = "VERIFICATION_SUBMITTED";
export const VERIFICATION_DECIDED_KIND = "VERIFICATION_DECIDED";
export const ACCOUNT_SUSPENDED_KIND = "ACCOUNT_SUSPENDED";
export const ACCOUNT_REINSTATED_KIND = "ACCOUNT_REINSTATED";
export const SUPPORT_TICKET_RESOLVED_KIND = "SUPPORT_TICKET_RESOLVED";
export const ORDER_CONVERSATION_STARTED_KIND = "ORDER_CONVERSATION_STARTED";
export const PRODUCT_RESERVATION_EXPIRED_KIND = "PRODUCT_RESERVATION_EXPIRED";

const idField = () => z.string().min(1);

/** 与 src/lib/order-status-service.ts getStatusLabel 逐字一致（机器状态 → UI label）。 */
const ORDER_STATUS_LABELS: Record<string, string> = {
  ACCEPTED: "已接单",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

/** 与 src/lib/errand-lifecycle.ts getErrandStatusLabel 逐字一致。 */
const ERRAND_STATUS_LABELS: Record<string, string> = {
  OPEN: "待接单",
  CLAIMED: "已接单",
  IN_PROGRESS: "进行中",
  PENDING_CONFIRMATION: "待确认完成",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

function errandStatusLabel(status: string): string {
  return ERRAND_STATUS_LABELS[status] ?? status;
}

// ============================================================
// definitions
// ============================================================

const NOTIFICATIONS: RegisteredNotificationDefinition[] = [
  defineNotification({
    kind: PRODUCT_ORDER_CREATED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        buyerId: idField(),
        sellerId: idField(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload, recipientUserId) => ({
      type: "ORDER",
      title:
        recipientUserId === payload.buyerId ? "购买申请已提交" : "收到新的商品订单",
      content:
        recipientUserId === payload.buyerId
          ? "你的商品购买申请已提交，等待卖家确认。"
          : "有同学提交了你的商品购买申请，请尽快确认订单状态。",
    }),
  }),

  defineNotification({
    kind: SERVICE_ORDER_CREATED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        buyerId: idField(),
        sellerId: idField(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload, recipientUserId) => ({
      type: "ORDER",
      title: recipientUserId === payload.buyerId ? "服务预约已提交" : "收到新的服务预约",
      content:
        recipientUserId === payload.buyerId
          ? "你的服务预约已提交，等待服务提供者确认。"
          : "有同学预约了你的服务，请尽快确认并安排后续沟通。",
    }),
  }),

  defineNotification({
    kind: ERRAND_ORDER_CLAIMED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        publisherId: idField(),
        claimerId: idField(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload, recipientUserId) => ({
      type: "ORDER",
      title: recipientUserId === payload.publisherId ? "跑腿任务已被接单" : "你已接下跑腿任务",
      content:
        recipientUserId === payload.publisherId
          ? "你的跑腿任务已有同学接单，可以前往订单中心继续跟进。"
          : "接单成功，请尽快与发布者沟通并推进任务。",
    }),
  }),

  defineNotification({
    kind: ORDER_STATUS_CHANGED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        status: z.string().min(1),
        actorRole: z.enum(["BUYER", "SELLER"]),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => {
      const statusLabel = orderStatusLabel(payload.status);
      const actorLabel = payload.actorRole === "BUYER" ? "买家" : "卖家";
      return {
        type: "ORDER",
        title: `订单状态更新：${statusLabel}`,
        content: `${actorLabel}已将订单状态更新为“${statusLabel}”，请前往订单中心查看。`,
      };
    },
  }),

  defineNotification({
    kind: ERRAND_TASK_STATUS_CHANGED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        status: z.string().min(1),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => {
      const statusLabel = errandStatusLabel(payload.status);
      return {
        type: "ORDER",
        title: `跑腿任务状态更新：${statusLabel}`,
        content: `当前跑腿任务状态已更新为“${statusLabel}”，请前往订单中心查看。`,
      };
    },
  }),

  defineNotification({
    kind: ERRAND_ORDER_COMPLETED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ orderId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "ORDER",
      title: "跑腿订单已完成",
      content: "跑腿任务已确认完成，订单正式结算归档。",
    }),
  }),

  defineNotification({
    kind: ORDER_DISPUTE_OPENED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        disputeId: idField(),
        initiatorUserId: idField(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload, recipientUserId) =>
      recipientUserId === payload.initiatorUserId
        ? {
            type: "ORDER" as const,
            title: "订单纠纷已提交",
            content: "你的订单已进入纠纷处理流程。",
          }
        : {
            type: "ORDER" as const,
            title: "订单进入纠纷流程",
            content: "该订单已被交易对方发起纠纷，请留意平台处理进展。",
          },
  }),

  defineNotification({
    kind: ORDER_DISPUTE_RESOLVED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        disputeId: idField(),
        resolution: z.enum(["RESOLVED", "CLOSED"]),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => ({
      type: "ORDER",
      title: "订单纠纷已处理",
      content: `你的订单纠纷已${payload.resolution === "RESOLVED" ? "解决" : "关闭"}，订单状态已更新。`,
    }),
  }),

  defineNotification({
    kind: RENTAL_DISPUTE_RESOLVED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        disputeId: idField(),
        resolution: z.enum(["RESOLVED", "CLOSED"]),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => ({
      type: "RENTAL",
      title: "订单纠纷已处理",
      content: `你的订单纠纷已${payload.resolution === "RESOLVED" ? "解决" : "关闭"}，订单状态已更新。`,
    }),
  }),

  defineNotification({
    kind: ORDER_REVIEW_PUBLISHED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ orderId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "REVIEW",
      title: "交易评价已公开",
      content: "本次交易的双方评价已公开，可前往评价记录查看。",
    }),
  }),

  defineNotification({
    kind: RENTAL_REVIEW_PUBLISHED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ orderId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "RENTAL",
      title: "交易评价已公开",
      content: "本次租赁交易的双方评价已公开，可前往评价记录查看。",
    }),
  }),

  defineNotification({
    kind: RENTAL_ORDER_REQUESTED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ orderId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "RENTAL",
      title: "收到新的租赁申请",
      content: "你的出租物品收到新的租赁申请，请前往出租订单中心处理。",
    }),
  }),

  defineNotification({
    kind: RENTAL_ORDER_APPROVED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ orderId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "RENTAL",
      title: "租赁申请已通过",
      content: "你的租赁申请已被通过，请留意取货信息。",
    }),
  }),

  defineNotification({
    kind: RENTAL_ORDER_REJECTED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ orderId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "RENTAL",
      title: "租赁申请被拒绝",
      content: "你的租赁申请未通过，请前往订单详情查看。",
    }),
  }),

  defineNotification({
    kind: RENTAL_PICKUP_CONFIRMED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ orderId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "RENTAL",
      title: "取货已完成",
      content: "物品已开始租赁。",
    }),
  }),

  defineNotification({
    kind: RENTAL_RETURN_REQUESTED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ orderId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "RENTAL",
      title: "租客请求归还",
      content: "租客已请求归还物品，请确认。",
    }),
  }),

  defineNotification({
    kind: RENTAL_RETURN_CONFIRMED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        hasDamage: z.boolean(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => ({
      type: "RENTAL",
      title: "归还已确认",
      content: `出租者已确认物品归还。${payload.hasDamage ? "请注意检查损坏索赔。" : ""}`,
    }),
  }),

  defineNotification({
    kind: RENTAL_ORDER_CANCELLED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        // 机器可读取消类别枚举（DECLARED_NON_PERSONAL 同类；非自由文本）
        cancellationReason: z.string().min(1),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => ({
      type: "RENTAL",
      title: "订单已取消",
      content: `对方已取消订单。原因：${payload.cancellationReason}`,
    }),
  }),

  defineNotification({
    kind: RENTAL_EXTENSION_REQUESTED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        extensionRequestId: idField(),
        // ISO-8601 instant（机器状态）；渲染时格式化为既有 toLocaleDateString 展示
        newEndTime: z.iso.datetime(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => ({
      type: "RENTAL",
      title: "收到续租请求",
      content: `租客请求续租物品至 ${new Date(payload.newEndTime).toLocaleDateString()}。`,
    }),
  }),

  defineNotification({
    kind: RENTAL_EXTENSION_APPROVED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        extensionRequestId: idField(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "RENTAL",
      title: "续租请求已通过",
      content: "你的续租请求已通过。",
    }),
  }),

  defineNotification({
    kind: RENTAL_EXTENSION_REJECTED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        extensionRequestId: idField(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "RENTAL",
      title: "续租请求被拒绝",
      content: "你的续租请求被拒绝。",
    }),
  }),

  defineNotification({
    kind: RENTAL_DAMAGE_CLAIM_FILED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        claimId: idField(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "RENTAL",
      title: "收到损坏索赔",
      content: "出租者提交了损坏索赔请求，请尽快处理。",
    }),
  }),

  defineNotification({
    kind: RENTAL_DAMAGE_CLAIM_RESPONDED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        claimId: idField(),
        agreed: z.boolean(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => ({
      type: "RENTAL",
      title: payload.agreed ? "索赔已同意" : "索赔被拒绝",
      content: `租客${payload.agreed ? "同意" : "拒绝"}了损坏索赔。`,
    }),
  }),

  defineNotification({
    kind: RENTAL_DISPUTE_OPENED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        disputeId: idField(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "RENTAL",
      title: "发生订单纠纷",
      content: "对方对订单发起了纠纷。",
    }),
  }),

  defineNotification({
    kind: REPORT_SUBMITTED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ reportId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => ({
      type: "REPORT",
      title: "举报已提交",
      content: `你的举报已受理，编号 ${payload.reportId.slice(-8)}，平台会尽快核查并在处理后通知你。`,
    }),
  }),

  // COPY CHANGE（9B §6/§17）：handledNote（operator 自由文本）不再复制进
  // 通知 content——payload 无法携带自由文本，registry 只能生成固定文案；
  // 处理说明的唯一权威在 Report.handledNote 本体（由举报详情页按需展示）。
  defineNotification({
    kind: REPORT_REVIEW_STATUS_CHANGED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        reportId: idField(),
        status: z.enum(["IN_REVIEW", "RESOLVED", "REJECTED"]),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => {
      if (payload.status === "IN_REVIEW") {
        return {
          type: "REPORT" as const,
          title: "举报处理中",
          content: "你提交的举报正在处理中，平台会在核查完成后通知你结果。",
        };
      }
      if (payload.status === "RESOLVED") {
        return {
          type: "REPORT" as const,
          title: "举报已处理",
          content: "你提交的举报已处理完成。",
        };
      }
      return {
        type: "REPORT" as const,
        title: "举报处理结果已更新",
        content: "你提交的举报未通过。如有需要可补充更完整的信息后再次提交。",
      };
    },
  }),

  defineNotification({
    kind: APPEAL_SUBMITTED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ appealId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "SYSTEM",
      title: "已收到你的申诉",
      content: "你提交的申诉已进入平台审核流程，审核结果将通过站内消息通知你。",
    }),
  }),

  defineNotification({
    kind: APPEAL_DECIDED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        appealId: idField(),
        outcome: z.enum(["GRANTED", "UPHELD", "DISMISSED"]),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => {
      if (payload.outcome === "GRANTED") {
        return {
          type: "SYSTEM" as const,
          title: "你的申诉已通过",
          content: "你提交的申诉已审核通过，相关处罚已被解除。",
        };
      }
      if (payload.outcome === "UPHELD") {
        return {
          type: "SYSTEM" as const,
          title: "你的申诉已审核",
          content: "你提交的申诉已审核完毕，原处罚维持不变。",
        };
      }
      return {
        type: "SYSTEM" as const,
        title: "你的申诉已处理",
        content: "你提交的申诉已按平台流程处理完毕。",
      };
    },
  }),

  defineNotification({
    kind: VERIFICATION_SUBMITTED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ verificationId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "SYSTEM",
      title: "认证材料已提交",
      content: "你的校园认证材料已提交，平台会尽快完成审核，请留意后续通知。",
    }),
  }),

  defineNotification({
    kind: VERIFICATION_DECIDED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        verificationId: idField(),
        decision: z.enum(["VERIFIED", "REJECTED", "REVOKED"]),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => {
      if (payload.decision === "VERIFIED") {
        return {
          type: "SYSTEM" as const,
          title: "校园认证已通过",
          content: "你的校园认证已通过审核，平台会向其他同学展示你的认证状态。",
        };
      }
      if (payload.decision === "REJECTED") {
        return {
          type: "SYSTEM" as const,
          title: "校园认证未通过",
          content: "你的校园认证未通过审核，请前往认证页面查看详情并完善材料后重新提交。",
        };
      }
      return {
        type: "SYSTEM" as const,
        title: "校园认证已被吊销",
        content: "你的校园认证已被平台吊销，请前往认证页面查看详情。",
      };
    },
  }),

  defineNotification({
    kind: ACCOUNT_SUSPENDED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({}).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "SYSTEM",
      title: "账号已被停用",
      content: "你的账号当前已被管理员暂停使用，如有疑问请联系平台管理员。",
    }),
  }),

  defineNotification({
    kind: ACCOUNT_REINSTATED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({}).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "SYSTEM",
      title: "账号已恢复正常",
      content: "你的账号已恢复正常使用。",
    }),
  }),

  defineNotification({
    kind: SUPPORT_TICKET_RESOLVED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z.object({ ticketId: idField() }).strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: () => ({
      type: "SYSTEM",
      title: "支持工单已处理",
      content: "你的支持工单已处理完成，请进入工单详情查看处理结果。",
    }),
  }),

  // COPY CHANGE（9B §6/§17）：listing title（user-authored）不再复制进通知
  // content——payload 无法携带自由文本。orderNo / orderNumber 是机器生成的
  // 业务编号（机器状态），保留于 order 会话文案。会话标题（Conversation.title）
  // 行为完全不变。
  defineNotification({
    kind: ORDER_CONVERSATION_STARTED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        conversationId: idField(),
        bizType: z.enum(["PRODUCT", "ERRAND", "SERVICE", "RENTAL", "PRODUCT_ORDER", "RENTAL_ORDER"]),
        // order 会话的机器业务编号（订单：NO / 租赁订单：NO 文案组成部分）
        bizNumber: z.string().min(1).optional(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP],
    renderInApp: (payload) => {
      if (payload.bizType === "PRODUCT_ORDER") {
        return {
          type: "MESSAGE" as const,
          title: "收到订单交易联系",
          content: `关于“订单：${payload.bizNumber}”，交易对方向你发起了会话。`,
        };
      }
      if (payload.bizType === "RENTAL_ORDER") {
        return {
          type: "MESSAGE" as const,
          title: "收到订单交易联系",
          content: `关于“租赁订单：${payload.bizNumber}”，交易对方向你发起了会话。`,
        };
      }
      if (payload.bizType === "ERRAND") {
        return {
          type: "MESSAGE" as const,
          title: "收到跑腿任务沟通",
          content: "有同学向你发起了沟通。",
        };
      }
      if (payload.bizType === "RENTAL") {
        return {
          type: "MESSAGE" as const,
          title: "收到物品租赁咨询",
          content: "有同学向你发起了租赁咨询。",
        };
      }
      if (payload.bizType === "SERVICE") {
        return {
          type: "MESSAGE" as const,
          title: "收到新的服务预约咨询",
          content: "有同学向你发起了会话。",
        };
      }
      return {
        type: "MESSAGE" as const,
        title: "收到新的商品咨询",
        content: "有同学向你发起了会话，快去看看。",
      };
    },
  }),

  // 9B 唯一双渠道事件（§9）：PRODUCT 预留过期 = time-sensitive transactional
  // event。 buyer/seller ID 进 payload 供角色化渲染（IDs 属机器状态）。
  // EMAIL 模板（§38/§39）：template version 随本 definition 冻结；固定中文
  // 文案 + safe application URL（绝不携带 listing title / 留言 / note）；
  // 链接 origin 由 renderEmail context 显式传入（canonical NEXTAUTH_URL）。
  defineNotification({
    kind: PRODUCT_RESERVATION_EXPIRED_KIND,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    payloadSchema: z
      .object({
        orderId: idField(),
        buyerId: idField(),
        sellerId: idField(),
      })
      .strict(),
    channels: [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_EMAIL],
    renderInApp: (payload, recipientUserId) => ({
      type: "ORDER",
      title: "商品预留已过期",
      // 与 Phase 9A outbox-event-registry 冻结文案逐字一致（按收件人角色区分）
      content:
        recipientUserId === payload.buyerId
          ? "卖家未在确认期限内接受订单，商品预留已自动释放。"
          : "该商品订单已超过确认期限，预留已自动释放。",
    }),
    renderEmail: (payload, recipientUserId, context) => {
      const isBuyer = recipientUserId === payload.buyerId;
      const roleSentence = isBuyer
        ? "卖家未在确认期限内接受订单，商品预留已自动释放。"
        : "该商品订单已超过确认期限，预留已自动释放。";
      const subject = "商品预留已过期";
      const ordersUrl = `${context.appBaseUrl}/my/orders`;
      const footer = "本邮件为校园集市系统事务邮件，请勿直接回复。";

      const text = [
        "您有一条交易通知：商品预留已过期。",
        "",
        roleSentence,
        "",
        `请登录平台查看详情：${ordersUrl}`,
        "",
        footer,
      ].join("\n");

      const html = [
        "<!doctype html>",
        '<html lang="zh-CN">',
        "<body>",
        "  <p>您有一条交易通知：<strong>商品预留已过期</strong>。</p>",
        `  <p>${escapeHtml(roleSentence)}</p>`,
        `  <p><a href="${escapeHtml(ordersUrl)}">请登录平台查看详情</a></p>`,
        `  <p>${escapeHtml(footer)}</p>`,
        "</body>",
        "</html>",
      ].join("\n");

      return { subject, text, html };
    },
  }),
];

// ============================================================
// registry 解析 + 双层 strict validation 原语
// ============================================================

const NOTIFICATION_DEFINITIONS = new Map<string, Map<number, RegisteredNotificationDefinition>>(
  NOTIFICATIONS.map((definition) => [
    definition.kind,
    new Map([[definition.schemaVersion, definition]]),
  ]),
);

/** 解析失败返回 null —— 调用方必须 fail closed（禁止猜测渲染）。 */
export function resolveNotificationDefinition(
  kind: string,
  schemaVersion: number,
): RegisteredNotificationDefinition | null {
  return NOTIFICATION_DEFINITIONS.get(kind)?.get(schemaVersion) ?? null;
}

/** 测试/审计用：当前注册的全部 kind@version。 */
export function listRegisteredNotificationDefinitions(): RegisteredNotificationDefinition[] {
  return [...NOTIFICATIONS];
}

export type NotificationIntentValidation =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: "UNKNOWN_CONTRACT" | "INVALID_PAYLOAD" };

/**
 * WRITE-TIME strict validation（emitNotificationTx 写边界）：未知
 * kind/version 或 payload 形状非法（含未知键）一律拒绝。
 */
export function validateNotificationIntent(
  kind: string,
  schemaVersion: number,
  payload: unknown,
): NotificationIntentValidation {
  const definition = resolveNotificationDefinition(kind, schemaVersion);
  if (!definition) {
    return { ok: false, reason: "UNKNOWN_CONTRACT" };
  }
  const parsed = definition.payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: "INVALID_PAYLOAD" };
  }
  return { ok: true, payload: parsed.data as Record<string, unknown> };
}

/** definition 是否开通 EMAIL 渠道。 */
export function hasEmailChannel(definition: RegisteredNotificationDefinition): boolean {
  return definition.channels.includes(NOTIFICATION_CHANNEL_EMAIL);
}

/**
 * READ/RENDER-TIME strict validation（email delivery handler 执行边界）：
 * payload 形状非法 = 结构性损坏（PERMANENT，fail closed）。
 */
export function parseNotificationPayload<T>(
  input: { kind: string; payload: unknown },
  schema: z.ZodType<T>,
): T {
  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) {
    throw new PermanentJobFailure(
      "NOTIFICATION_PAYLOAD_INVALID",
      `${input.kind} payload 形状非法（notification 渲染边界拒绝）`,
    );
  }
  return parsed.data;
}

/**
 * RB04 写边界受控契约错误：emitNotificationTx 校验失败时抛出——业务事务
 * 回滚、零 Notification 行。code 属受控机器码格式（RB05 合同）。
 */
export class NotificationIntentContractError extends PermanentJobFailure {
  constructor(
    reason: "UNKNOWN_CONTRACT" | "INVALID_PAYLOAD" | "INVALID_DEDUPE_KEY",
    kind: string,
    schemaVersion: number,
  ) {
    super(
      reason === "UNKNOWN_CONTRACT"
        ? "NOTIFICATION_INTENT_CONTRACT_UNKNOWN"
        : reason === "INVALID_DEDUPE_KEY"
          ? "NOTIFICATION_INTENT_DEDUPE_KEY_INVALID"
          : "NOTIFICATION_INTENT_CONTRACT_INVALID",
      reason === "UNKNOWN_CONTRACT"
        ? `未注册的 notification kind/schemaVersion 拒绝写入：${kind}@${schemaVersion}`
        : reason === "INVALID_DEDUPE_KEY"
          ? `notification dedupeKey 缺失（kind=${kind} version=${schemaVersion}）`
          : `notification payload 未通过 strict 契约校验（kind=${kind} version=${schemaVersion}）`,
    );
    this.name = "NotificationIntentContractError";
  }
}

