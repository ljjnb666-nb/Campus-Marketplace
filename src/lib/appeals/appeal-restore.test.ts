import { beforeEach, describe, expect, it, vi } from "vitest";

const { reinstateAccountTxLocked, reinstateCampusMembershipTxLocked, setRiskStateTxLocked } =
  vi.hoisted(() => ({
    reinstateAccountTxLocked: vi.fn(),
    reinstateCampusMembershipTxLocked: vi.fn(),
    setRiskStateTxLocked: vi.fn(),
  }));

vi.mock("@/lib/enforcement/account-enforcement-service", () => ({
  reinstateAccountTxLocked,
}));

vi.mock("@/lib/enforcement/membership-enforcement-service", () => ({
  reinstateCampusMembershipTxLocked,
}));

vi.mock("@/lib/enforcement/risk-service", () => ({
  setRiskStateTxLocked,
}));

import {
  APPEAL_RESTORATIVE_REASON_CODE,
  resolveRestorationTarget,
  restoreFromAppealTxLocked,
} from "@/lib/appeals/appeal-restore";
import type { EnforcementActionType } from "@prisma/client";

const txStub = {} as Parameters<typeof restoreFromAppealTxLocked>[0];

function appealed(overrides: Partial<{
  type: EnforcementActionType;
  campusId: string | null;
  scopeKey: string;
  previousState: string | null;
}> = {}) {
  return {
    type: "ACCOUNT_SUSPEND" as EnforcementActionType,
    campusId: null,
    scopeKey: "GLOBAL",
    previousState: "USER:ACTIVE",
    ...overrides,
  };
}

beforeEach(() => {
  reinstateAccountTxLocked.mockReset().mockResolvedValue({});
  reinstateCampusMembershipTxLocked.mockReset().mockResolvedValue({});
  setRiskStateTxLocked.mockReset().mockResolvedValue({});
});

describe("resolveRestorationTarget（恢复目标精确解析，禁止猜测）", () => {
  it("ACCOUNT_SUSPEND → ACCOUNT（canonical reinstate 状态机决定目标）", () => {
    expect(resolveRestorationTarget(appealed())).toEqual({ kind: "ACCOUNT" });
  });

  it("MEMBERSHIP_SUSPEND → 同 campus；缺 campusId / scopeKey 不一致 → null（fail closed）", () => {
    expect(resolveRestorationTarget(appealed({
      type: "MEMBERSHIP_SUSPEND",
      campusId: "campus-a",
      scopeKey: "CAMPUS:campus-a",
      previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
    }))).toEqual({ kind: "MEMBERSHIP", campusId: "campus-a" });

    expect(resolveRestorationTarget(appealed({
      type: "MEMBERSHIP_SUSPEND",
      campusId: null,
      scopeKey: "GLOBAL",
      previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
    }))).toBeNull();

    expect(resolveRestorationTarget(appealed({
      type: "MEMBERSHIP_SUSPEND",
      campusId: "campus-a",
      scopeKey: "CAMPUS:campus-b",
      previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
    }))).toBeNull();
  });

  it("RISK：WATCH → RESTRICTED 恢复回 WATCH；NORMAL@GLOBAL 恢复 NORMAL（绝不硬编码）", () => {
    expect(resolveRestorationTarget(appealed({
      type: "MARKETPLACE_RESTRICT",
      scopeKey: "GLOBAL",
      previousState: "RISK_STATE:WATCH@GLOBAL",
    }))).toEqual({ kind: "RISK", state: "WATCH", campusId: null });

    expect(resolveRestorationTarget(appealed({
      type: "MARKETPLACE_RESTRICT",
      scopeKey: "CAMPUS:c1",
      previousState: "RISK_STATE:NORMAL@CAMPUS:c1",
    }))).toEqual({ kind: "RISK", state: "NORMAL", campusId: "c1" });
  });

  it("RISK：RESTRICTED 目标 / scope 不一致 / 无法解析的编码 → null（LEGACY_PROVENANCE）", () => {
    expect(resolveRestorationTarget(appealed({
      type: "MARKETPLACE_RESTRICT",
      scopeKey: "GLOBAL",
      previousState: "RISK_STATE:RESTRICTED@GLOBAL",
    }))).toBeNull();

    expect(resolveRestorationTarget(appealed({
      type: "MARKETPLACE_RESTRICT",
      scopeKey: "GLOBAL",
      previousState: "RISK_STATE:NORMAL@CAMPUS:other",
    }))).toBeNull();

    expect(resolveRestorationTarget(appealed({
      type: "MARKETPLACE_RESTRICT",
      scopeKey: "GLOBAL",
      previousState: "garbage",
    }))).toBeNull();
  });

  it("previousState 缺失（ROLLBACK_COMPAT）/ restorative 类型 → null", () => {
    expect(resolveRestorationTarget(appealed({ previousState: null }))).toBeNull();
    expect(resolveRestorationTarget(appealed({ type: "MARKETPLACE_RESTORE" }))).toBeNull();
  });
});

describe("restoreFromAppealTxLocked（canonical seam 适配；note 恒 NULL）", () => {
  it("seam 输入硬合同：reasonCode=APPEAL_GRANTED / sourceType=APPEAL / sourceId=appeal.id / note=null", async () => {
    await restoreFromAppealTxLocked(txStub, {
      appealId: "ap-1",
      reviewerId: "reviewer-1",
      targetUserId: "target-1",
      target: { kind: "ACCOUNT" },
    });

    expect(reinstateAccountTxLocked).toHaveBeenCalledWith(txStub, {
      actorId: "reviewer-1",
      targetUserId: "target-1",
      reasonCode: APPEAL_RESTORATIVE_REASON_CODE,
      sourceType: "APPEAL",
      sourceId: "ap-1",
      note: null,
    });
    expect(APPEAL_RESTORATIVE_REASON_CODE).toBe("APPEAL_GRANTED");
  });

  it("按 target.kind 派发到正确的 canonical seam（membership 带 campusId；risk 带精确 state）", async () => {
    await restoreFromAppealTxLocked(txStub, {
      appealId: "ap-2",
      reviewerId: "reviewer-1",
      targetUserId: "target-1",
      target: { kind: "MEMBERSHIP", campusId: "campus-a" },
    });
    expect(reinstateCampusMembershipTxLocked).toHaveBeenCalledWith(txStub, expect.objectContaining({
      campusId: "campus-a",
      note: null,
      sourceId: "ap-2",
    }));

    await restoreFromAppealTxLocked(txStub, {
      appealId: "ap-3",
      reviewerId: "reviewer-1",
      targetUserId: "target-1",
      target: { kind: "RISK", state: "WATCH", campusId: "campus-a" },
    });
    expect(setRiskStateTxLocked).toHaveBeenCalledWith(txStub, expect.objectContaining({
      campusId: "campus-a",
      state: "WATCH",
      note: null,
    }));
  });
});
