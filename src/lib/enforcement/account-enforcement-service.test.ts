import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  txUserFindUnique,
  txUserUpdate,
  txEnforcementActionCreate,
  acquireGovernanceSubjectLocks,
  recordAdminAudit,
  loadAuthorizationContextMock,
  isPrivilegedTargetMock,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  txUserFindUnique: vi.fn(),
  txUserUpdate: vi.fn(),
  txEnforcementActionCreate: vi.fn(),
  acquireGovernanceSubjectLocks: vi.fn(),
  recordAdminAudit: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  isPrivilegedTargetMock: vi.fn(),
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

const { createNotification } = vi.hoisted(() => ({
  createNotification: vi.fn(),
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotification,
}));

// isPrivilegedTarget / hasPermission 用真实实现，仅替换 context 加载
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return {
    ...actual,
    loadAuthorizationContext: loadAuthorizationContextMock,
    isPrivilegedTarget: isPrivilegedTargetMock,
  };
});

import type { AuthorizationContext } from "@/lib/rbac/service";
import { reinstateAccount, suspendAccount } from "@/lib/enforcement/account-enforcement-service";

const txStub = {
  user: { findUnique: txUserFindUnique, update: txUserUpdate },
  enforcementAction: { create: txEnforcementActionCreate },
};

const ACTIVE_TARGET = { id: "target-1", status: "ACTIVE", deletedAt: null, erasedAt: null };

function actorWithSuspend(): AuthorizationContext {
  return {
    userId: "actor-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [
      {
        roleKey: "PLATFORM_ADMIN",
        scope: "GLOBAL",
        campusId: null,
        permissionKeys: ["user.suspend"],
      },
    ],
  };
}

const BASE_INPUT = {
  actorId: "actor-1",
  targetUserId: "target-1",
  reasonCode: "MANUAL_REVIEW",
};

beforeEach(() => {
  withTransactionMock
    .mockReset()
    .mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub));
  txUserFindUnique.mockReset().mockResolvedValue({ ...ACTIVE_TARGET });
  txUserUpdate.mockReset().mockResolvedValue({});
  txEnforcementActionCreate.mockReset().mockResolvedValue({});
  acquireGovernanceSubjectLocks.mockReset().mockResolvedValue(undefined);
  recordAdminAudit.mockReset().mockResolvedValue(undefined);
  createNotification.mockReset().mockResolvedValue({});
  loadAuthorizationContextMock.mockReset().mockImplementation(async (userId: string) => {
    if (userId === "actor-1") {
      return actorWithSuspend();
    }
    // 默认 target 无授权
    return {
      userId,
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    };
  });
  isPrivilegedTargetMock.mockReset().mockResolvedValue(false);
});

describe("suspendAccount（中央账号停用服务）", () => {
  it("suspends with provenance and audit", async () => {
    const result = await suspendAccount({ ...BASE_INPUT, note: "测试停用" });

    expect(result).toEqual({
      status: "SUSPENDED",
      alreadyInState: false,
      notificationDelivered: true,
    });
    expect(txUserUpdate).toHaveBeenCalledWith({
      where: { id: "target-1" },
      data: { status: "SUSPENDED" },
    });
    // 通知不再位于 authoritative transaction 内（Repair 2 Blocker C）
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(txEnforcementActionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "ACCOUNT_SUSPEND",
        actorId: "actor-1",
        targetId: "target-1",
        reasonCode: "MANUAL_REVIEW",
        resultState: "USER:SUSPENDED",
      }),
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SUSPEND_USER", targetId: "target-1" }),
      txStub,
    );
  });

  it("is idempotent when the target is already suspended（#51）", async () => {
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_TARGET, status: "SUSPENDED" });

    const result = await suspendAccount(BASE_INPUT);

    expect(result).toEqual({ status: "SUSPENDED", alreadyInState: true, notificationDelivered: false });
    expect(txUserUpdate).not.toHaveBeenCalled();
    expect(txEnforcementActionCreate).not.toHaveBeenCalled();
    // 幂等 no-op 不发送通知
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("denies self suspension", async () => {
    await expect(suspendAccount({ ...BASE_INPUT, targetUserId: "actor-1" })).rejects.toMatchObject({
      code: "ENFORCEMENT_SELF_DENIED",
    });
    expect(txUserUpdate).not.toHaveBeenCalled();
  });

  it("denies actors without user.suspend（DEFAULT_DENY）", async () => {
    loadAuthorizationContextMock.mockImplementation(async (userId: string) => ({
      userId,
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    }));

    await expect(suspendAccount(BASE_INPUT)).rejects.toMatchObject({
      code: "AUTH_PERMISSION_DENIED",
    });
    expect(txUserUpdate).not.toHaveBeenCalled();
  });

  it("denies campus-scoped user.suspend grants（账号停用是平台级动作）", async () => {
    loadAuthorizationContextMock.mockImplementation(async (userId: string) => ({
      userId,
      accountActive: true,
      activeCampusIds: ["campus-a"],
      grants: [
        {
          roleKey: "CAMPUS_SUSPENDER",
          scope: "CAMPUS",
          campusId: "campus-a",
          permissionKeys: ["user.suspend"],
        },
      ],
    }));

    await expect(suspendAccount(BASE_INPUT)).rejects.toMatchObject({
      code: "AUTH_PERMISSION_DENIED",
    });
  });

  it("denies privileged targets（RBAC full-admin 等价）", async () => {
    isPrivilegedTargetMock.mockResolvedValue(true);

    await expect(suspendAccount(BASE_INPUT)).rejects.toMatchObject({
      code: "ENFORCEMENT_PRIVILEGED_TARGET",
    });
    expect(txUserUpdate).not.toHaveBeenCalled();
    // 校验 service 检查的是目标而非 actor
    expect(isPrivilegedTargetMock).toHaveBeenCalledWith("target-1", txStub);
  });

  it("denies inactive actors inside the locks", async () => {
    loadAuthorizationContextMock.mockImplementation(async (userId: string) => ({
      userId,
      accountActive: userId !== "actor-1",
      activeCampusIds: [],
      grants:
        userId === "actor-1"
          ? actorWithSuspend().grants
          : [],
    }));

    await expect(suspendAccount(BASE_INPUT)).rejects.toMatchObject({
      code: "AUTH_ACCOUNT_INACTIVE",
    });
  });

  it("takes sorted {USER:actor, USER:target} locks（与 role grant/revoke 同一边界）", async () => {
    await suspendAccount(BASE_INPUT);

    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(txStub, [
      { subjectType: "USER", subjectId: "actor-1" },
      { subjectType: "USER", subjectId: "target-1" },
    ]);
  });
});

describe("notification failure（Repair 2 Blocker C：post-commit best effort）", () => {
  it("notification failure does not fail the suspension（status/action/audit committed）", async () => {
    createNotification.mockRejectedValue(new Error("notification subsystem down"));

    const result = await suspendAccount(BASE_INPUT);

    // command success 仅由 authoritative state transaction 决定
    expect(result).toEqual({
      status: "SUSPENDED",
      alreadyInState: false,
      notificationDelivered: false,
    });
    expect(txUserUpdate).toHaveBeenCalledWith({
      where: { id: "target-1" },
      data: { status: "SUSPENDED" },
    });
    expect(txEnforcementActionCreate).toHaveBeenCalled();
    expect(recordAdminAudit).toHaveBeenCalled();
  });

  it("notification failure does not fail the reinstatement", async () => {
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_TARGET, status: "SUSPENDED" });
    createNotification.mockRejectedValue(new Error("notification subsystem down"));

    const result = await reinstateAccount(BASE_INPUT);

    expect(result).toEqual({
      status: "ACTIVE",
      alreadyInState: false,
      notificationDelivered: false,
    });
    expect(txUserUpdate).toHaveBeenCalledWith({
      where: { id: "target-1" },
      data: { status: "ACTIVE" },
    });
    expect(txEnforcementActionCreate).toHaveBeenCalled();
  });
});

describe("reinstateAccount（中央账号恢复服务）", () => {
  it("reinstates with provenance and audit", async () => {
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_TARGET, status: "SUSPENDED" });

    const result = await reinstateAccount({
      ...BASE_INPUT,
      reasonCode: "FALSE_POSITIVE_CORRECTION",
    });

    expect(result).toEqual({
      status: "ACTIVE",
      alreadyInState: false,
      notificationDelivered: true,
    });
    expect(txUserUpdate).toHaveBeenCalledWith({
      where: { id: "target-1" },
      data: { status: "ACTIVE" },
    });
    expect(txEnforcementActionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "ACCOUNT_REINSTATE", reasonCode: "FALSE_POSITIVE_CORRECTION" }),
    });
  });

  it("is idempotent when already active", async () => {
    const result = await reinstateAccount(BASE_INPUT);

    expect(result).toEqual({ status: "ACTIVE", alreadyInState: true, notificationDelivered: false });
    expect(txUserUpdate).not.toHaveBeenCalled();
  });

  it("denies self reinstatement", async () => {
    await expect(reinstateAccount({ ...BASE_INPUT, targetUserId: "actor-1" })).rejects.toMatchObject({
      code: "ENFORCEMENT_SELF_DENIED",
    });
  });
});
