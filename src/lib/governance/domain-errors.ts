/**
 * Phase 5 治理域（法务协议 / 隐私 / 数据治理）的稳定错误码。
 *
 * 约定：
 * - code 为机器可读稳定标识（API 响应 / 测试断言使用，不得随意改名）
 * - userMessage 为可直接展示给用户的中文提示，禁止包含内部细节
 * - status 与全局 error taxonomy 的 HTTP 映射一致（error-taxonomy.ts 按
 *   error.status 归类，4xx 不触发 server-fault 告警语义）
 */

export const GOVERNANCE_ERROR_CODES = [
  "LEGAL_ACCEPTANCE_REQUIRED",
  "LEGAL_DOCUMENT_NOT_FOUND",
  "LEGAL_DOCUMENT_VERSION_CHANGED",
  "LEGAL_DOCUMENT_NOT_CURRENT",
  "LEGAL_DOCUMENT_ALREADY_PUBLISHED",
  "PRIVACY_REQUEST_NOT_FOUND",
  "PRIVACY_REQUEST_INVALID_TRANSITION",
  "PRIVACY_REQUEST_ALREADY_ACTIVE",
  "DATA_EXPORT_FORBIDDEN",
  "DATA_EXPORT_TOO_LARGE",
  "ACCOUNT_DELETION_BLOCKED",
  "ACTIVE_DATA_HOLD",
  "ACTIVE_TRANSACTION_BLOCK",
  "ACCOUNT_ALREADY_DELETED",
  "GOVERNANCE_SUBJECT_INACTIVE",
  "CAMPUS_VERIFICATION_POLICY_NOT_FOUND",
  "CAMPUS_VERIFICATION_POLICY_ALREADY_PUBLISHED",
] as const;

export type GovernanceErrorCode = (typeof GOVERNANCE_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<GovernanceErrorCode, number> = {
  LEGAL_ACCEPTANCE_REQUIRED: 403,
  LEGAL_DOCUMENT_NOT_FOUND: 404,
  LEGAL_DOCUMENT_VERSION_CHANGED: 409,
  LEGAL_DOCUMENT_NOT_CURRENT: 409,
  LEGAL_DOCUMENT_ALREADY_PUBLISHED: 409,
  PRIVACY_REQUEST_NOT_FOUND: 404,
  PRIVACY_REQUEST_INVALID_TRANSITION: 409,
  PRIVACY_REQUEST_ALREADY_ACTIVE: 409,
  DATA_EXPORT_FORBIDDEN: 403,
  DATA_EXPORT_TOO_LARGE: 413,
  ACCOUNT_DELETION_BLOCKED: 409,
  ACTIVE_DATA_HOLD: 409,
  ACTIVE_TRANSACTION_BLOCK: 409,
  ACCOUNT_ALREADY_DELETED: 409,
  GOVERNANCE_SUBJECT_INACTIVE: 409,
  CAMPUS_VERIFICATION_POLICY_NOT_FOUND: 404,
  CAMPUS_VERIFICATION_POLICY_ALREADY_PUBLISHED: 409,
};

export class GovernanceError extends Error {
  readonly code: GovernanceErrorCode;
  readonly status: number;

  constructor(code: GovernanceErrorCode, userMessage: string) {
    super(userMessage);
    this.name = "GovernanceError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function isGovernanceError(error: unknown): error is GovernanceError {
  return error instanceof GovernanceError;
}

/** 便捷构造器：保证文案集中管理，调用处只引用错误码。 */
export function governanceError(
  code: GovernanceErrorCode,
  overrides?: string | { userMessage?: string },
): GovernanceError {
  const defaults: Record<GovernanceErrorCode, string> = {
    LEGAL_ACCEPTANCE_REQUIRED: "请先阅读并同意最新的平台协议",
    LEGAL_DOCUMENT_NOT_FOUND: "协议文档不存在或尚未发布",
    LEGAL_DOCUMENT_VERSION_CHANGED: "协议版本已更新，请重新查看并确认",
    LEGAL_DOCUMENT_NOT_CURRENT: "所提交的协议已不是当前生效版本",
    LEGAL_DOCUMENT_ALREADY_PUBLISHED: "该文档已发布，内容不可修改",
    PRIVACY_REQUEST_NOT_FOUND: "隐私请求不存在",
    PRIVACY_REQUEST_INVALID_TRANSITION: "隐私请求当前状态不允许此操作",
    PRIVACY_REQUEST_ALREADY_ACTIVE: "已有正在处理的同类请求，请勿重复提交",
    DATA_EXPORT_FORBIDDEN: "只能导出本人的数据",
    DATA_EXPORT_TOO_LARGE: "导出数据量过大，请稍后再试或联系支持",
    ACCOUNT_DELETION_BLOCKED: "账号注销被阻止：存在未完成的交易或治理冻结",
    ACTIVE_DATA_HOLD: "账号存在有效的法律/纠纷冻结，无法执行破坏性操作",
    ACTIVE_TRANSACTION_BLOCK: "账号存在进行中的交易，无法执行注销",
    ACCOUNT_ALREADY_DELETED: "该账号已注销",
    GOVERNANCE_SUBJECT_INACTIVE: "对方账号当前不可交易，请稍后再试",
    CAMPUS_VERIFICATION_POLICY_NOT_FOUND: "校园认证策略不存在或尚未发布",
    CAMPUS_VERIFICATION_POLICY_ALREADY_PUBLISHED: "该认证策略已发布，内容不可修改",
  };

  const userMessage =
    typeof overrides === "string" ? overrides : (overrides?.userMessage ?? defaults[code]);

  return new GovernanceError(code, userMessage);
}
