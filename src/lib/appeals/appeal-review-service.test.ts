import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  txQueryRaw,
  txAppealFindUnique,
  txAppealUpdate,
  txEnforcementActionFindFirst,
  txUserFindUnique,
  txCampusMembershipFindUnique,
  txRiskStateFindUnique,
  acquireGovernanceSubjectLocks,
  recordAdminAudit,
  createNotification,
  loggerWarn,
  loadAuthorizationContextMock,
  restoreFromAppealTxLocked,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  txQueryRaw: vi.fn(),
  txAppealFindUnique: vi.fn(),
  txAppealUpdate: vi.fn(),
  txEnforcementActionFindFirst: vi.fn(),
  txUserFindUnique: vi.fn(),
  txCampusMembershipFindUnique: vi.fn(),
  txRiskStateFindUnique: vi.fn(),
  acquireGovernanceSubjectLocks: vi.fn(),
  recordAdminAudit: vi.fn(),
  createNotification: vi.fn(),
  loggerWarn: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  restoreFromAppealTxLocked: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: withTransactionMock,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
}));

vi.mock("@/lib/governance/admin-audit", () => ({
  recordAdminAudit,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotification,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: loggerWarn, info: vi.fn(), error: vi.fn() },
}));

// restore 适配层只 mock seam 执行（resolveRestorationTarget 保持真实实现）
vi.mock("@/lib/appeals/appeal-restore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/appeals/appeal-restore")>();
  return {
    ...actual,
    restoreFromAppealTxLocked,
  };
});

// hasPermission 用真实实现，仅替换 context 加载
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return {
    ...actual,
    loadAuthorizationContext: loadAuthorizationContextMock,
  };
});

import { beginAppealReview, decideAppeal } from "@/lib/appeals/appeal-review-service";
import { appealError } from "@/lib/appeals/errors";
import type { AuthorizationContext } from "@/lib/rbac/service";
import type { EnforcementActionType, Prisma } from "@prisma/client";

const BOUNDARY = BigInt(1_000_000_000);

const txStub = {
  $queryRaw: txQueryRaw,
  appeal: { findUnique: txAppealFindUnique, update: txAppealUpdate },
  enforcementAction: { findFirst: txEnforcementActionFindFirst },
  user: { findUnique: txUserFindUnique },
  campusMembership: { findUnique: txCampusMembershipFindUnique },
  riskState: { findUnique: txRiskStateFindUnique },
};

function accountAction(overrides: Partial<{
  id: string;
  type: EnforcementActionType;
  actorId: string;
  targetId: string;
  campusId: string | null;
  scopeKey: string;
  previousState: string | null;
  enforcementSeq: bigint;
}> = {}) {
  return {
    id: "ea-1",
    type: "ACCOUNT_SUSPEND" as EnforcementActionType,
    actorId: "admin-actor",
    targetId: "target-1",
    campusId: null,
    scopeKey: "GLOBAL",
    previousState: "USER:ACTIVE",
    enforcementSeq: BOUNDARY + BigInt(5),
    ...overrides,
  };
}

function submittedAppeal(action = accountAction()) {
  return {
    id: "ap-1",
    status: "SUBMITTED",
    enforcementActionId: action.id,
    enforcementAction: action,
  };
}

function reviewerContext(permissionScopes: Array<"GLOBAL" | "CAMPUS"> = ["GLOBAL"]): AuthorizationContext {
  return {
    userId: "reviewer-1",
    accountActive: true,
    activeCampusIds: permissionScopes.includes("CAMPUS") ? ["campus-a"] : [],
    grants: permissionScopes.map((scope) => ({
      roleKey: scope === "GLOBAL" ? "PLATFORM_ADMIN" : "CAMPUS_REVIEWER",
      scope,
      campusId: scope === "CAMPUS" ? "campus-a" : null,
      permissionKeys: ["appeal.review"],
    })),
  };
}

beforeEach(() => {
  for (const fn of [
    withTransactionMock,
    txQueryRaw,
    txAppealFindUnique,
    txAppealUpdate,
    txEnforcementActionFindFirst,
    txUserFindUnique,
    txCampusMembershipFindUnique,
    txRiskStateFindUnique,
    acquireGovernanceSubjectLocks,
    recordAdminAudit,
    createNotification,
    loggerWarn,
    loadAuthorizationContextMock,
    restoreFromAppealTxLocked,
  ]) {
    fn.mockReset();
  }
  txQueryRaw.mockResolvedValue([{ id: "ap-1" }]);
  txAppealUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "ap-1",
    enforcementActionId: "ea-1",
    reviewedById: "reviewer-1",
    reviewedAt: new Date(),
    ...data,
  }));
  // 默认 latest = 被申诉 action 本身（latest check 通过；stale 场景按测试覆盖）
  txEnforcementActionFindFirst.mockResolvedValue(accountAction());
  txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: null, status: "SUSPENDED" });
  txCampusMembershipFindUnique.mockResolvedValue({ status: "SUSPENDED" });
  txRiskStateFindUnique.mockResolvedValue({ state: "RESTRICTED" });
  acquireGovernanceSubjectLocks.mockResolvedValue(undefined);
  recordAdminAudit.mockResolvedValue(undefined);
  createNotification.mockResolvedValue({});
  restoreFromAppealTxLocked.mockResolvedValue(undefined);
  loadAuthorizationContextMock.mockResolvedValue(reviewerContext());
  withTransactionMock.mockImplementation(
    async (cb: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      cb(txStub as unknown as Prisma.TransactionClient),
  );
});

function installAppeal(appeal = submittedAppeal()) {
  txAppealFindUnique.mockResolvedValue(appeal);
  // latestSameFamilyAction 返回被申诉 action 自身（latest == appealed → 继续 merits）
  txEnforcementActionFindFirst.mockResolvedValue(appeal.enforcementAction);
  return appeal;
}

describe("beginAppealReview（行锁 → sorted 锁 → 锁后授权重读；workflow-only）", () => {
  it("锁序：Appeal 行锁 → 完整 sorted subject 锁 → 锁后 AuthorizationContext 重读", async () => {
    const order: string[] = [];
    installAppeal();
    txQueryRaw.mockImplementation(async () => {
      order.push("row-lock");
      return [{ id: "ap-1" }];
    });
    acquireGovernanceSubjectLocks.mockImplementation(async () => {
      order.push("subject-locks");
    });
    loadAuthorizationContextMock.mockImplementation(async () => {
      order.push("auth-re-read");
      return reviewerContext();
    });

    await beginAppealReview({ reviewerId: "reviewer-1", appealId: "ap-1" });

    expect(order).toEqual(["row-lock", "subject-locks", "auth-re-read"]);
    // 完整 sorted set：reviewer + target 一次取齐
    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(expect.anything(), [
      { subjectType: "USER", subjectId: "reviewer-1" },
      { subjectType: "USER", subjectId: "target-1" },
    ]);
  });

  it("IN_REVIEW 不写 reviewedById/reviewedAt（workflow-only，无 claimant）", async () => {
    installAppeal();
    await beginAppealReview({ reviewerId: "reviewer-1", appealId: "ap-1" });

    expect(txAppealUpdate).toHaveBeenCalledWith({
      where: { id: "ap-1" },
      data: { status: "IN_REVIEW" },
    });
    const data = txAppealUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(Object.keys(data.data)).not.toContain("reviewedById");
    expect(Object.keys(data.data)).not.toContain("reviewedAt");
    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "APPEAL_REVIEW_STARTED",
      targetType: "APPEAL",
      targetId: "ap-1",
      detail: null,
      metadata: expect.objectContaining({
        appealId: "ap-1",
        appealStatus: "IN_REVIEW",
        enforcementActionId: "ea-1",
      }),
    }), expect.anything());
  });

  it("授权失败族：无 permission → REVIEW_FORBIDDEN；campus reviewer 审 GLOBAL → SCOPE_MISMATCH", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "reviewer-1",
      accountActive: true,
      activeCampusIds: ["campus-a"],
      grants: [{ roleKey: "R", scope: "CAMPUS", campusId: "campus-a", permissionKeys: ["appeal.review"] }],
    });
    installAppeal();
    await expect(beginAppealReview({ reviewerId: "reviewer-1", appealId: "ap-1" })).rejects.toMatchObject({
      code: "APPEAL_SCOPE_MISMATCH",
    });

    loadAuthorizationContextMock.mockResolvedValue({
      userId: "reviewer-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [{ roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["report.review"] }],
    });
    await expect(beginAppealReview({ reviewerId: "reviewer-1", appealId: "ap-1" })).rejects.toMatchObject({
      code: "APPEAL_REVIEW_FORBIDDEN",
    });

    // 账号被停用（T31 语义）：accountActive=false → REVIEW_FORBIDDEN，Appeal 保持 SUBMITTED
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "reviewer-1",
      accountActive: false,
      activeCampusIds: [],
      grants: [{ roleKey: "PLATFORM_ADMIN", scope: "GLOBAL", campusId: null, permissionKeys: ["appeal.review"] }],
    });
    await expect(beginAppealReview({ reviewerId: "reviewer-1", appealId: "ap-1" })).rejects.toMatchObject({
      code: "APPEAL_REVIEW_FORBIDDEN",
    });
    expect(txAppealUpdate).not.toHaveBeenCalled();
  });

  it("reviewer == appellant → APPEAL_REVIEWER_IS_APPELLANT；非 SUBMITTED → APPEAL_INVALID_TRANSITION", async () => {
    installAppeal(submittedAppeal(accountAction({ targetId: "reviewer-1" })));
    await expect(beginAppealReview({ reviewerId: "reviewer-1", appealId: "ap-1" })).rejects.toMatchObject({
      code: "APPEAL_REVIEWER_IS_APPELLANT",
    });

    installAppeal({ ...submittedAppeal(), status: "IN_REVIEW" });
    await expect(beginAppealReview({ reviewerId: "reviewer-1", appealId: "ap-1" })).rejects.toMatchObject({
      code: "APPEAL_INVALID_TRANSITION",
    });
  });
});

describe("decideAppeal（程序性 DISMISSED = 提交成功；GRANT 经 canonical seam）", () => {
  it("GRANTED：恢复目标精确解析 + canonical seam（note=null）+ terminal provenance 写入", async () => {
    installAppeal();
    const result = await decideAppeal({
      reviewerId: "reviewer-1",
      appealId: "ap-1",
      decision: "GRANTED",
      decisionNote: "  申诉成立  ",
    });

    expect(restoreFromAppealTxLocked).toHaveBeenCalledWith(expect.anything(), {
      appealId: "ap-1",
      reviewerId: "reviewer-1",
      targetUserId: "target-1",
      target: { kind: "ACCOUNT" },
    });
    expect(result.outcome).toBe("GRANTED");
    expect(result.reasonCode).toBe("MERIT_APPEAL_JUSTIFIED");
    expect(txAppealUpdate).toHaveBeenCalledWith({
      where: { id: "ap-1" },
      data: expect.objectContaining({
        status: "GRANTED",
        decisionReasonCode: "MERIT_APPEAL_JUSTIFIED",
        reviewedById: "reviewer-1",
        decisionNote: "申诉成立",
      }),
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "APPEAL_GRANTED",
      detail: null,
      metadata: expect.objectContaining({
        appealId: "ap-1",
        appealStatus: "GRANTED",
        decisionReasonCode: "MERIT_APPEAL_JUSTIFIED",
        selfReview: false,
        enforcementActionId: "ea-1",
      }),
    }), expect.anything());
    expect(createNotification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "target-1",
      type: "SYSTEM",
    }));
  });

  it("UPHELD：零 operational mutation（不触 seam），reason = MERIT_VIOLATION_CONFIRMED", async () => {
    installAppeal();
    const result = await decideAppeal({
      reviewerId: "reviewer-1",
      appealId: "ap-1",
      decision: "UPHELD",
    });

    expect(restoreFromAppealTxLocked).not.toHaveBeenCalled();
    expect(result.outcome).toBe("UPHELD");
    expect(result.reasonCode).toBe("MERIT_VIOLATION_CONFIRMED");
    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "APPEAL_UPHELD",
    }), expect.anything());
  });

  it("self-review（reviewer == 原执法 actor）= ALLOWED + AdminAudit selfReview=true", async () => {
    installAppeal(submittedAppeal(accountAction({ actorId: "reviewer-1" })));
    await decideAppeal({ reviewerId: "reviewer-1", appealId: "ap-1", decision: "UPHELD" });

    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ selfReview: true }),
    }), expect.anything());
  });

  it("appellant erased → 提交式 DISMISSED(APPELLANT_ERASED)，绝不 throw，不触 seam", async () => {
    installAppeal();
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: new Date() });

    const result = await decideAppeal({ reviewerId: "reviewer-1", appealId: "ap-1", decision: "GRANTED" });

    expect(result).toMatchObject({ outcome: "DISMISSED", reasonCode: "APPELLANT_ERASED" });
    expect(restoreFromAppealTxLocked).not.toHaveBeenCalled();
    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "APPEAL_DISMISSED",
      detail: null,
      metadata: expect.objectContaining({ decisionReasonCode: "APPELLANT_ERASED" }),
    }), expect.anything());
  });

  it("legacy（previousState=null）→ DISMISSED(LEGACY_PROVENANCE_INSUFFICIENT)，零恢复", async () => {
    installAppeal(submittedAppeal(accountAction({ previousState: null })));
    const result = await decideAppeal({ reviewerId: "reviewer-1", appealId: "ap-1", decision: "GRANTED" });

    expect(result).toMatchObject({ outcome: "DISMISSED", reasonCode: "LEGACY_PROVENANCE_INSUFFICIENT" });
    expect(restoreFromAppealTxLocked).not.toHaveBeenCalled();
  });

  it("newer punitive 同族 → DISMISSED(STALE_ENFORCEMENT)；newer restorative → ALREADY_REVERSED", async () => {
    installAppeal();
    txEnforcementActionFindFirst.mockResolvedValue(
      accountAction({ id: "ea-newer", type: "ACCOUNT_SUSPEND", enforcementSeq: BOUNDARY + BigInt(9) }),
    );
    const stale = await decideAppeal({ reviewerId: "reviewer-1", appealId: "ap-1", decision: "GRANTED" });
    expect(stale).toMatchObject({ outcome: "DISMISSED", reasonCode: "STALE_ENFORCEMENT" });

    txEnforcementActionFindFirst.mockResolvedValue(
      accountAction({ id: "ea-newer", type: "ACCOUNT_REINSTATE", enforcementSeq: BOUNDARY + BigInt(9) }),
    );
    const reversed = await decideAppeal({ reviewerId: "reviewer-1", appealId: "ap-1", decision: "GRANTED" });
    expect(reversed).toMatchObject({ outcome: "DISMISSED", reasonCode: "ENFORCEMENT_ALREADY_REVERSED" });
    expect(restoreFromAppealTxLocked).not.toHaveBeenCalled();
  });

  it("operational state 已不匹配 → DISMISSED(ENFORCEMENT_ALREADY_REVERSED)", async () => {
    installAppeal();
    txEnforcementActionFindFirst.mockResolvedValue(accountAction()); // latest == appealed
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: null, status: "ACTIVE" });

    const result = await decideAppeal({ reviewerId: "reviewer-1", appealId: "ap-1", decision: "GRANTED" });
    expect(result).toMatchObject({ outcome: "DISMISSED", reasonCode: "ENFORCEMENT_ALREADY_REVERSED" });
    expect(restoreFromAppealTxLocked).not.toHaveBeenCalled();
  });

  it("RISK GRANT：WATCH 恢复目标来自 previousState 精确解析（不硬编码 NORMAL）", async () => {
    installAppeal(submittedAppeal(accountAction({
      type: "MARKETPLACE_RESTRICT",
      scopeKey: "CAMPUS:campus-a",
      campusId: "campus-a",
      previousState: "RISK_STATE:WATCH@CAMPUS:campus-a",
    })));
    loadAuthorizationContextMock.mockResolvedValue(reviewerContext(["GLOBAL", "CAMPUS"]));
    await decideAppeal({ reviewerId: "reviewer-1", appealId: "ap-1", decision: "GRANTED" });

    expect(restoreFromAppealTxLocked).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      target: { kind: "RISK", state: "WATCH", campusId: "campus-a" },
    }));
  });

  it("GRANTED 但恢复目标不可解析（编码破坏）→ DISMISSED(LEGACY_PROVENANCE_INSUFFICIENT)", async () => {
    installAppeal(submittedAppeal(accountAction({
      type: "MARKETPLACE_RESTRICT",
      scopeKey: "GLOBAL",
      previousState: "RISK_STATE:GARBAGE@GLOBAL",
    })));
    txRiskStateFindUnique.mockResolvedValue({ state: "RESTRICTED" });

    const result = await decideAppeal({ reviewerId: "reviewer-1", appealId: "ap-1", decision: "GRANTED" });
    expect(result).toMatchObject({ outcome: "DISMISSED", reasonCode: "LEGACY_PROVENANCE_INSUFFICIENT" });
  });

  it("terminal（double-review loser）→ APPEAL_INVALID_TRANSITION；reviewer==appellant 零例外", async () => {
    installAppeal({ ...submittedAppeal(), status: "GRANTED" });
    await expect(
      decideAppeal({ reviewerId: "reviewer-1", appealId: "ap-1", decision: "UPHELD" }),
    ).rejects.toMatchObject({ code: "APPEAL_INVALID_TRANSITION" });

    installAppeal(submittedAppeal(accountAction({ targetId: "reviewer-1" })));
    await expect(
      decideAppeal({ reviewerId: "reviewer-1", appealId: "ap-1", decision: "UPHELD" }),
    ).rejects.toMatchObject({ code: "APPEAL_REVIEWER_IS_APPELLANT" });
    void appealError;
  });

  it("decisionNote 隔离：canary 只进 Appeal.decisionNote，审计 detail 恒 null / metadata 无自由文本", async () => {
    installAppeal();
    const canary = "APPEAL_INTERNAL_NOTE_CANARY";
    await decideAppeal({
      reviewerId: "reviewer-1",
      appealId: "ap-1",
      decision: "GRANTED",
      decisionNote: ` ${canary} `,
    });

    expect(txAppealUpdate).toHaveBeenCalledWith({
      where: { id: "ap-1" },
      data: expect.objectContaining({ decisionNote: canary }),
    });
    for (const call of recordAdminAudit.mock.calls) {
      const input = call[0] as { detail: unknown; metadata: Record<string, unknown> | null };
      expect(input.detail).toBeNull();
      const serialized = JSON.stringify(input.metadata ?? {});
      expect(serialized).not.toContain(canary);
    }
    const notificationPayload = JSON.stringify(createNotification.mock.calls);
    expect(notificationPayload).not.toContain(canary);
  });

  it("decision 通知失败仅记 APPEAL_NOTIFICATION_FAILED（command success 不受影响）", async () => {
    installAppeal();
    createNotification.mockRejectedValue(new Error("down"));

    const result = await decideAppeal({ reviewerId: "reviewer-1", appealId: "ap-1", decision: "UPHELD" });
    expect(result.outcome).toBe("UPHELD");
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("通知投递失败"),
      "appeals",
      expect.objectContaining({ event: "APPEAL_NOTIFICATION_FAILED" }),
    );
  });
});
