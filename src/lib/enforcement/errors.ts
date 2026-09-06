/**
 * Phase 6B 执法域（Trust / Risk / Enforcement）的稳定错误码。
 *
 * 约定与 Phase 5/6A governance/rbac 错误体系一致：
 * - code 为机器可读稳定标识（测试断言使用，不得随意改名）
 * - userMessage 可直接展示，禁止泄露内部风控结构/内部原因细节
 * - status 与 error-taxonomy 的 HTTP 映射一致（4xx 不触发 server-fault 告警）
 */

export const ENFORCEMENT_ERROR_CODES = [
  "ENFORCEMENT_SELF_DENIED",
  "ENFORCEMENT_PRIVILEGED_TARGET",
  "ENFORCEMENT_INVALID_TRANSITION",
  "ENFORCEMENT_TARGET_NOT_FOUND",
  "MARKETPLACE_RESTRICTED",
] as const;

export type EnforcementErrorCode = (typeof ENFORCEMENT_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<EnforcementErrorCode, number> = {
  ENFORCEMENT_SELF_DENIED: 403,
  ENFORCEMENT_PRIVILEGED_TARGET: 403,
  ENFORCEMENT_INVALID_TRANSITION: 409,
  ENFORCEMENT_TARGET_NOT_FOUND: 404,
  MARKETPLACE_RESTRICTED: 403,
};

export class EnforcementError extends Error {
  readonly code: EnforcementErrorCode;
  readonly status: number;

  constructor(code: EnforcementErrorCode, userMessage: string) {
    super(userMessage);
    this.name = "EnforcementError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function isEnforcementError(error: unknown): error is EnforcementError {
  return error instanceof EnforcementError;
}

/** 便捷构造器：文案集中管理，调用处只引用错误码。 */
export function enforcementError(
  code: EnforcementErrorCode,
  overrides?: string | { userMessage?: string },
): EnforcementError {
  const defaults: Record<EnforcementErrorCode, string> = {
    ENFORCEMENT_SELF_DENIED: "不能对自己执行该操作",
    // 不向调用方泄露目标的权限结构
    ENFORCEMENT_PRIVILEGED_TARGET: "不能对该账号执行此管理操作",
    ENFORCEMENT_INVALID_TRANSITION: "当前状态不允许该操作",
    ENFORCEMENT_TARGET_NOT_FOUND: "目标不存在",
    // MARKETPLACE_RESTRICTED 对用户呈现为统一的能力限制提示：
    // 不区分 membership / risk 细节，不暴露风控内部状态
    MARKETPLACE_RESTRICTED: "当前无法开始新的交易活动，如有疑问请联系平台管理员",
  };

  const userMessage =
    typeof overrides === "string" ? overrides : (overrides?.userMessage ?? defaults[code]);

  return new EnforcementError(code, userMessage);
}
