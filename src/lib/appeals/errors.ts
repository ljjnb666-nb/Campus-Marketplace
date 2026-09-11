/**
 * Phase 6C-1B 申诉域（Appeal）的稳定错误码。
 *
 * 约定与 enforcement / rbac 错误体系一致：
 * - code 为机器可读稳定标识（测试断言使用，不得随意改名）
 * - userMessage 可直接展示，不泄露内部风控结构/授权结构
 * - status 与 error-taxonomy 的 HTTP 映射一致（4xx 不触发 server-fault 告警）
 *
 * 仅"请求本身失败"才抛异常（事务正常 rollback）。四个程序性 dismissal
 * （STALE_ENFORCEMENT / ENFORCEMENT_ALREADY_REVERSED /
 * LEGACY_PROVENANCE_INSUFFICIENT / APPELLANT_ERASED）是成功提交的
 * workflow 结局，持久化 decisionReasonCode 后正常返回，绝不 throw。
 */

export const APPEAL_ERROR_CODES = [
  "APPEAL_NOT_FOUND",
  "APPEAL_NOT_OWNED",
  "APPEAL_NOT_ALLOWED",
  "APPEAL_ALREADY_EXISTS",
  "APPEAL_INVALID_TRANSITION",
  "APPEAL_SCOPE_MISMATCH",
  "APPEAL_REVIEW_FORBIDDEN",
  "APPEAL_REVIEWER_IS_APPELLANT",
] as const;

export type AppealErrorCode = (typeof APPEAL_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<AppealErrorCode, number> = {
  APPEAL_NOT_FOUND: 404,
  // 他人资源一律 404-style 隐藏（防枚举），不区分"不存在"与"不属于你"
  APPEAL_NOT_OWNED: 404,
  APPEAL_NOT_ALLOWED: 409,
  APPEAL_ALREADY_EXISTS: 409,
  APPEAL_INVALID_TRANSITION: 409,
  APPEAL_SCOPE_MISMATCH: 403,
  APPEAL_REVIEW_FORBIDDEN: 403,
  APPEAL_REVIEWER_IS_APPELLANT: 403,
};

export class AppealError extends Error {
  readonly code: AppealErrorCode;
  readonly status: number;

  constructor(code: AppealErrorCode, userMessage: string) {
    super(userMessage);
    this.name = "AppealError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function isAppealError(error: unknown): error is AppealError {
  return error instanceof AppealError;
}

/** 便捷构造器：文案集中管理，调用处只引用错误码。 */
export function appealError(
  code: AppealErrorCode,
  overrides?: string | { userMessage?: string },
): AppealError {
  const defaults: Record<AppealErrorCode, string> = {
    APPEAL_NOT_FOUND: "申诉不存在",
    // 与 NOT_FOUND 同款文案：不向调用方泄露资源存在性差异（防枚举）
    APPEAL_NOT_OWNED: "申诉不存在",
    APPEAL_NOT_ALLOWED: "该执法记录不可申诉或当前状态不允许",
    APPEAL_ALREADY_EXISTS: "该执法记录已提交过申诉，不能重复提交",
    APPEAL_INVALID_TRANSITION: "当前状态不允许该操作",
    APPEAL_SCOPE_MISMATCH: "没有权限审核该申诉",
    APPEAL_REVIEW_FORBIDDEN: "没有权限审核申诉",
    APPEAL_REVIEWER_IS_APPELLANT: "不能审核自己的申诉",
  };

  const userMessage =
    typeof overrides === "string" ? (overrides as string) : (overrides?.userMessage ?? defaults[code]);

  return new AppealError(code, userMessage);
}
