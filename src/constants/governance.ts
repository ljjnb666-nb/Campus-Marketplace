import type { AppealDecisionReasonCode, AppealStatus, EnforcementActionType, EnforcementReasonCode } from "@prisma/client";

/**
 * Phase 7A 治理面展示文案（operator 面专用；均为机器码 → 中文标签，
 * 不含任何机密数据）。仅覆盖申诉审核工作流需要的码值。
 */

export const APPEAL_STATUS_LABELS: Record<AppealStatus, string> = {
  SUBMITTED: "待审核",
  IN_REVIEW: "审核中",
  GRANTED: "已通过",
  UPHELD: "已维持",
  DISMISSED: "已驳回",
  WITHDRAWN: "已撤回",
};

export const ENFORCEMENT_TYPE_LABELS: Record<EnforcementActionType, string> = {
  ACCOUNT_SUSPEND: "账号停用",
  ACCOUNT_REINSTATE: "账号恢复",
  MEMBERSHIP_SUSPEND: "成员身份停用",
  MEMBERSHIP_REINSTATE: "成员身份恢复",
  MARKETPLACE_RESTRICT: "集市限制",
  MARKETPLACE_RESTORE: "集市限制解除",
};

export const ENFORCEMENT_REASON_LABELS: Record<EnforcementReasonCode, string> = {
  FRAUD_CONFIRMED: "欺诈行为确认",
  HARASSMENT_CONFIRMED: "骚扰行为确认",
  ACCOUNT_SECURITY: "账号安全风险",
  POLICY_VIOLATION: "违反平台规则",
  MANUAL_REVIEW: "人工审核处置",
  FALSE_POSITIVE_CORRECTION: "误判纠正",
  OTHER: "其他",
  APPEAL_GRANTED: "申诉通过恢复",
};

export const DECISION_REASON_LABELS: Record<AppealDecisionReasonCode, string> = {
  STALE_ENFORCEMENT: "处罚已过期失效",
  ENFORCEMENT_ALREADY_REVERSED: "处罚已被解除",
  LEGACY_PROVENANCE_INSUFFICIENT: "历史记录溯源不足",
  APPELLANT_ERASED: "申诉人账号已注销",
  MERIT_APPEAL_JUSTIFIED: "申诉理由成立",
  MERIT_VIOLATION_CONFIRMED: "原处罚维持有效",
};
