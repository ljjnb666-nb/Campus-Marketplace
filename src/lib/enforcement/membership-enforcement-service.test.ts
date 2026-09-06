import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  txUserFindUnique,
  txMembershipFindUnique,
  txMembershipUpdate,
  txEnforcementActionCreate,
  acquireGovernanceSubjectLocks,
  recordAdminAudit,
  loadAuthorizationContextMock,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  txUserFindUnique: vi.fn(),
  txMembershipFindUnique: vi.fn(),
  txMembershipUpdate: vi.fn(),
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

vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return {
    ...actual,
    loadAuthorizationContext: loadAuthorizationContextMock,
  };
});

import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  reinstateCampusMembership,
  suspendCampusMembership,
} from "@/lib/enforcement/membership-enforcement-service";

const txStub = {
  user: { findUnique: txUserFindUnique },
  campusMembership: { findUnique: txMembershipFindUnique, update: txMembershipUpdate },
  enforcementAction: { create: txEnforcementActionCreate },
};

const ACTIVE_TARGET = { id: "target-1", deletedAt: null, erasedAt: null };

function campusManager(campusId: string): AuthorizationContext {
  return {
    userId: "actor-1",
    accountActive: true,
    activeCampusIds: [campusId],
    grants: [
      {
        roleKey: "CAMPUS_MANAGER",
        scope: "CAMPUS",
        campusId,
        permissionKeys: ["campus.manage"],
      },
    ],
  };
}

const BASE_INPUT = {
  actorId: "actor-1",
  targetUserId: "target-1",
  campusId: "campus-a",
  reasonCode: "POLICY_VIOLATION",
};

beforeEach(() => {
  withTransactionMock
    .mockReset()
    .mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub));
  txUserFindUnique.mockReset().mockResolvedValue({ ...ACTIVE_TARGET });
  txMembershipFindUnique.mockReset().mockResolvedValue({ id: "m-1", status: "ACTIVE" });
  txMembershipUpdate.mockReset().mockResolvedValue({});
  txEnforcementActionCreate.mockReset().mockResolvedValue({});
  acquireGovernanceSubjectLocks.mockReset().mockResolvedValue(undefined);
  recordAdminAudit.mockReset().mockResolvedValue(undefined);
  loadAuthorizationContextMock.mockReset().mockResolvedValue(campusManager("campus-a"));
});

describe("suspendCampusMembership（校园成员停用）", () => {
  it("suspends an ACTIVE membership with provenance and audit", async () => {
    const result = await suspendCampusMembership(BASE_INPUT);

    expect(result).toEqual({ status: "SUSPENDED", alreadyInState: false });
    expect(txMembershipUpdate).toHaveBeenCalledWith({
      where: { id: "m-1" },
      data: { status: "SUSPENDED" },
    });
    expect(txEnforcementActionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "MEMBERSHIP_SUSPEND",
        campusId: "campus-a",
        scopeKey: "CAMPUS:campus-a",
        resultState: "CAMPUS_MEMBERSHIP:SUSPENDED",
      }),
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SUSPEND_CAMPUS_MEMBERSHIP", campusId: "campus-a" }),
      txStub,
    );
  });

  it("is idempotent when already suspended", async () => {
    txMembershipFindUnique.mockResolvedValue({ id: "m-1", status: "SUSPENDED" });

    const result = await suspendCampusMembership(BASE_INPUT);

    expect(result).toEqual({ status: "SUSPENDED", alreadyInState: true });
    expect(txMembershipUpdate).not.toHaveBeenCalled();
  });

  it("fails closed for LEFT / REJECTED / PENDING memberships（#26）", async () => {
    for (const status of ["LEFT", "REJECTED", "PENDING"] as const) {
      txMembershipFindUnique.mockResolvedValue({ id: "m-1", status });
      await expect(suspendCampusMembership(BASE_INPUT)).rejects.toMatchObject({
        code: "ENFORCEMENT_INVALID_TRANSITION",
      });
    }
    expect(txMembershipUpdate).not.toHaveBeenCalled();
  });

  it("denies cross-campus managers（campus-B manager cannot suspend campus-A membership）", async () => {
    loadAuthorizationContextMock.mockResolvedValue(campusManager("campus-b"));

    await expect(suspendCampusMembership(BASE_INPUT)).rejects.toMatchObject({
      code: "AUTH_CAMPUS_SCOPE_MISMATCH",
    });
    expect(txMembershipUpdate).not.toHaveBeenCalled();
  });

  it("denies campus managers without an ACTIVE membership in the campus（6A 语义集成）", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "actor-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [
        {
          roleKey: "CAMPUS_MANAGER",
          scope: "CAMPUS",
          campusId: "campus-a",
          permissionKeys: ["campus.manage"],
        },
      ],
    });

    await expect(suspendCampusMembership(BASE_INPUT)).rejects.toMatchObject({
      code: "AUTH_CAMPUS_SCOPE_MISMATCH",
    });
  });

  it("allows GLOBAL campus.manage holders to act cross-campus", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "actor-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [
        {
          roleKey: "PLATFORM_ADMIN",
          scope: "GLOBAL",
          campusId: null,
          permissionKeys: ["campus.manage"],
        },
      ],
    });

    const result = await suspendCampusMembership(BASE_INPUT);

    expect(result.status).toBe("SUSPENDED");
  });

  it("denies self enforcement", async () => {
    await expect(
      suspendCampusMembership({ ...BASE_INPUT, targetUserId: "actor-1" }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_SELF_DENIED" });
  });

  it("preserves verification evidence（#27：停用不触碰认证记录）", async () => {
    await suspendCampusMembership(BASE_INPUT);

    // tx stub 上没有 userVerification 模型：一旦 service 试图写入即抛错
    expect(txMembershipUpdate).toHaveBeenCalled();
    expect(txUserFindUnique).toHaveBeenCalledTimes(1);
  });
});

describe("reinstateCampusMembership（校园成员恢复）", () => {
  it("reinstates a SUSPENDED membership", async () => {
    txMembershipFindUnique.mockResolvedValue({ id: "m-1", status: "SUSPENDED" });

    const result = await reinstateCampusMembership({
      ...BASE_INPUT,
      reasonCode: "FALSE_POSITIVE_CORRECTION",
    });

    expect(result).toEqual({ status: "ACTIVE", alreadyInState: false });
    expect(txEnforcementActionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "MEMBERSHIP_REINSTATE", reasonCode: "FALSE_POSITIVE_CORRECTION" }),
    });
  });

  it("fails closed for LEFT / REJECTED / PENDING（#52）", async () => {
    for (const status of ["LEFT", "REJECTED", "PENDING"] as const) {
      txMembershipFindUnique.mockResolvedValue({ id: "m-1", status });
      await expect(reinstateCampusMembership(BASE_INPUT)).rejects.toMatchObject({
        code: "ENFORCEMENT_INVALID_TRANSITION",
      });
    }
    expect(txMembershipUpdate).not.toHaveBeenCalled();
  });

  it("is idempotent when already ACTIVE", async () => {
    const result = await reinstateCampusMembership(BASE_INPUT);

    expect(result).toEqual({ status: "ACTIVE", alreadyInState: true });
    expect(txMembershipUpdate).not.toHaveBeenCalled();
  });

  it("denies cross-campus managers", async () => {
    loadAuthorizationContextMock.mockResolvedValue(campusManager("campus-b"));

    await expect(reinstateCampusMembership(BASE_INPUT)).rejects.toMatchObject({
      code: "AUTH_CAMPUS_SCOPE_MISMATCH",
    });
  });
});
