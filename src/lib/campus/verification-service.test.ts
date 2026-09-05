import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  txUserFindUnique,
  txUserUpdate,
  txVerificationUpsert,
  txVerificationFindUnique,
  txVerificationUpdate,
  txMembershipFindFirst,
  acquireGovernanceSubjectLock,
  acquireCampusVerificationPolicyLocks,
  getCurrentVerificationPolicyMock,
  resolveImageTokens,
  applyVerificationAssetRetention,
  recordAdminAudit,
  createNotification,
  loadAuthorizationContextMock,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  txUserFindUnique: vi.fn(),
  txUserUpdate: vi.fn(),
  txVerificationUpsert: vi.fn(),
  txVerificationFindUnique: vi.fn(),
  txVerificationUpdate: vi.fn(),
  txMembershipFindFirst: vi.fn(),
  acquireGovernanceSubjectLock: vi.fn(),
  acquireCampusVerificationPolicyLocks: vi.fn(),
  getCurrentVerificationPolicyMock: vi.fn(),
  resolveImageTokens: vi.fn(),
  applyVerificationAssetRetention: vi.fn(),
  recordAdminAudit: vi.fn(),
  createNotification: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: withTransactionMock,
}));

vi.mock("@/lib/upload", () => ({
  resolveImageTokens,
  applyVerificationAssetRetention,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLock,
  acquireCampusVerificationPolicyLocks,
}));

vi.mock("@/lib/governance/admin-audit", () => ({
  recordAdminAudit,
}));

vi.mock("@/lib/campus/verification-policy-service", () => ({
  getCurrentVerificationPolicy: getCurrentVerificationPolicyMock,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotification,
}));

// requirePermissionInContext / hasPermission 用真实实现，仅替换 context 加载
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return {
    ...actual,
    loadAuthorizationContext: loadAuthorizationContextMock,
  };
});

import type { Prisma } from "@prisma/client";
import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  assertVerificationTransition,
  decideMembershipVerification,
  submitMembershipVerification,
  VERIFICATION_TRANSITIONS,
} from "@/lib/campus/verification-service";

const txStub = {
  user: { findUnique: txUserFindUnique, update: txUserUpdate },
  userVerification: {
    upsert: txVerificationUpsert,
    findUnique: txVerificationFindUnique,
    update: txVerificationUpdate,
  },
  campusMembership: { findFirst: txMembershipFindFirst },
} as unknown as Prisma.TransactionClient;

const ACTIVE_USER = {
  id: "user-1",
  status: "ACTIVE",
  deletedAt: null,
  erasedAt: null,
  verificationStatus: "UNVERIFIED",
};

const ACTIVE_MEMBERSHIP = { id: "m-1", campusId: "campus-a" };

const PUBLISHED_POLICY = {
  id: "policy-1",
  version: 3,
  contentHash: "hash-abc",
};

function globalReviewer(): AuthorizationContext {
  return {
    userId: "reviewer-1",
    accountActive: true,
    activeMembership: null,
    grants: [
      {
        roleKey: "PLATFORM_ADMIN",
        scope: "GLOBAL",
        campusId: null,
        permissionKeys: ["verification.review"],
      },
    ],
  };
}

beforeEach(() => {
  withTransactionMock
    .mockReset()
    .mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(txStub),
    );
  txUserFindUnique.mockReset().mockResolvedValue({ ...ACTIVE_USER });
  txUserUpdate.mockReset().mockResolvedValue({});
  txVerificationUpsert.mockReset().mockResolvedValue({ id: "verification-1" });
  txVerificationFindUnique.mockReset().mockResolvedValue(null);
  txVerificationUpdate.mockReset().mockResolvedValue({ id: "verification-1" });
  txMembershipFindFirst.mockReset().mockResolvedValue({ ...ACTIVE_MEMBERSHIP });
  acquireGovernanceSubjectLock.mockReset().mockResolvedValue(undefined);
  acquireCampusVerificationPolicyLocks.mockReset().mockResolvedValue(undefined);
  getCurrentVerificationPolicyMock.mockReset().mockResolvedValue(PUBLISHED_POLICY);
  resolveImageTokens.mockReset().mockResolvedValue(["asset:asset-1"]);
  applyVerificationAssetRetention.mockReset().mockResolvedValue(1);
  recordAdminAudit.mockReset().mockResolvedValue(undefined);
  createNotification.mockReset().mockResolvedValue({});
  loadAuthorizationContextMock.mockReset();
});

describe("VERIFICATION_TRANSITIONS（显式状态机）", () => {
  it("allows only the documented legal transitions", () => {
    expect(VERIFICATION_TRANSITIONS.UNVERIFIED).toEqual(["PENDING"]);
    expect(VERIFICATION_TRANSITIONS.PENDING).toEqual(["VERIFIED", "REJECTED", "PENDING"]);
    expect(VERIFICATION_TRANSITIONS.REJECTED).toEqual(["PENDING"]);
    expect(VERIFICATION_TRANSITIONS.VERIFIED).toEqual(["PENDING", "REVOKED"]);
    expect(VERIFICATION_TRANSITIONS.REVOKED).toEqual(["PENDING"]);
  });

  it("rejects arbitrary status jumps", () => {
    expect(() => assertVerificationTransition("REJECTED", "VERIFIED")).toThrowError();
    expect(() => assertVerificationTransition("UNVERIFIED", "VERIFIED")).toThrowError();
    expect(() => assertVerificationTransition("PENDING", "REVOKED")).toThrowError();
    expect(() => assertVerificationTransition("REVOKED", "VERIFIED")).toThrowError();
    expect(() => assertVerificationTransition("VERIFIED", "REJECTED")).toThrowError();
  });
});

describe("submitMembershipVerification（学生侧提交）", () => {
  const input = {
    userId: "user-1",
    schoolName: "示例大学",
    campusName: "主校区",
    studentIdLast4: "1234",
    studentCardImageToken: "asset:asset-1",
  };

  it("records the policy snapshot evidence and binds the private asset", async () => {
    const result = await submitMembershipVerification(input);

    expect(acquireGovernanceSubjectLock).toHaveBeenCalledWith(txStub, "USER", "user-1");
    expect(acquireCampusVerificationPolicyLocks).toHaveBeenCalledWith(txStub, ["campus-a"]);
    expect(txVerificationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
        create: expect.objectContaining({
          membershipId: "m-1",
          status: "PENDING",
          policyId: "policy-1",
          policyVersion: 3,
          policyHash: "hash-abc",
        }),
        update: expect.objectContaining({
          status: "PENDING",
          reviewedAt: null,
          reviewedById: null,
          policyId: "policy-1",
          policyVersion: 3,
          policyHash: "hash-abc",
        }),
      }),
    );
    expect(txUserUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({ verificationStatus: "PENDING" }),
    });
    expect(resolveImageTokens).toHaveBeenCalled();
    expect(txVerificationUpdate).toHaveBeenCalledWith({
      where: { id: "verification-1" },
      data: { studentCardImage: "asset:asset-1" },
    });
    expect(createNotification).toHaveBeenCalled();
    expect(result).toEqual({ id: "verification-1" });
  });

  it("allows submissions without a published policy（证据如实记录 null）", async () => {
    getCurrentVerificationPolicyMock.mockResolvedValue(null);

    await submitMembershipVerification(input);

    expect(txVerificationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          policyId: null,
          policyVersion: null,
          policyHash: null,
        }),
      }),
    );
  });

  it("denies inactive accounts before any write（fail closed）", async () => {
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_USER, erasedAt: new Date() });

    await expect(submitMembershipVerification(input)).rejects.toMatchObject({
      code: "AUTH_ACCOUNT_INACTIVE",
    });
    expect(txVerificationUpsert).not.toHaveBeenCalled();
    expect(txUserUpdate).not.toHaveBeenCalled();
  });

  it("denies submissions without an ACTIVE membership", async () => {
    txMembershipFindFirst.mockResolvedValue(null);

    await expect(submitMembershipVerification(input)).rejects.toMatchObject({
      code: "MEMBERSHIP_NOT_ACTIVE",
    });
    expect(txVerificationUpsert).not.toHaveBeenCalled();
  });

  it("accepts resubmission from REVOKED（状态机允许的重新提交路径）", async () => {
    txVerificationFindUnique.mockResolvedValue({ status: "REVOKED" });

    await submitMembershipVerification(input);

    expect(txVerificationUpsert).toHaveBeenCalled();
  });
});

describe("decideMembershipVerification（审核决定唯一入口）", () => {
  const PENDING_VERIFICATION = {
    id: "verification-1",
    userId: "user-1",
    status: "PENDING" as const,
    policyVersion: 3,
    membership: { campusId: "campus-a" },
  };

  beforeEach(() => {
    txVerificationFindUnique.mockResolvedValue({ ...PENDING_VERIFICATION });
    loadAuthorizationContextMock.mockResolvedValue(globalReviewer());
  });

  it("approves with full evidence: decision, reviewer, audit, notification, retention", async () => {
    txVerificationUpdate.mockResolvedValue({ id: "verification-1", status: "VERIFIED" });

    const result = await decideMembershipVerification({
      actorId: "reviewer-1",
      verificationId: "verification-1",
      decision: "VERIFIED",
      reviewNote: "材料齐全",
    });

    expect(acquireGovernanceSubjectLock).toHaveBeenCalledWith(txStub, "USER", "user-1");
    expect(txVerificationUpdate).toHaveBeenCalledWith({
      where: { id: "verification-1" },
      data: expect.objectContaining({
        status: "VERIFIED",
        reviewedById: "reviewer-1",
        reviewedAt: expect.any(Date),
      }),
    });
    expect(txUserUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { verificationStatus: "VERIFIED" },
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "reviewer-1",
        action: "APPROVE_VERIFICATION",
        targetType: "USER_VERIFICATION",
        targetId: "verification-1",
        campusId: "campus-a",
        metadata: { decision: "VERIFIED", policyVersion: 3, targetUserId: "user-1" },
      }),
      txStub,
    );
    expect(createNotification).toHaveBeenCalled();
    expect(applyVerificationAssetRetention).toHaveBeenCalledWith(
      txStub,
      "verification-1",
      expect.any(Date),
    );
    expect(result).toMatchObject({ status: "VERIFIED" });
  });

  it("denies reviewers without verification.review", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "reviewer-1",
      accountActive: true,
      activeMembership: null,
      grants: [],
    });

    await expect(
      decideMembershipVerification({
        actorId: "reviewer-1",
        verificationId: "verification-1",
        decision: "VERIFIED",
      }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });
    expect(txVerificationUpdate).not.toHaveBeenCalled();
  });

  it("denies cross-campus scoped reviewers（关键安全不变量 negative test）", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "reviewer-b",
      accountActive: true,
      activeMembership: null,
      grants: [
        {
          roleKey: "CAMPUS_REVIEWER_B",
          scope: "CAMPUS",
          campusId: "campus-b",
          permissionKeys: ["verification.review"],
        },
      ],
    });

    await expect(
      decideMembershipVerification({
        actorId: "reviewer-b",
        verificationId: "verification-1",
        decision: "VERIFIED",
      }),
    ).rejects.toMatchObject({ code: "AUTH_CAMPUS_SCOPE_MISMATCH" });
    expect(txVerificationUpdate).not.toHaveBeenCalled();
  });

  it("allows campus-scoped reviewers within their own campus", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "reviewer-a",
      accountActive: true,
      activeMembership: null,
      grants: [
        {
          roleKey: "CAMPUS_REVIEWER_A",
          scope: "CAMPUS",
          campusId: "campus-a",
          permissionKeys: ["verification.review"],
        },
      ],
    });

    await decideMembershipVerification({
      actorId: "reviewer-a",
      verificationId: "verification-1",
      decision: "VERIFIED",
    });

    expect(txVerificationUpdate).toHaveBeenCalled();
  });

  it("denies self review（self-escalation 面）", async () => {
    await expect(
      decideMembershipVerification({
        actorId: "user-1",
        verificationId: "verification-1",
        decision: "VERIFIED",
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_SELF_REVIEW_DENIED" });
    expect(txVerificationUpdate).not.toHaveBeenCalled();
  });

  it("denies decisions on erased accounts（锁内复核 fail closed）", async () => {
    txUserFindUnique.mockResolvedValue({
      status: "ACTIVE",
      deletedAt: null,
      erasedAt: new Date(),
    });

    await expect(
      decideMembershipVerification({
        actorId: "reviewer-1",
        verificationId: "verification-1",
        decision: "VERIFIED",
      }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
    expect(txVerificationUpdate).not.toHaveBeenCalled();
  });

  it("rejects an illegal transition（double decision 的最终一致性来源）", async () => {
    txVerificationFindUnique.mockResolvedValue({ ...PENDING_VERIFICATION, status: "REJECTED" });

    await expect(
      decideMembershipVerification({
        actorId: "reviewer-1",
        verificationId: "verification-1",
        decision: "VERIFIED",
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_INVALID_TRANSITION" });
    expect(txVerificationUpdate).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it("supports revocation from VERIFIED with the dedicated audit action", async () => {
    txVerificationFindUnique.mockResolvedValue({ ...PENDING_VERIFICATION, status: "VERIFIED" });
    txVerificationUpdate.mockResolvedValue({ id: "verification-1", status: "REVOKED" });

    await decideMembershipVerification({
      actorId: "reviewer-1",
      verificationId: "verification-1",
      decision: "REVOKED",
      reviewNote: "材料造假",
      reasonCode: "VERIFICATION_FRAUD",
    });

    expect(txVerificationUpdate).toHaveBeenCalledWith({
      where: { id: "verification-1" },
      data: expect.objectContaining({
        status: "REVOKED",
        reasonCode: "VERIFICATION_FRAUD",
      }),
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "REVOKE_VERIFICATION" }),
      txStub,
    );
  });

  it("runs the racePoint seam after checks and before the write（并发测试契约）", async () => {
    const order: string[] = [];
    txVerificationUpdate.mockImplementation(async () => {
      order.push("write");
      return { id: "verification-1", status: "VERIFIED" };
    });

    await decideMembershipVerification({
      actorId: "reviewer-1",
      verificationId: "verification-1",
      decision: "VERIFIED",
      racePoint: async () => {
        order.push("race-point");
      },
    });

    expect(order).toEqual(["race-point", "write"]);
  });
});
