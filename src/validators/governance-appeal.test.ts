import { describe, expect, it } from "vitest";

import {
  governanceAppealBeginSchema,
  governanceAppealDecisionSchema,
} from "@/validators/governance-appeal";
import { APPEAL_DECISION_NOTE_MAX_LENGTH } from "@/lib/appeals/appeal-service";

/**
 * Phase 7A 治理面 action 表单合同：.strict() 拒绝身份类未知字段
 * （GOV-03 CLIENT_FORGED_REVIEWER）；decisionNote 上限复用域常量。
 */

describe("governanceAppealBeginSchema", () => {
  it("接受合法 appealId", () => {
    expect(governanceAppealBeginSchema.safeParse({ appealId: "a1" }).success).toBe(true);
  });

  it("缺失 appealId 拒绝", () => {
    expect(governanceAppealBeginSchema.safeParse({}).success).toBe(false);
  });

  it("strict：伪造 reviewerId/decision 等未知字段一律拒绝", () => {
    expect(
      governanceAppealBeginSchema.safeParse({ appealId: "a1", reviewerId: "attacker" }).success,
    ).toBe(false);
    expect(
      governanceAppealBeginSchema.safeParse({ appealId: "a1", campusId: "B" }).success,
    ).toBe(false);
    expect(
      governanceAppealBeginSchema.safeParse({ appealId: "a1", decision: "GRANTED" }).success,
    ).toBe(false);
  });
});

describe("governanceAppealDecisionSchema", () => {
  it("接受 GRANTED/UPHELD + 可选备注", () => {
    expect(
      governanceAppealDecisionSchema.safeParse({ appealId: "a1", decision: "GRANTED" }).success,
    ).toBe(true);
    expect(
      governanceAppealDecisionSchema.safeParse({
        appealId: "a1",
        decision: "UPHELD",
        decisionNote: "维持原判",
      }).success,
    ).toBe(true);
  });

  it("decision 仅允许 GRANTED|UPHELD（程序性 DISMISSED 是域计算结局）", () => {
    expect(
      governanceAppealDecisionSchema.safeParse({ appealId: "a1", decision: "DISMISSED" }).success,
    ).toBe(false);
  });

  it("decisionNote 上限 = APPEAL_DECISION_NOTE_MAX_LENGTH（1000，A-10/A-11）", () => {
    const ok = "好".repeat(APPEAL_DECISION_NOTE_MAX_LENGTH);
    const tooLong = "好".repeat(APPEAL_DECISION_NOTE_MAX_LENGTH + 1);
    expect(
      governanceAppealDecisionSchema.safeParse({ appealId: "a1", decision: "UPHELD", decisionNote: ok })
        .success,
    ).toBe(true);
    expect(
      governanceAppealDecisionSchema.safeParse({
        appealId: "a1",
        decision: "UPHELD",
        decisionNote: tooLong,
      }).success,
    ).toBe(false);
  });

  it("strict：伪造 reviewerId 一律拒绝", () => {
    expect(
      governanceAppealDecisionSchema.safeParse({
        appealId: "a1",
        decision: "UPHELD",
        reviewerId: "attacker",
      }).success,
    ).toBe(false);
  });
});
