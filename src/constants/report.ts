export const REPORT_REASON_LABELS = {
  FAKE_INFO: "虚假信息",
  SCAM_RISK: "诈骗风险",
  BANNED_ITEM: "违禁内容",
  ACADEMIC_CHEATING: "学术作弊",
  HARASSMENT: "骚扰辱骂",
  ADVERTISEMENT: "垃圾广告",
  PRICE_FRAUD: "价格欺诈",
  OTHER: "其他问题",
} as const;

export const REPORT_STATUS_LABELS = {
  OPEN: "待处理",
  IN_REVIEW: "处理中",
  RESOLVED: "已处理",
  REJECTED: "已驳回",
} as const;
