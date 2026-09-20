/**
 * Phase 7G 租赁纠纷域（RentalDispute 运营）的稳定错误码。
 *
 * 约定与 7E report / 6C enforcement 错误族一致：
 * - code 为机器可读稳定标识（测试断言使用，不得随意改名）
 * - userMessage 可直接展示，禁止包含授权结构 / 存在性 oracle
 * - status 与 error-taxonomy 的 HTTP 映射一致（4xx 不触发 server-fault 告警）
 */

export const DISPUTE_ERROR_CODES = [
  "DISPUTE_NOT_FOUND",
  "DISPUTE_FORBIDDEN",
  "DISPUTE_ALREADY_CLAIMED",
  "DISPUTE_RELEASE_FORBIDDEN",
  "DISPUTE_TERMINAL",
  "DISPUTE_INVALID_TRANSITION",
  "DISPUTE_RESTORE_UNAVAILABLE",
] as const;

export type DisputeErrorCode = (typeof DISPUTE_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<DisputeErrorCode, number> = {
  DISPUTE_NOT_FOUND: 404,
  // 越权与不存在同款安全文案（action 层统一 deny，防枚举）
  DISPUTE_FORBIDDEN: 403,
  DISPUTE_ALREADY_CLAIMED: 409,
  DISPUTE_RELEASE_FORBIDDEN: 403,
  DISPUTE_TERMINAL: 409,
  DISPUTE_INVALID_TRANSITION: 409,
  // openedFromOrderStatus 缺失时 RESTORE_PREVIOUS 被拒（绝不猜历史状态）
  DISPUTE_RESTORE_UNAVAILABLE: 409,
};

const DEFAULT_MESSAGES: Record<DisputeErrorCode, string> = {
  DISPUTE_NOT_FOUND: "纠纷不存在",
  // 统一 deny 文案：不泄露"存在但越权"与"不存在"的差异（反 oracle）
  DISPUTE_FORBIDDEN: "没有权限处理该纠纷",
  DISPUTE_ALREADY_CLAIMED: "该纠纷已被其他审核员领用",
  DISPUTE_RELEASE_FORBIDDEN: "只能释放自己领用的纠纷",
  DISPUTE_TERMINAL: "该纠纷已终局，不允许再次处理",
  DISPUTE_INVALID_TRANSITION: "纠纷当前状态不允许此操作",
  DISPUTE_RESTORE_UNAVAILABLE: "无法确定订单纠纷前状态，不能执行恢复",
};

export class DisputeError extends Error {
  readonly code: DisputeErrorCode;
  readonly status: number;

  constructor(code: DisputeErrorCode, userMessage?: string) {
    super(userMessage ?? DEFAULT_MESSAGES[code]);
    this.name = "DisputeError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function isDisputeError(error: unknown): error is DisputeError {
  return error instanceof DisputeError;
}

/** 便捷构造器：文案集中管理，调用处只引用错误码。 */
export function disputeError(
  code: DisputeErrorCode,
  overrides?: string | { userMessage?: string },
): DisputeError {
  if (typeof overrides === "string") {
    return new DisputeError(code, overrides);
  }
  return new DisputeError(code, overrides?.userMessage);
}
