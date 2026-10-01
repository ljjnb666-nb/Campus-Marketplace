/**
 * Marketplace 业务时区 authority（Phase 8D-02 RB01）。
 *
 * 产品是 campus-local（中国校园）业务：用户在表单里选择的"约定时间"是
 * canonical campus wall-clock，必须确定性地映射为唯一绝对 instant。
 *
 * 禁止依赖（冻结）：
 *   process.env.TZ / OS timezone / Docker timezone / GitHub runner
 *   timezone / browser machine timezone——任何一处漂移都不得改变业务含义。
 *
 * 三个职责（meetup 用户面已接入；新功能禁止在组件内散落 timezone 字符串
 * 或裸 new Date("YYYY-MM-DDTHH:mm") parse）：
 *   - parseMarketplaceDateTimeLocal：严格 datetime-local 文本 → canonical
 *     wall-clock → 绝对 Date（无效输入返回 null，由调用方 DENY）
 *   - formatMarketplaceDateTime：绝对 Date → campus-local 展示文本
 *   - formatMarketplaceDateTimeLocalInput：绝对 Date → datetime-local
 *     input 用的 "YYYY-MM-DDTHH:mm"（server 生成 min/defaultValue，
 *     避免 client 端 Date.getTimezoneOffset 二次隐式转换）
 */

export const MARKETPLACE_TIME_ZONE = "Asia/Shanghai";

/** 严格 datetime-local（秒可选）："YYYY-MM-DDTHH:mm[:ss]"，无时区/偏移后缀 */
const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** 中国不实行夏令时，但 offset 仍经 Intl 动态求解（不散落 "+08:00" 字面量） */
const FALLBACK_OFFSET_MS = 8 * 60 * 60 * 1000;

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function canonicalFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: MARKETPLACE_TIME_ZONE,
    hourCycle: "h23",
    ...options,
  });
}

function readWallClock(date: Date): WallClock {
  const parts = canonicalFormatter({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

/** canonical timezone 相对 UTC 的偏移（毫秒；在该 instant 处求解） */
function offsetMsAt(instant: Date): number {
  const wall = readWallClock(instant);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return wallAsUtc - instant.getTime();
}

/**
 * parseMarketplaceDateTimeLocal：canonical wall-clock 文本 → 绝对 Date。
 *
 * - 格式不匹配 / 字段越界 / 不存在的日历日（如 2 月 30 日）→ null；
 * - 带 offset 后缀（"2026-10-05T14:30+08:00"）不是 datetime-local → null；
 * - offset 经 Intl 按 canonical timezone 求解（±1h 两轮收敛，兼容潜在
 *   DST 时区迁移），不做任何本地时区查询。
 */
export function parseMarketplaceDateTimeLocal(value: string): Date | null {
  const match = DATETIME_LOCAL_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const wall: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  };
  if (wall.month < 1 || wall.month > 12) return null;
  if (wall.day < 1 || wall.day > 31) return null;
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) return null;

  // 先按 canonical timezone 的名义偏移猜 instant，再用真实 offset 收敛
  //（±1h 两轮足够覆盖任意固定/DST 偏移；全程不查询本地时区）
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let instant = wallAsUtc - FALLBACK_OFFSET_MS;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const candidate = wallAsUtc - offsetMsAt(new Date(instant));
    if (candidate === instant) break;
    instant = candidate;
  }

  // roundtrip 验证：不存在日历日（2026-02-30）经格式化会漂移 → 拒绝
  const parsed = new Date(instant);
  const roundtrip = readWallClock(parsed);
  const second = wall.second;
  if (
    roundtrip.year !== wall.year ||
    roundtrip.month !== wall.month ||
    roundtrip.day !== wall.day ||
    roundtrip.hour !== wall.hour ||
    roundtrip.minute !== wall.minute ||
    roundtrip.second !== second
  ) {
    return null;
  }
  return parsed;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** 绝对 Date → datetime-local input 文本（canonical campus wall-clock） */
export function formatMarketplaceDateTimeLocalInput(date: Date): string {
  const wall = readWallClock(date);
  return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}T${pad2(wall.hour)}:${pad2(wall.minute)}`;
}

/** 绝对 Date → campus-local 用户展示文本（zh-CN 数字格式，显式 canonical timezone） */
export function formatMarketplaceDateTime(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: MARKETPLACE_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
