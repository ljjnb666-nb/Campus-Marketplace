import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_TIME_ZONE,
  formatMarketplaceDateTime,
  formatMarketplaceDateTimeLocalInput,
  parseMarketplaceDateTimeLocal,
} from "@/lib/marketplace-time";

/**
 * RB01：marketplace 业务时区 authority 的确定性合同（TIME-01..03）。
 *
 * 全部断言都是绝对 instant / canonical campus wall-clock 的精确值——
 * 实现若退化为依赖 process TZ / OS timezone（本地开发机、CI runner、
 * Docker runtime 任意），这些测试即在对应环境失败。
 */
describe("marketplace-time：canonical campus 时区 authority", () => {
  it("TIME-01：datetime-local 文本按 Asia/Shanghai 解释为唯一绝对 instant", () => {
    expect(MARKETPLACE_TIME_ZONE).toBe("Asia/Shanghai");

    // 2026-10-05T14:30 campus wall-clock ≡ 2026-10-05T06:30:00.000Z（冻结）
    const parsed = parseMarketplaceDateTimeLocal("2026-10-05T14:30");
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe("2026-10-05T06:30:00.000Z");

    // 带秒的严格变体同样确定
    expect(parseMarketplaceDateTimeLocal("2026-10-05T14:30:15")!.toISOString()).toBe(
      "2026-10-05T06:30:15.000Z",
    );

    // UTC+8 与 UTC-8 的 wall-clock 语义分离：0:30 上海 = 前一日 16:30Z
    expect(parseMarketplaceDateTimeLocal("2026-10-06T00:30")!.toISOString()).toBe(
      "2026-10-05T16:30:00.000Z",
    );
  });

  it("TIME-02：无效 datetime-local 安全 DENY（null）——含 offset 伪装与不存在日历日", () => {
    const invalid = [
      "not-a-date",
      "2026-99-99T25:99",
      "2026-10-05T14:30+08:00", // offset-bearing 伪装 datetime-local
      "2026-10-05T14:30Z", // UTC 后缀伪装
      "2026-02-30T10:00", // 不存在的日历日（roundtrip 漂移拒绝）
      "2026-13-01T10:00", // month 越界
      "2026-10-05T24:00", // hour 越界
      "2026-10-05T10:60", // minute 越界
      "2026-10-05 14:30", // 非严格分隔符
      "10/5/2026 14:30", // 任意其他格式
      "",
      "   ",
    ];
    for (const value of invalid) {
      expect(parseMarketplaceDateTimeLocal(value), `"${value}" 应 DENY`).toBeNull();
    }
  });

  it("TIME-03：格式化恒为 canonical campus wall-clock，不随 process timezone 漂移", () => {
    // 2026-10-05T06:30:00.000Z = 上海 2026/10/5 14:30（zh-CN numeric + h23）
    const instant = new Date("2026-10-05T06:30:00.000Z");
    expect(formatMarketplaceDateTime(instant)).toBe("2026/10/5 14:30");

    // 跨日边界：UTC 17:00 = 上海次日 01:00（若实现误用 UTC/runner 本地时区
    // 会显示同日 17:00，该断言即失败——CI runner 为 UTC，天然区分）
    expect(formatMarketplaceDateTime(new Date("2026-10-05T17:00:00.000Z"))).toBe(
      "2026/10/6 01:00",
    );
  });

  it("formatMarketplaceDateTimeLocalInput：server 生成 canonical campus-local input 文本（RB01-D）", () => {
    // 绝对 instant → 上海 wall-clock 文本（不依赖 client/server 时区）
    expect(formatMarketplaceDateTimeLocalInput(new Date("2026-10-05T06:30:00.000Z"))).toBe(
      "2026-10-05T14:30",
    );
    // parse 与 format 互逆
    const original = new Date("2026-10-05T06:30:00.000Z");
    expect(parseMarketplaceDateTimeLocal(formatMarketplaceDateTimeLocalInput(original))!.toISOString()).toBe(
      original.toISOString(),
    );
  });
});
