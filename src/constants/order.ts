export const ORDER_STATUS_LABELS = {
  PENDING: "待确认",
  ACCEPTED: "已接单",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  REFUNDED: "已退款",
} as const;

export const ORDER_TYPE_LABELS = {
  PRODUCT: "商品订单",
  ERRAND: "跑腿订单",
  SERVICE: "服务订单",
} as const;

export const PAYMENT_STATUS_LABELS = {
  UNPAID: "未支付",
  OFFLINE_PENDING: "线下待支付",
  PAID: "已支付",
  REFUNDED: "已退款",
} as const;
