/**
 * Phase 7G 支持工单域（SupportTicket 运营）的稳定错误码。
 *
 * 约定与 7E report / 7G dispute 错误族一致：
 * - code 为机器可读稳定标识（测试断言使用，不得随意改名）
 * - userMessage 可直接展示，禁止包含授权结构 / 存在性 oracle
 * - status 与 error-taxonomy 的 HTTP 映射一致（4xx 不触发 server-fault 告警）
 */

export const SUPPORT_TICKET_ERROR_CODES = [
  "SUPPORT_TICKET_NOT_FOUND",
  "SUPPORT_TICKET_FORBIDDEN",
  "SUPPORT_TICKET_ALREADY_CLAIMED",
  "SUPPORT_TICKET_RELEASE_FORBIDDEN",
  "SUPPORT_TICKET_TERMINAL",
  "SUPPORT_TICKET_INVALID_TRANSITION",
  "SUPPORT_TICKET_LIMIT_EXCEEDED",
  "SUPPORT_CAMPUS_MEMBERSHIP_INACTIVE",
] as const;

export type SupportTicketErrorCode = (typeof SUPPORT_TICKET_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<SupportTicketErrorCode, number> = {
  SUPPORT_TICKET_NOT_FOUND: 404,
  // 越权与不存在同款安全文案（action 层统一 deny，防枚举）
  SUPPORT_TICKET_FORBIDDEN: 403,
  SUPPORT_TICKET_ALREADY_CLAIMED: 409,
  SUPPORT_TICKET_RELEASE_FORBIDDEN: 403,
  SUPPORT_TICKET_TERMINAL: 409,
  SUPPORT_TICKET_INVALID_TRANSITION: 409,
  // MAX_ACTIVE_SUPPORT_TICKETS_PER_USER = 3（USER:requester 锁内强制）
  SUPPORT_TICKET_LIMIT_EXCEEDED: 429,
  // 创建时指定 campusId 但 requester 无该校区 ACTIVE membership
  SUPPORT_CAMPUS_MEMBERSHIP_INACTIVE: 403,
};

const DEFAULT_MESSAGES: Record<SupportTicketErrorCode, string> = {
  SUPPORT_TICKET_NOT_FOUND: "工单不存在",
  // 统一 deny 文案：不泄露"存在但越权"与"不存在"的差异（反 oracle）
  SUPPORT_TICKET_FORBIDDEN: "没有权限处理该工单",
  SUPPORT_TICKET_ALREADY_CLAIMED: "该工单已被其他专员领用",
  SUPPORT_TICKET_RELEASE_FORBIDDEN: "只能释放自己领用的工单",
  SUPPORT_TICKET_TERMINAL: "该工单已终局，不允许再次处理",
  SUPPORT_TICKET_INVALID_TRANSITION: "工单当前状态不允许此操作",
  SUPPORT_TICKET_LIMIT_EXCEEDED: "你有太多进行中的工单，请等待现有工单处理完成",
  SUPPORT_CAMPUS_MEMBERSHIP_INACTIVE: "你不是该校区的生效成员，无法提交校区工单",
};

export class SupportTicketError extends Error {
  readonly code: SupportTicketErrorCode;
  readonly status: number;

  constructor(code: SupportTicketErrorCode, userMessage?: string) {
    super(userMessage ?? DEFAULT_MESSAGES[code]);
    this.name = "SupportTicketError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function isSupportTicketError(error: unknown): error is SupportTicketError {
  return error instanceof SupportTicketError;
}

/** 便捷构造器：文案集中管理，调用处只引用错误码。 */
export function supportTicketError(
  code: SupportTicketErrorCode,
  overrides?: string | { userMessage?: string },
): SupportTicketError {
  if (typeof overrides === "string") {
    return new SupportTicketError(code, overrides);
  }
  return new SupportTicketError(code, overrides?.userMessage);
}
