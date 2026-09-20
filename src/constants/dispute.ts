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
