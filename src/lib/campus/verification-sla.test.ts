import { describe, expect, it } from "vitest";

import {
  computeVerificationReviewDueAt,
  isVerificationReviewOverdue,
  VERIFICATION_REVIEW_SLA_HOURS,
} from "@/lib/campus/verification-sla";

/**
 * Phase 7F 审核 SLA 单元合同：
 * - 48h 冻结常量；
 * - dueAt origin = submittedAt（重提交以新 submittedAt 重置）；
 * - overdue 只读判定（仅 PENDING 且已过 due）。
 */
describe("verification-sla", () => {
  it("SLA 常量冻结 48h", () => {
    expect(VERIFICATION_REVIEW_SLA_HOURS).toBe(48);
  });

  it("computeVerificationReviewDueAt：origin = submittedAt + 48h（毫秒精确）", () => {
    const submittedAt = new Date("2026-09-18T00:00:00.000Z");
    expect(computeVerificationReviewDueAt(submittedAt).toISOString()).toBe(
      "2026-09-20T00:00:00.000Z",
    );

    const nearPast = new Date("2026-01-01T12:34:56.789Z");
    expect(
      computeVerificationReviewDueAt(nearPast).getTime() - nearPast.getTime(),
    ).toBe(48 * 60 * 60 * 1000);
  });

  it("isVerificationReviewOverdue：仅 PENDING 且 reviewDueAt < now 判超时", () => {
    const now = new Date("2026-09-18T12:00:00.000Z");
    const past = new Date("2026-09-18T11:59:59.999Z");
    const future = new Date("2026-09-18T12:00:00.001Z");

    expect(isVerificationReviewOverdue({ status: "PENDING", reviewDueAt: past }, now)).toBe(true);
    expect(isVerificationReviewOverdue({ status: "PENDING", reviewDueAt: future }, now)).toBe(false);
    // 非 PENDING（已决定）即使过了 due 也不是 overdue（SLA 只覆盖待审）
    expect(isVerificationReviewOverdue({ status: "VERIFIED", reviewDueAt: past }, now)).toBe(false);
    expect(isVerificationReviewOverdue({ status: "REJECTED", reviewDueAt: past }, now)).toBe(false);
    expect(isVerificationReviewOverdue({ status: "REVOKED", reviewDueAt: past }, now)).toBe(false);
  });
});
