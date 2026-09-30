import { describe, expect, it } from "vitest";

import {
  MEETUP_NO_SHOW_GRACE_MS,
  isMeetupArrivalWindowOpen,
  isMeetupCancelWindowOpen,
  isMeetupConfirmTimeValid,
  isMeetupCustomLocationValid,
  isMeetupNoShowWindowOpen,
  isMeetupProposalTimeValid,
} from "@/lib/meetups/meetup-policy";

/**
 * Phase 8D-01：meetup 时间 / 地点策略的精确边界单元合同（D01-UNIT-01/02）。
 *
 * 冻结语义：毫秒精度；exact 等号归属——
 *   proposal/confirm：scheduledAt > now（exact now DENY）
 *   arrival：now >= scheduledAt（exact now ELIGIBLE）
 *   cancel：now < scheduledAt（exact scheduledAt DENY）
 *   no-show：now >= scheduledAt + 15min（exact 等号 ELIGIBLE）
 */

const BASE = Date.parse("2026-09-30T12:00:00.000Z");
const SCHEDULED = Date.parse("2026-09-30T13:00:00.000Z");

describe("meetup-policy：精确时间边界", () => {
  it("D01-UNIT-01：scheduledAt 精确边界——proposal/confirm exact now DENY；arrival exact now ELIGIBLE；cancel exact scheduledAt DENY", () => {
    const now = new Date(BASE);

    // proposal：严格未来；exact now / 过去 DENY
    expect(isMeetupProposalTimeValid(new Date(BASE + 1), now)).toBe(true);
    expect(isMeetupProposalTimeValid(new Date(BASE), now)).toBe(false);
    expect(isMeetupProposalTimeValid(new Date(BASE - 1), now)).toBe(false);

    // confirm：同样严格未来（过期 proposal DENY，不自动改状态）
    expect(isMeetupConfirmTimeValid(new Date(BASE + 1), now)).toBe(true);
    expect(isMeetupConfirmTimeValid(new Date(BASE), now)).toBe(false);

    // arrival：exact scheduledAt 起 ELIGIBLE；提前 DENY
    expect(isMeetupArrivalWindowOpen(new Date(SCHEDULED), new Date(SCHEDULED))).toBe(true);
    expect(isMeetupArrivalWindowOpen(new Date(SCHEDULED), new Date(SCHEDULED - 1))).toBe(false);
    expect(isMeetupArrivalWindowOpen(new Date(SCHEDULED), new Date(SCHEDULED + 1))).toBe(true);

    // cancel：仅 now < scheduledAt；exact scheduledAt DENY（不能绕过 no-show）
    expect(isMeetupCancelWindowOpen(new Date(SCHEDULED), new Date(SCHEDULED - 1))).toBe(true);
    expect(isMeetupCancelWindowOpen(new Date(SCHEDULED), new Date(SCHEDULED))).toBe(false);
    expect(isMeetupCancelWindowOpen(new Date(SCHEDULED), new Date(SCHEDULED + 1))).toBe(false);
  });

  it("D01-UNIT-02：no-show 宽限边界——exact scheduledAt+15min ELIGIBLE；grace 内 DENY；grace 常量冻结 15 分钟", () => {
    expect(MEETUP_NO_SHOW_GRACE_MS).toBe(15 * 60 * 1000);

    const atGrace = new Date(SCHEDULED + MEETUP_NO_SHOW_GRACE_MS);
    const beforeGrace = new Date(SCHEDULED + MEETUP_NO_SHOW_GRACE_MS - 1);
    const atScheduled = new Date(SCHEDULED);

    expect(isMeetupNoShowWindowOpen(new Date(SCHEDULED), atGrace)).toBe(true);
    expect(isMeetupNoShowWindowOpen(new Date(SCHEDULED), beforeGrace)).toBe(false);
    expect(isMeetupNoShowWindowOpen(new Date(SCHEDULED), atScheduled)).toBe(false);
  });

  it("custom location 边界：trim 后 2..80 合法；超界 DENY", () => {
    expect(isMeetupCustomLocationValid("东门")).toBe(true);
    expect(isMeetupCustomLocationValid("  东门  ")).toBe(true);
    expect(isMeetupCustomLocationValid("东")).toBe(false);
    expect(isMeetupCustomLocationValid("  ")).toBe(false);
    expect(isMeetupCustomLocationValid("门".repeat(80))).toBe(true);
    expect(isMeetupCustomLocationValid("门".repeat(81))).toBe(false);
  });
});
