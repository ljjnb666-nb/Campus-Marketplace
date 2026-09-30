/**
 * Phase 8D-01：General Order meetup 时间 / 地点策略的单一权威。
 *
 * 冻结：全部 meetup 时间谓词只允许经本模块计算，禁止任何 service / action
 * 就地重算（Phase 10 Config Center 之前 MEETUP_NO_SHOW_GRACE_MS 固定值）。
 *
 * 时间边界语义（毫秒精度，精确等号归属冻结）：
 *   proposal / confirm：scheduledAt >  now（严格未来；过去或 exact now DENY）
 *   arrival：            now >= scheduledAt（exact now 允许；不接受提前
 *                        self-check-in——提前到场只能做 UI 提示）
 *   cancel：             now <  scheduledAt（约定时间到了之后禁止用 CANCEL
 *                        绕过 no-show / dispute 路径）
 *   no-show：            now >= scheduledAt + grace（exact 等号属于
 *                        NO_SHOW_ELIGIBLE；grace 内不可报告）
 */

/** No-show 宽限期：约定时间后 15 分钟才可报告爽约（Phase 10 前冻结） */
export const MEETUP_NO_SHOW_GRACE_MS = 15 * 60 * 1000;

/** custom location 与既有 meetingLocation UX 同级（trim 后 2..80） */
export const MEETUP_LOCATION_MIN_LENGTH = 2;
export const MEETUP_LOCATION_MAX_LENGTH = 80;

/** active meetup 集合（与 DB partial unique OrderMeetup_order_active_key 严格一致） */
export const ACTIVE_MEETUP_STATUSES = [
  "PROPOSED",
  "CONFIRMED",
  "COMPLETED",
  "NO_SHOW_REPORTED",
] as const;

export function isMeetupProposalTimeValid(scheduledAt: Date, now: Date): boolean {
  return scheduledAt.getTime() > now.getTime();
}

export function isMeetupConfirmTimeValid(scheduledAt: Date, now: Date): boolean {
  return scheduledAt.getTime() > now.getTime();
}

export function isMeetupArrivalWindowOpen(scheduledAt: Date, now: Date): boolean {
  return now.getTime() >= scheduledAt.getTime();
}

export function isMeetupCancelWindowOpen(scheduledAt: Date, now: Date): boolean {
  return now.getTime() < scheduledAt.getTime();
}

export function isMeetupNoShowWindowOpen(scheduledAt: Date, now: Date): boolean {
  return now.getTime() >= scheduledAt.getTime() + MEETUP_NO_SHOW_GRACE_MS;
}

export function isMeetupCustomLocationValid(locationText: string): boolean {
  const trimmed = locationText.trim();
  return (
    trimmed.length >= MEETUP_LOCATION_MIN_LENGTH &&
    trimmed.length <= MEETUP_LOCATION_MAX_LENGTH
  );
}
