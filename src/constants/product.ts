export const PRODUCT_CONDITION_OPTIONS = [
  { value: "NEW", label: "全新" },
  { value: "LIKE_NEW", label: "几乎全新" },
  { value: "LIGHTLY_USED", label: "轻微使用" },
  { value: "NORMAL_USED", label: "正常使用" },
  { value: "HEAVILY_USED", label: "明显使用痕迹" },
] as const;

export const PRODUCT_STATUS_LABELS = {
  ACTIVE: "在售",
  RESERVED: "已预订",
  SOLD: "已售出",
  OFFLINE: "已下架",
  PAUSED: "暂停中",
} as const;

export const PRODUCT_CONDITION_LABELS: Record<string, string> = {
  NEW: "全新",
  LIKE_NEW: "几乎全新",
  LIGHTLY_USED: "轻微使用",
  NORMAL_USED: "正常使用",
  HEAVILY_USED: "明显使用痕迹",
};

export const PRODUCT_IMAGE_LIMIT = 9;
