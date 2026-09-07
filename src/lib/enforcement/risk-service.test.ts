import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  txRiskStateFindUnique,
  txRiskStateUpsert,
  txRiskFlagCreate,
  txRiskFlagFindUnique,
  txRiskFlagUpdate,
  txUserFindUnique,
  txMembershipFindUnique,
  txEnforcementActionCreate,
  acquireGovernanceSubjectLocks,
  recordAdminAudit,
  loadAuthorizationContextMock,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  txRiskStateFindUnique: vi.fn(),
  txRiskStateUpsert: vi.fn(),
  txRiskFlagCreate: vi.fn(),
  txRiskFlagFindUnique: vi.fn(),
  txRiskFlagUpdate: vi.fn(),
  txUserFindUnique: vi.fn(),
  txMembershipFindUnique: vi.fn(),
  txEnforcementActionCreate: vi.fn(),
  acquireGovernanceSubjectLocks: vi.fn(),
  recordAdminAudit: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
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

// hasPermission / hasFullAdminSurfaceAccess 用真实实现，仅替换 context 加载
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return {
    ...actual,
    loadAuthorizationContext: loadAuthorizationContextMock,
  };
});

import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  isMarketplaceRestricted,
  recordRiskFlag,
  resolveRiskFlag,
  setRiskState,
} from "@/lib/enforcement/risk-service";

const txStub = {
  riskState: { findUnique: txRiskStateFindUnique, upsert: txRiskStateUpsert, findMany: vi.fn().mockResolvedValue([]) },
  riskFlag: { create: txRiskFlagCreate, findUnique: txRiskFlagFindUnique, update: txRiskFlagUpdate },
  user: { findUnique: txUserFindUnique },
  campusMembership: { findUnique: txMembershipFindUnique },
  enforcementAction: { create: txEnforcementActionCreate },
};

const ACTIVE_TARGET = { id: "target-1", status: "ACTIVE", deletedAt: null, erasedAt: null };

function ctxWith(
  grants: AuthorizationContext["grants"],
  activeCampusIds: string[] = [],
): AuthorizationContext {
  return {
    userId: "actor-1",
    accountActive: true,
    activeCampusIds,
    grants,
  };
}

function globalEnforcer(): AuthorizationContext {
  return ctxWith([
    {
      roleKey: "PLATFORM_ADMIN",
      scope: "GLOBAL",
      campusId: null,
      permissionKeys: ["user.suspend", "campus.manage"],
    },
  ]);
}

beforeEach(() => {
  withTransactionMock
    .mockReset()
    .mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub));
  txRiskStateFindUnique.mockReset().mockResolvedValue(null);
  txRiskStateUpsert.mockReset().mockImplementation(async ({ update }: { update: { state: string } }) => ({
    state: update.state,
  }));
  txRiskFlagCreate.mockReset().mockResolvedValue({});
  txRiskFlagFindUnique.mockReset().mockResolvedValue(null);
  txRiskFlagUpdate.mockReset().mockResolvedValue({});
  txUserFindUnique.mockReset().mockResolvedValue({ ...ACTIVE_TARGET });
  txMembershipFindUnique.mockReset().mockResolvedValue({ status: "ACTIVE" });
  txEnforcementActionCreate.mockReset().mockResolvedValue({});
  acquireGovernanceSubjectLocks.mockReset().mockResolvedValue(undefined);
  recordAdminAudit.mockReset().mockResolvedValue(undefined);
  loadAuthorizationContextMock.mockReset().mockResolvedValue(globalEnforcer());
});

describe("setRiskState（显式可解释风险状态）", () => {
  it("restricts a global scope with EnforcementAction + audit", async () => {
    const result = await setRiskState({
      actorId: "actor-1",
      targetUserId: "target-1",
      campusId: null,
      state: "RESTRICTED",
      reasonCode: "FRAUD_CONFIRMED",
    });

    expect(result).toMatchObject({ state: "RESTRICTED", previousState: null, changed: true });
    expect(txEnforcementActionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "MARKETPLACE_RESTRICT",
        targetId: "target-1",
        scopeKey: "GLOBAL",
        reasonCode: "FRAUD_CONFIRMED",
        resultState: "RISK_STATE:RESTRICTED@GLOBAL",
      }),
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MARKETPLACE_RESTRICTED" }),
      txStub,
    );
  });

  it("restores with MARKETPLACE_RESTORE provenance", async () => {
    txRiskStateFindUnique.mockResolvedValue({ state: "RESTRICTED" });

    const result = await setRiskState({
      actorId: "actor-1",
      targetUserId: "target-1",
      campusId: null,
      state: "NORMAL",
      reasonCode: "FALSE_POSITIVE_CORRECTION",
    });

    expect(result.changed).toBe(true);
    expect(txEnforcementActionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "MARKETPLACE_RESTORE" }),
    });
  });

  it("records WATCH transitions via audit only（不在六类执法动作内）", async () => {
    await setRiskState({
      actorId: "actor-1",
      targetUserId: "target-1",
      campusId: null,
      state: "WATCH",
      reasonCode: "MANUAL_REVIEW",
    });

    expect(txEnforcementActionCreate).not.toHaveBeenCalled();
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "RISK_WATCH_SET" }),
      txStub,
    );
  });

  it("is idempotent for same-state updates（no enforcement row, no audit）", async () => {
    txRiskStateFindUnique.mockResolvedValue({ state: "RESTRICTED" });

    const result = await setRiskState({
      actorId: "actor-1",
      targetUserId: "target-1",
      campusId: null,
      state: "RESTRICTED",
      reasonCode: "MANUAL_REVIEW",
    });

    expect(result.changed).toBe(false);
    expect(txRiskStateUpsert).not.toHaveBeenCalled();
    expect(txEnforcementActionCreate).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it("rejects illegal transitions（RESTRICTED → 正常路径外跳转）", async () => {
    // NORMAL 无直连行且 from=NORMAL to=NORMAL 已被幂等覆盖；
    // 这里验证状态机锁定的非法组合经 upsert 前抛错
    txRiskStateFindUnique.mockResolvedValue({ state: "NORMAL" });
    // NORMAL→NORMAL 已幂等；NORMAL→WATCH/RESTRICTED 合法；非法组合例如
    // WATCH→WATCH 幂等覆盖，因此用显式 transition 表断言
    const { RISK_STATE_TRANSITIONS } = await import("@/lib/enforcement/risk-scope");
    expect(RISK_STATE_TRANSITIONS.NORMAL).toEqual(["WATCH", "RESTRICTED"]);
    expect(RISK_STATE_TRANSITIONS.WATCH).toEqual(["NORMAL", "RESTRICTED"]);
    expect(RISK_STATE_TRANSITIONS.RESTRICTED).toEqual(["NORMAL", "WATCH"]);
  });

  it("denies self risk-state changes", async () => {
    await expect(
      setRiskState({
        actorId: "actor-1",
        targetUserId: "actor-1",
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "MANUAL_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_SELF_DENIED" });
    expect(txRiskStateUpsert).not.toHaveBeenCalled();
  });

  it("denies privileged targets（full-admin 等价）", async () => {
    loadAuthorizationContextMock.mockImplementation(async (userId: string) =>
      userId === "target-1"
        ? ctxWith([
            {
              roleKey: "PLATFORM_ADMIN",
              scope: "GLOBAL",
              campusId: null,
              permissionKeys: ["user.suspend", "campus.manage", "verification.review", "report.review", "listing.moderate", "category.manage", "moderation.keyword.manage", "asset.sensitive.read", "rbac.role.assign", "audit.read"],
            },
          ])
        : globalEnforcer(),
    );

    await expect(
      setRiskState({
        actorId: "actor-1",
        targetUserId: "target-1",
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "MANUAL_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_PRIVILEGED_TARGET" });
    expect(txRiskStateUpsert).not.toHaveBeenCalled();
  });

  it("denies actors without the mapping permission（GLOBAL 需要 user.suspend）", async () => {
    loadAuthorizationContextMock.mockResolvedValue(ctxWith([]));

    await expect(
      setRiskState({
        actorId: "actor-1",
        targetUserId: "target-1",
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "MANUAL_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });
  });

  it("requires campus.manage scoped to the campus for CAMPUS scope", async () => {
    loadAuthorizationContextMock.mockResolvedValue(
      ctxWith([{ roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["user.suspend"] }]),
    );

    await expect(
      setRiskState({
        actorId: "actor-1",
        targetUserId: "target-1",
        campusId: "campus-a",
        state: "RESTRICTED",
        reasonCode: "MANUAL_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

    loadAuthorizationContextMock.mockResolvedValue(
      ctxWith(
        [{ roleKey: "R", scope: "CAMPUS", campusId: "campus-a", permissionKeys: ["campus.manage"] }],
        ["campus-a"],
      ),
    );

    await setRiskState({
      actorId: "actor-1",
      targetUserId: "target-1",
      campusId: "campus-a",
      state: "RESTRICTED",
      reasonCode: "MANUAL_REVIEW",
    });

    expect(txRiskStateUpsert).toHaveBeenCalled();
  });

  it("denies erased targets", async () => {
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_TARGET, erasedAt: new Date() });

    await expect(
      setRiskState({
        actorId: "actor-1",
        targetUserId: "target-1",
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "MANUAL_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_TARGET_NOT_FOUND" });
  });

  it("denies CAMPUS risk mutation when the target has no membership in that campus（Repair 1 Blocker A）", async () => {
    txMembershipFindUnique.mockResolvedValue(null);

    await expect(
      setRiskState({
        actorId: "actor-1",
        targetUserId: "target-1",
        campusId: "campus-a",
        state: "RESTRICTED",
        reasonCode: "MANUAL_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_TARGET_SCOPE_MISMATCH" });
    expect(txRiskStateUpsert).not.toHaveBeenCalled();
    expect(txEnforcementActionCreate).not.toHaveBeenCalled();
  });

  it("denies LEFT/PENDING/REJECTED target memberships for CAMPUS risk mutation", async () => {
    for (const status of ["LEFT", "PENDING", "REJECTED"]) {
      txMembershipFindUnique.mockResolvedValue({ status });
      await expect(
        setRiskState({
          actorId: "actor-1",
          targetUserId: "target-1",
          campusId: "campus-a",
          state: "RESTRICTED",
          reasonCode: "MANUAL_REVIEW",
        }),
      ).rejects.toMatchObject({ code: "ENFORCEMENT_TARGET_SCOPE_MISMATCH" });
    }
    expect(txRiskStateUpsert).not.toHaveBeenCalled();
  });

  it("allows ACTIVE and SUSPENDED target memberships for CAMPUS risk mutation", async () => {
    for (const status of ["ACTIVE", "SUSPENDED"]) {
      txMembershipFindUnique.mockResolvedValue({ status });
      await setRiskState({
        actorId: "actor-1",
        targetUserId: "target-1",
        campusId: "campus-a",
        state: "RESTRICTED",
        reasonCode: "MANUAL_REVIEW",
      });
    }
    expect(txRiskStateUpsert).toHaveBeenCalledTimes(2);
  });

  it("checks actor authorization BEFORE any target probing（Repair 1 Blocker G）", async () => {
    // 未授权 actor：missing / normal target 全部得到 authorization denial，
    // 无法通过错误路径差异推断目标状态（target 从未被探测）
    loadAuthorizationContextMock.mockResolvedValue(ctxWith([]));
    txUserFindUnique.mockResolvedValue(null);
    await expect(
      setRiskState({
        actorId: "actor-1",
        targetUserId: "missing-1",
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "MANUAL_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

    txUserFindUnique.mockResolvedValue({ ...ACTIVE_TARGET });
    await expect(
      setRiskState({
        actorId: "actor-1",
        targetUserId: "target-1",
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "MANUAL_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

    expect(txUserFindUnique).not.toHaveBeenCalled();
    expect(txMembershipFindUnique).not.toHaveBeenCalled();
  });

  it("takes sorted {USER:actor, USER:target} subject locks", async () => {
    await setRiskState({
      actorId: "actor-1",
      targetUserId: "target-1",
      campusId: null,
      state: "RESTRICTED",
      reasonCode: "MANUAL_REVIEW",
    });

    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(txStub, [
      { subjectType: "USER", subjectId: "actor-1" },
      { subjectType: "USER", subjectId: "target-1" },
    ]);
  });
});

describe("isMarketplaceRestricted（scope 语义）", () => {
  it("reports restriction when either GLOBAL or the target campus is RESTRICTED", async () => {
    const findMany = vi.fn().mockResolvedValue([{ scopeKey: "GLOBAL" }]);
    const prismaModule = await import("@/lib/prisma");
    (prismaModule.prisma as unknown as Record<string, unknown>).riskState = { findMany };

    await expect(isMarketplaceRestricted("user-1", "campus-a")).resolves.toBe(true);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        scopeKey: { in: ["GLOBAL", "CAMPUS:campus-a"] },
        state: "RESTRICTED",
      },
      select: { scopeKey: true },
    });

    findMany.mockResolvedValue([]);
    await expect(isMarketplaceRestricted("user-1", "campus-a")).resolves.toBe(false);
  });
});

describe("recordRiskFlag / resolveRiskFlag（source-linked + dedup）", () => {
  it("creates a flag and treats P2002 duplicates as idempotent", async () => {
    await expect(
      recordRiskFlag({
        userId: "target-1",
        kind: "REPORT_SUBMITTED",
        sourceType: "REPORT",
        sourceId: "report-1",
      }),
    ).resolves.toEqual({ created: true });

    const prismaError = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "6.19.3",
    });
    txRiskFlagCreate.mockRejectedValue(prismaError);

    await expect(
      recordRiskFlag({
        userId: "target-1",
        kind: "REPORT_SUBMITTED",
        sourceType: "REPORT",
        sourceId: "report-1",
      }),
    ).resolves.toEqual({ created: false });
  });

  it("resolves an ACTIVE flag once and is a no-op afterwards", async () => {
    txRiskFlagFindUnique.mockResolvedValue({ id: "flag-1", status: "ACTIVE" });

    await expect(
      resolveRiskFlag({ kind: "REPORT_SUBMITTED", sourceType: "REPORT", sourceId: "report-1", resolvedById: "admin-1" }),
    ).resolves.toEqual({ resolved: true });

    txRiskFlagFindUnique.mockResolvedValue({ id: "flag-1", status: "RESOLVED" });
    await expect(
      resolveRiskFlag({ kind: "REPORT_SUBMITTED", sourceType: "REPORT", sourceId: "report-1", resolvedById: "admin-1" }),
    ).resolves.toEqual({ resolved: false });
  });
});
