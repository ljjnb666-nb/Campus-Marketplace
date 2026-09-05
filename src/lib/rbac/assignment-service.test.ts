import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  txUserFindUnique,
  txRoleFindUnique,
  txAssignmentFindUnique,
  txAssignmentCreate,
  txAssignmentDelete,
  acquireGovernanceSubjectLock,
  recordAdminAudit,
  loadAuthorizationContextMock,
  withTransactionMock,
} = vi.hoisted(() => ({
  txUserFindUnique: vi.fn(),
  txRoleFindUnique: vi.fn(),
  txAssignmentFindUnique: vi.fn(),
  txAssignmentCreate: vi.fn(),
  txAssignmentDelete: vi.fn(),
  acquireGovernanceSubjectLock: vi.fn(),
  recordAdminAudit: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: withTransactionMock,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLock,
}));

vi.mock("@/lib/governance/admin-audit", () => ({
  recordAdminAudit,
}));

// hasPermission / requirePermissionInContext 用真实实现，仅替换 context 加载
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return {
    ...actual,
    loadAuthorizationContext: loadAuthorizationContextMock,
  };
});

import { Prisma } from "@prisma/client";
import type { AuthorizationContext } from "@/lib/rbac/service";
import { assignRole, revokeRole } from "@/lib/rbac/assignment-service";

const txStub = {
  user: { findUnique: txUserFindUnique },
  role: { findUnique: txRoleFindUnique },
  userRoleAssignment: {
    findUnique: txAssignmentFindUnique,
    create: txAssignmentCreate,
    delete: txAssignmentDelete,
  },
};

const ACTIVE_TARGET = {
  id: "target-1",
  status: "ACTIVE",
  deletedAt: null,
  erasedAt: null,
};

const PLATFORM_ADMIN_ROLE = {
  id: "role-admin",
  key: "PLATFORM_ADMIN",
  name: "平台管理员",
  scope: "GLOBAL",
  isSystem: true,
};

function ctxWith(
  grants: AuthorizationContext["grants"],
  active = true,
): AuthorizationContext {
  return {
    userId: "actor-1",
    accountActive: active,
    activeMembership: null,
    grants,
  };
}

function globalAssigner(): AuthorizationContext {
  return ctxWith([
    {
      roleKey: "PLATFORM_ADMIN",
      scope: "GLOBAL",
      campusId: null,
      permissionKeys: ["rbac.role.assign"],
    },
  ]);
}

function campusAssigner(campusId: string): AuthorizationContext {
  return ctxWith([
    {
      roleKey: "CAMPUS_MANAGER",
      scope: "CAMPUS",
      campusId,
      permissionKeys: ["rbac.role.assign"],
    },
  ]);
}

beforeEach(() => {
  withTransactionMock.mockReset().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(txStub),
  );
  txUserFindUnique.mockReset().mockResolvedValue({ ...ACTIVE_TARGET });
  txRoleFindUnique.mockReset().mockResolvedValue({ ...PLATFORM_ADMIN_ROLE });
  txAssignmentFindUnique.mockReset().mockResolvedValue(null);
  txAssignmentCreate.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "assignment-1",
    campusId: data.campusId ?? null,
    ...data,
  }));
  txAssignmentDelete.mockReset().mockResolvedValue({});
  acquireGovernanceSubjectLock.mockReset().mockResolvedValue(undefined);
  recordAdminAudit.mockReset().mockResolvedValue(undefined);
  loadAuthorizationContextMock.mockReset();
});

describe("assignRole（permissioned action，DEFAULT_DENY）", () => {
  it("denies actors without rbac.role.assign", async () => {
    loadAuthorizationContextMock.mockResolvedValue(ctxWith([]));

    await expect(
      assignRole({ actorId: "actor-1", targetUserId: "target-1", roleKey: "PLATFORM_ADMIN" }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });
    expect(txAssignmentCreate).not.toHaveBeenCalled();
  });

  it("denies self role mutation（self-escalation 面）", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());

    await expect(
      assignRole({ actorId: "actor-1", targetUserId: "actor-1", roleKey: "PLATFORM_ADMIN" }),
    ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_SELF_DENIED" });
  });

  it("denies targets whose account is not active（与注销共享 subject 锁）", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_TARGET, erasedAt: new Date() });

    await expect(
      assignRole({ actorId: "actor-1", targetUserId: "target-1", roleKey: "PLATFORM_ADMIN" }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
  });

  it("rejects a GLOBAL role grant carrying a campusId", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());

    await expect(
      assignRole({
        actorId: "actor-1",
        targetUserId: "target-1",
        roleKey: "PLATFORM_ADMIN",
        campusId: "campus-a",
      }),
    ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_INVALID_SCOPE" });
  });

  it("denies campus-scoped assigners from granting GLOBAL roles（跨校区/全局提权防护）", async () => {
    loadAuthorizationContextMock.mockResolvedValue(campusAssigner("campus-a"));

    await expect(
      assignRole({ actorId: "actor-1", targetUserId: "target-1", roleKey: "PLATFORM_ADMIN" }),
    ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_CAMPUS_MISMATCH" });
    expect(txAssignmentCreate).not.toHaveBeenCalled();
  });

  it("requires a campusId for CAMPUS roles", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());
    txRoleFindUnique.mockResolvedValue({ ...PLATFORM_ADMIN_ROLE, id: "role-cr", key: "CAMPUS_REVIEWER", scope: "CAMPUS" });

    await expect(
      assignRole({ actorId: "actor-1", targetUserId: "target-1", roleKey: "CAMPUS_REVIEWER" }),
    ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_INVALID_SCOPE" });
  });

  it("denies campus-scoped assigners operating outside their campus", async () => {
    loadAuthorizationContextMock.mockResolvedValue(campusAssigner("campus-a"));
    txRoleFindUnique.mockResolvedValue({ ...PLATFORM_ADMIN_ROLE, id: "role-cr", key: "CAMPUS_REVIEWER", scope: "CAMPUS" });

    await expect(
      assignRole({
        actorId: "actor-1",
        targetUserId: "target-1",
        roleKey: "CAMPUS_REVIEWER",
        campusId: "campus-b",
      }),
    ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_CAMPUS_MISMATCH" });
  });

  it("creates a GLOBAL assignment with audit on success", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());

    const result = await assignRole({
      actorId: "actor-1",
      targetUserId: "target-1",
      roleKey: "PLATFORM_ADMIN",
    });

    expect(result.created).toBe(true);
    expect(txAssignmentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "target-1",
        roleId: "role-admin",
        campusId: null,
        scopeKey: "GLOBAL",
        assignedById: "actor-1",
      }),
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "actor-1",
        action: "ROLE_ASSIGNED",
        targetType: "USER",
        targetId: "target-1",
        metadata: { roleKey: "PLATFORM_ADMIN" },
      }),
      txStub,
    );
  });

  it("is idempotent for duplicate assignments（不产生重复行、不重复审计）", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());
    txAssignmentFindUnique.mockResolvedValue({ id: "existing-1" });

    const result = await assignRole({
      actorId: "actor-1",
      targetUserId: "target-1",
      roleKey: "PLATFORM_ADMIN",
    });

    expect(result.created).toBe(false);
    expect(txAssignmentCreate).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it("treats concurrent duplicate inserts (P2002) as idempotent success", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());
    const prismaError = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "6.19.3",
    });
    txAssignmentCreate.mockRejectedValue(prismaError);
    // 冲突后重读返回对方事务已创建的行（锁内重读语义）
    txAssignmentFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "raced-1" });

    const result = await assignRole({
      actorId: "actor-1",
      targetUserId: "target-1",
      roleKey: "PLATFORM_ADMIN",
    });

    expect(result).toMatchObject({ created: false, assignment: { id: "raced-1" } });
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it("fails closed on unknown roles", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());
    txRoleFindUnique.mockResolvedValue(null);

    await expect(
      assignRole({ actorId: "actor-1", targetUserId: "target-1", roleKey: "GHOST_ROLE" }),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("takes the subject governance lock on the target user（锁序）", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());

    await assignRole({
      actorId: "actor-1",
      targetUserId: "target-1",
      roleKey: "PLATFORM_ADMIN",
    });

    expect(acquireGovernanceSubjectLock).toHaveBeenCalledWith(txStub, "USER", "target-1");
  });
});

describe("revokeRole（幂等）", () => {
  it("removes an existing assignment with audit", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());
    txAssignmentFindUnique.mockResolvedValue({ id: "existing-1", campusId: null });

    const result = await revokeRole({
      actorId: "actor-1",
      targetUserId: "target-1",
      roleKey: "PLATFORM_ADMIN",
      campusId: null,
    });

    expect(result.removed).toBe(true);
    expect(txAssignmentDelete).toHaveBeenCalledWith({ where: { id: "existing-1" } });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ROLE_REVOKED" }),
      txStub,
    );
  });

  it("is a no-op without audit when the role is not assigned", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());
    txAssignmentFindUnique.mockResolvedValue(null);

    const result = await revokeRole({
      actorId: "actor-1",
      targetUserId: "target-1",
      roleKey: "PLATFORM_ADMIN",
      campusId: null,
    });

    expect(result.removed).toBe(false);
    expect(txAssignmentDelete).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it("denies self revocation", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());

    await expect(
      revokeRole({ actorId: "actor-1", targetUserId: "actor-1", roleKey: "PLATFORM_ADMIN", campusId: null }),
    ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_SELF_DENIED" });
  });

  it("propagates stable error codes for invalid scope", async () => {
    loadAuthorizationContextMock.mockResolvedValue(globalAssigner());
    txRoleFindUnique.mockResolvedValue({
      ...PLATFORM_ADMIN_ROLE,
      id: "role-cr",
      key: "CAMPUS_REVIEWER",
      scope: "CAMPUS",
    });

    await expect(
      revokeRole({ actorId: "actor-1", targetUserId: "target-1", roleKey: "CAMPUS_REVIEWER" }),
    ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_INVALID_SCOPE" });
  });

  it("allows campus-scoped assigners to grant the campus role inside their campus", async () => {
    loadAuthorizationContextMock.mockResolvedValue(campusAssigner("campus-a"));
    txRoleFindUnique.mockResolvedValue({
      ...PLATFORM_ADMIN_ROLE,
      id: "role-cr",
      key: "CAMPUS_REVIEWER",
      scope: "CAMPUS",
    });

    const result = await assignRole({
      actorId: "actor-1",
      targetUserId: "target-1",
      roleKey: "CAMPUS_REVIEWER",
      campusId: "campus-a",
    });

    expect(result.created).toBe(true);
    expect(txAssignmentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopeKey: "CAMPUS:campus-a",
        campusId: "campus-a",
      }),
    });
  });
});
