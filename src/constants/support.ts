import type { SupportResolutionCode, SupportTicketCategory, SupportTicketStatus } from "@prisma/client";

/**
 * Phase 7G：支持工单运营面 UI 标签映射（queue/detail 唯一消费点）。
 */

export const SUPPORT_TICKET_STATUS_LABELS: Record<SupportTicketStatus, string> = {
  OPEN: "待处理",
  IN_PROGRESS: "处理中",
  RESOLVED: "已解决",
  CLOSED: "已关闭",
};

export const SUPPORT_TICKET_CATEGORY_LABELS: Record<SupportTicketCategory, string> = {
  ACCOUNT: "账号问题",
  VERIFICATION: "校园认证",
  MARKETPLACE: "交易问题",
  SAFETY: "安全问题",
  OTHER: "其他",
};

export const SUPPORT_RESOLUTION_CODE_LABELS: Record<SupportResolutionCode, string> = {
  ANSWERED: "已答复",
  USER_GUIDED: "已指引处理",
  DUPLICATE: "重复提交",
  INVALID: "无效工单",
  OUT_OF_SCOPE: "超出范围",
  OTHER: "其他",
};
