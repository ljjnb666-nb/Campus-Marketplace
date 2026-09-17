/**
 * Phase 7E 举报运营域（Report / ModerationCase）的稳定错误码。
 *
 * 约定与 enforcement / rbac / 7C moderation 错误族一致：
 * - code 为机器可读稳定标识（测试断言使用，不得随意改名）
 * - userMessage 可直接展示，禁止包含授权结构 / 存在性 oracle
 * - status 与 error-taxonomy 的 HTTP 映射一致（4xx 不触发 server-fault 告警）
 */

export const REPORT_CASE_ERROR_CODES = [
  "REPORT_CASE_NOT_FOUND",
  "REPORT_CASE_FORBIDDEN",
  "REPORT_CASE_ALREADY_CLAIMED",
  "REPORT_CASE_CLOSED",
] as const;

export type ReportCaseErrorCode = (typeof REPORT_CASE_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ReportCaseErrorCode, number> = {
  REPORT_CASE_NOT_FOUND: 404,
  // 越权与不存在同款安全文案（action 层统一 deny，防枚举）
  REPORT_CASE_FORBIDDEN: 403,
  REPORT_CASE_ALREADY_CLAIMED: 409,
  REPORT_CASE_CLOSED: 409,
};

const DEFAULT_MESSAGES: Record<ReportCaseErrorCode, string> = {
  REPORT_CASE_NOT_FOUND: "举报不存在",
  // 统一 deny 文案：不泄露"存在但越权"与"不存在"的差异（P05/P06 反 oracle）
  REPORT_CASE_FORBIDDEN: "没有权限处理该举报",
  REPORT_CASE_ALREADY_CLAIMED: "该举报已被其他审核员领用",
  REPORT_CASE_CLOSED: "该举报的运营 case 已关闭",
};

export class ReportCaseError extends Error {
  readonly code: ReportCaseErrorCode;
  readonly status: number;

  constructor(code: ReportCaseErrorCode, userMessage?: string) {
    super(userMessage ?? DEFAULT_MESSAGES[code]);
    this.name = "ReportCaseError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function isReportCaseError(error: unknown): error is ReportCaseError {
  return error instanceof ReportCaseError;
}

/** 便捷构造器：文案集中管理，调用处只引用错误码。 */
export function reportCaseError(
  code: ReportCaseErrorCode,
  overrides?: string | { userMessage?: string },
): ReportCaseError {
  if (typeof overrides === "string") {
    return new ReportCaseError(code, overrides);
  }
  return new ReportCaseError(code, overrides?.userMessage);
}
