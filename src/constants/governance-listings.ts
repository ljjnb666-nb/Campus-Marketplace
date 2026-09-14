/**
 * Phase 7C listing 治理面 UI 元数据（只读展示用；authority 在 canonical
 * service / DB，本文件零逻辑）。
 */

export const LISTING_MODERATION_REASON_LABELS: Record<string, string> = {
  PROHIBITED_ITEM: "违禁物品",
  FRAUD_DECEPTION: "涉嫌欺诈",
  SPAM_ADVERTISEMENT: "垃圾广告",
  CONTENT_VIOLATION: "内容违规",
  OTHER: "其他",
};

export const LISTING_MODERATION_TARGET_LABELS: Record<string, string> = {
  PRODUCT: "二手商品",
  SERVICE: "技能服务",
  ERRAND: "跑腿任务",
  RENTAL: "闲置租赁",
};

export const LISTING_MODERATION_QUEUE_TITLE = "内容治理";
export const LISTING_MODERATION_QUEUE_SUBTITLE =
  "对校园市场四类内容执行治理处置与恢复（举报域只读，处置走 canonical 服务）";
