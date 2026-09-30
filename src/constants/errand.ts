export const ERRAND_STATUS_LABELS = {
  OPEN: "待接单",
  CLAIMED: "已接单",
  IN_PROGRESS: "进行中",
  PENDING_CONFIRMATION: "待确认",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  DISPUTED: "申诉中",
  // Phase 8C-01：纠纷治理终局关闭（Order.CLOSED canonical pair）
  CLOSED: "已关闭",
} as const;
