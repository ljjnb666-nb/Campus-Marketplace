/**
 * Phase 7C listing 治理域的稳定错误码。
 *
 * 约定与 Phase 5 governance / Phase 6A rbac / Phase 6C enforcement 错误族
 * 一致：
 * - code 为机器可读稳定标识（测试断言使用，不得随意改名）
 * - userMessage 可直接展示，禁止包含权限内部结构 / owner 账号状态细节
 *   （RESTORE_NOT_RESTORABLE 不得泄露"owner 已注销"——统一泛化文案）
 * - status 与 error-taxonomy 的 HTTP 映射一致（4xx 不触发 server-fault 告警）
 */

export const MODERATION_ERROR_CODES = [
  "MODERATION_TARGET_NOT_FOUND",
  "MODERATION_SELF_DENIED",
  "STALE_MODERATION_REVIEW",
  "RESTORE_NOT_RESTORABLE",
] as const;

export type ModerationErrorCode = (typeof MODERATION_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ModerationErrorCode, number> = {
  MODERATION_TARGET_NOT_FOUND: 404,
  MODERATION_SELF_DENIED: 403,
  STALE_MODERATION_REVIEW: 409,
  RESTORE_NOT_RESTORABLE: 409,
};

const DEFAULT_MESSAGES: Record<ModerationErrorCode, string> = {
  // 反 oracle：missing / deleted 与未授权统一走 action 层同款统一 deny
  // 文案（本码仅在服务端内部判别）。
  MODERATION_TARGET_NOT_FOUND: "治理目标不存在或已删除",
  MODERATION_SELF_DENIED: "不能对本人的内容执行治理处置",
  STALE_MODERATION_REVIEW: "处置状态已变化，请刷新治理详情后重试",
  // R2-04：不泄露 owner 注销/删除事实的统一安全文案
  RESTORE_NOT_RESTORABLE: "该处置当前不可恢复",
};

export class ModerationError extends Error {
  readonly code: ModerationErrorCode;
  readonly status: number;

  constructor(code: ModerationErrorCode, userMessage?: string) {
    super(userMessage ?? DEFAULT_MESSAGES[code]);
    this.name = "ModerationError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function isModerationError(error: unknown): error is ModerationError {
  return error instanceof ModerationError;
}

/** 便捷构造器：保证文案集中管理，调用处只引用错误码。 */
export function moderationError(
  code: ModerationErrorCode,
  overrides?: string | { userMessage?: string },
): ModerationError {
  if (typeof overrides === "string") {
    return new ModerationError(code, overrides);
  }
  return new ModerationError(code, overrides?.userMessage);
}
