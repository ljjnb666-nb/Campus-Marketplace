/**
 * Phase 6A RBAC / 身份域的稳定错误码。
 *
 * 约定与 Phase 5 governance/domain-errors.ts 一致：
 * - code 为机器可读稳定标识（测试断言使用，不得随意改名）
 * - userMessage 可直接展示，禁止包含权限内部结构 / role id / campus id 等细节
 * - status 与 error-taxonomy 的 HTTP 映射一致（4xx 不触发 server-fault 告警）
 */

export const RBAC_ERROR_CODES = [
  "AUTH_PERMISSION_DENIED",
  "AUTH_CAMPUS_SCOPE_MISMATCH",
  "AUTH_ACCOUNT_INACTIVE",
  "MEMBERSHIP_NOT_ACTIVE",
  "VERIFICATION_NOT_FOUND",
  "VERIFICATION_INVALID_TRANSITION",
  "VERIFICATION_SELF_REVIEW_DENIED",
  "ROLE_NOT_FOUND",
  "ROLE_ASSIGNMENT_INVALID_SCOPE",
  "ROLE_ASSIGNMENT_SELF_DENIED",
  "ROLE_ASSIGNMENT_CAMPUS_MISMATCH",
  "ROLE_ASSIGNMENT_TARGET_MEMBERSHIP_INACTIVE",
] as const;

export type RbacErrorCode = (typeof RBAC_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<RbacErrorCode, number> = {
  AUTH_PERMISSION_DENIED: 403,
  AUTH_CAMPUS_SCOPE_MISMATCH: 403,
  AUTH_ACCOUNT_INACTIVE: 403,
  MEMBERSHIP_NOT_ACTIVE: 403,
  VERIFICATION_NOT_FOUND: 404,
  VERIFICATION_INVALID_TRANSITION: 409,
  VERIFICATION_SELF_REVIEW_DENIED: 403,
  ROLE_NOT_FOUND: 404,
  ROLE_ASSIGNMENT_INVALID_SCOPE: 409,
  ROLE_ASSIGNMENT_SELF_DENIED: 403,
  ROLE_ASSIGNMENT_CAMPUS_MISMATCH: 403,
  ROLE_ASSIGNMENT_TARGET_MEMBERSHIP_INACTIVE: 409,
};

export class RbacError extends Error {
  readonly code: RbacErrorCode;
  readonly status: number;

  constructor(code: RbacErrorCode, userMessage: string) {
    super(userMessage);
    this.name = "RbacError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function isRbacError(error: unknown): error is RbacError {
  return error instanceof RbacError;
}

/** 便捷构造器：文案集中管理，调用处只引用错误码。 */
export function rbacError(
  code: RbacErrorCode,
  overrides?: string | { userMessage?: string },
): RbacError {
  const defaults: Record<RbacErrorCode, string> = {
    AUTH_PERMISSION_DENIED: "无权执行该操作",
    // campus 不匹配对用户呈现与普通拒绝一致，不暴露跨校区结构信息
    AUTH_CAMPUS_SCOPE_MISMATCH: "无权执行该操作",
    AUTH_ACCOUNT_INACTIVE: "账号当前不可用",
    MEMBERSHIP_NOT_ACTIVE: "当前没有生效的校园成员身份",
    VERIFICATION_NOT_FOUND: "认证记录不存在",
    VERIFICATION_INVALID_TRANSITION: "认证当前状态不允许此操作",
    VERIFICATION_SELF_REVIEW_DENIED: "不能审核自己提交的认证申请",
    ROLE_NOT_FOUND: "角色不存在",
    ROLE_ASSIGNMENT_INVALID_SCOPE: "角色授予参数无效",
    ROLE_ASSIGNMENT_SELF_DENIED: "不能变更自己的角色",
    ROLE_ASSIGNMENT_CAMPUS_MISMATCH: "无权在该校区执行角色授予",
    ROLE_ASSIGNMENT_TARGET_MEMBERSHIP_INACTIVE: "目标用户当前不是该校区生效成员，无法授予校区角色",
  };

  const userMessage =
    typeof overrides === "string" ? overrides : (overrides?.userMessage ?? defaults[code]);

  return new RbacError(code, userMessage);
}
