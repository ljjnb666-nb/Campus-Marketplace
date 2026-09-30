import type { DisputeResolutionAction, DisputeResolutionCode, RentalDisputeStatus } from "@prisma/client";

/**
 * Phase 7G：纠纷运营面 UI 标签映射（queue/detail 唯一消费点）。
 * 标签为中性运营文案——resolution code 刻意不携带责任认定语义
 * （dispute resolution ≠ enforcement truth）。
 */

export const DISPUTE_STATUS_LABELS: Record<RentalDisputeStatus, string> = {
  OPEN: "待处理",
  IN_REVIEW: "审核中",
  RESOLVED: "已解决",
  CLOSED: "已关闭",
};

export const DISPUTE_RESOLUTION_CODE_LABELS: Record<DisputeResolutionCode, string> = {
  MUTUAL_AGREEMENT: "双方协商一致",
  OPERATIONAL_REMEDIATION: "运营补救处理",
  EVIDENCE_INSUFFICIENT: "证据不足",
  DUPLICATE: "重复提交",
  INVALID: "无效纠纷",
  OTHER: "其他",
};

export const DISPUTE_RESOLUTION_ACTION_LABELS: Record<DisputeResolutionAction, string> = {
  RESTORE_PREVIOUS: "恢复纠纷前订单状态",
  CLOSE_ORDER: "关闭订单",
};

/**
 * Phase 8C-02：统一交易纠纷运营面的 kind 标签。
 * 队列"纠纷类型"过滤用 DISPUTE_KIND_FILTER_LABELS；详情顶部"纠纷类型"
 * 徽标用 DISPUTE_KIND_DETAIL_LABELS（显式 discriminator，不要通过标题猜）。
 */
export const GOVERNANCE_DISPUTE_KINDS = ["RENTAL", "ORDER"] as const;

export type GovernanceDisputeKindValue = (typeof GOVERNANCE_DISPUTE_KINDS)[number];

export const DISPUTE_KIND_FILTER_LABELS: Record<GovernanceDisputeKindValue, string> = {
  RENTAL: "租赁纠纷",
  ORDER: "普通订单纠纷",
};

export const DISPUTE_KIND_DETAIL_LABELS: Record<GovernanceDisputeKindValue, string> = {
  RENTAL: "租赁订单",
  ORDER: "普通订单",
};
