/**
 * Phase 8D-01：General Order meetup / no-show 域的稳定错误码。
 *
 * 约定与 disputes/errors.ts 错误族一致：
 * - code 为机器可读稳定标识（测试断言使用，不得随意改名）
 * - userMessage 可直接展示，禁止包含授权结构 / 存在性 oracle / meetup
 *   provenance（地点 / 时间细节不进错误文案，防枚举）
 * - status 与 error-taxonomy 的 HTTP 映射一致（4xx 不触发 server-fault 告警）
 *
 * canonical Tx services（order-meetup-service.ts）以 { error: code } 返回域
 * DENY（与 initiateOrderDisputeTx 的 SAFE message 惯例同构）；本表同时提供
 * SAFE 文案映射，Phase 8D-02 action 层直接复用，禁止就地复制领域判断。
 */

export const MEETUP_ERROR_CODES = [
  "MEETUP_NOT_FOUND",
  "MEETUP_FORBIDDEN",
  "MEETUP_INVALID_TRANSITION",
  "MEETUP_ACTIVE_EXISTS",
  "MEETUP_TIME_WINDOW",
  "MEETUP_POINT_INVALID",
  "MEETUP_LOCATION_INVALID",
] as const;

export type MeetupErrorCode = (typeof MEETUP_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<MeetupErrorCode, number> = {
  MEETUP_NOT_FOUND: 404,
  // 越权与不存在同款安全基调：非参与方统一 deny，不泄露参与结构
  MEETUP_FORBIDDEN: 403,
  MEETUP_INVALID_TRANSITION: 409,
  MEETUP_ACTIVE_EXISTS: 409,
  MEETUP_TIME_WINDOW: 409,
  MEETUP_POINT_INVALID: 409,
  MEETUP_LOCATION_INVALID: 400,
};

const DEFAULT_MESSAGES: Record<MeetupErrorCode, string> = {
  MEETUP_NOT_FOUND: "见面约定不存在",
  // 统一 deny 文案：不泄露"存在但越权"与"不存在"的差异（反 oracle）
  MEETUP_FORBIDDEN: "没有权限操作该见面约定",
  MEETUP_INVALID_TRANSITION: "当前状态不允许此操作",
  MEETUP_ACTIVE_EXISTS: "该订单已有进行中的见面约定",
  MEETUP_TIME_WINDOW: "不在允许的时间窗口内",
  MEETUP_POINT_INVALID: "见面点不可用",
  MEETUP_LOCATION_INVALID: "见面地点无效",
};

export class MeetupError extends Error {
  readonly code: MeetupErrorCode;
  readonly status: number;

  constructor(code: MeetupErrorCode, userMessage?: string) {
    super(userMessage ?? DEFAULT_MESSAGES[code]);
    this.name = "MeetupError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function isMeetupError(error: unknown): error is MeetupError {
  return error instanceof MeetupError;
}

/** 便捷构造器：文案集中管理，调用处只引用错误码。 */
export function meetupError(
  code: MeetupErrorCode,
  overrides?: string | { userMessage?: string },
): MeetupError {
  if (typeof overrides === "string") {
    return new MeetupError(code, overrides);
  }
  return new MeetupError(code, overrides?.userMessage);
}
