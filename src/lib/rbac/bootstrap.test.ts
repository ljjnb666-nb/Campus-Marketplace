import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  permissionUpsert,
  roleUpsert,
  roleFindUnique,
  roleFindUniqueOrThrow,
  permissionFindUniqueOrThrow,
  rolePermissionFindMany,
  rolePermissionDelete,
  rolePermissionUpsert,
  userFindMany,
  userRoleAssignmentFindFirst,
  userRoleAssignmentCreate,
  campusMembershipFindMany,
  campusMembershipCreate,
} = vi.hoisted(() => ({
  permissionUpsert: vi.fn(),
  roleUpsert: vi.fn(),
  roleFindUnique: vi.fn(),
  roleFindUniqueOrThrow: vi.fn(),
  permissionFindUniqueOrThrow: vi.fn(),
  rolePermissionFindMany: vi.fn(),
  rolePermissionDelete: vi.fn(),
  rolePermissionUpsert: vi.fn(),
  userFindMany: vi.fn(),
  userRoleAssignmentFindFirst: vi.fn(),
  userRoleAssignmentCreate: vi.fn(),
  campusMembershipFindMany: vi.fn(),
  campusMembershipCreate: vi.fn(),
}));

function buildClient() {
  return {
    permission: {
      upsert: permissionUpsert,
      findUniqueOrThrow: permissionFindUniqueOrThrow,
    },
    role: {
      upsert: roleUpsert,
      findUnique: roleFindUnique,
      findUniqueOrThrow: roleFindUniqueOrThrow,
    },
    rolePermission: {
      findMany: rolePermissionFindMany,
      delete: rolePermissionDelete,
      upsert: rolePermissionUpsert,
    },
    user: { findMany: userFindMany },
    userRoleAssignment: {
      findFirst: userRoleAssignmentFindFirst,
      create: userRoleAssignmentCreate,
    },
    campusMembership: {
      findMany: campusMembershipFindMany,
      create: campusMembershipCreate,
    },
  } as unknown as import("@/lib/rbac/bootstrap").RbacBootstrapClient;
}

import {
  ensureCampusMemberships,
  ensureRbacFoundation,
  syncLegacyAdminRoles,
} from "@/lib/rbac/bootstrap";

beforeEach(() => {
  permissionUpsert.mockReset().mockResolvedValue({});
  roleUpsert.mockReset().mockResolvedValue({});
  roleFindUnique.mockReset().mockResolvedValue({ id: "role-1" });
  roleFindUniqueOrThrow.mockReset().mockResolvedValue({ id: "role-1" });
  permissionFindUniqueOrThrow.mockReset().mockImplementation(async ({ where }: { where: { key: string } }) => ({
    id: `perm-${where.key}`,
  }));
  rolePermissionFindMany.mockReset().mockResolvedValue([]);
  rolePermissionDelete.mockReset().mockResolvedValue({});
  rolePermissionUpsert.mockReset().mockResolvedValue({});
  userFindMany.mockReset().mockResolvedValue([]);
  userRoleAssignmentFindFirst.mockReset().mockResolvedValue(null);
  userRoleAssignmentCreate.mockReset().mockResolvedValue({});
  campusMembershipFindMany.mockReset().mockResolvedValue([]);
  campusMembershipCreate.mockReset().mockResolvedValue({});
});

describe("ensureRbacFoundation（幂等 bootstrap）", () => {
  it("upserts every permission and the platform admin role with full grants", async () => {
    await ensureRbacFoundation(buildClient());

    expect(roleUpsert).toHaveBeenCalledTimes(1);
    expect(roleUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "PLATFORM_ADMIN" },
        update: expect.objectContaining({ scope: "GLOBAL", isSystem: true }),
      }),
    );
    // 全量 permission 授权
    expect(rolePermissionUpsert).toHaveBeenCalled();
  });

  it("prunes stale role-permission links not in the code definition", async () => {
    rolePermissionFindMany.mockResolvedValue([
      { permissionId: "perm-verification.review" },
      { permissionId: "perm-stale.permission" },
    ]);

    await ensureRbacFoundation(buildClient());

    expect(rolePermissionDelete).toHaveBeenCalledWith({
      where: { roleId_permissionId: { roleId: "role-1", permissionId: "perm-stale.permission" } },
    });
  });
});

describe("syncLegacyAdminRoles（legacy admin 迁移，幂等）", () => {
  it("creates PLATFORM_ADMIN assignments for role=ADMIN users", async () => {
    userFindMany.mockResolvedValue([{ id: "admin-1" }, { id: "admin-2" }]);

    const created = await syncLegacyAdminRoles(buildClient());

    expect(created).toBe(2);
    expect(userRoleAssignmentCreate).toHaveBeenCalledTimes(2);
    expect(userRoleAssignmentCreate).toHaveBeenCalledWith({
      data: { userId: "admin-1", roleId: "role-1", scopeKey: "GLOBAL" },
    });
  });

  it("skips admins that already hold the grant（幂等）", async () => {
    userFindMany.mockResolvedValue([{ id: "admin-1" }]);
    userRoleAssignmentFindFirst.mockResolvedValue({ id: "assignment-1" });

    const created = await syncLegacyAdminRoles(buildClient());

    expect(created).toBe(0);
    expect(userRoleAssignmentCreate).not.toHaveBeenCalled();
  });

  it("fails closed when the platform admin role has not been bootstrapped", async () => {
    roleFindUnique.mockResolvedValue(null);
    userFindMany.mockResolvedValue([{ id: "admin-1" }]);

    await expect(syncLegacyAdminRoles(buildClient())).rejects.toThrow(
      "PLATFORM_ADMIN 角色不存在，请先运行 ensureRbacFoundation",
    );
  });
});

describe("ensureCampusMemberships（membership 补齐，幂等）", () => {
  it("creates ACTIVE memberships only for users missing one", async () => {
    userFindMany.mockResolvedValue([
      { id: "user-1", campusId: "campus-a" },
      { id: "user-2", campusId: "campus-a" },
    ]);
    campusMembershipFindMany.mockResolvedValue([{ userId: "user-2", campusId: "campus-a" }]);

    const created = await ensureCampusMemberships(buildClient());

    expect(created).toBe(1);
    expect(campusMembershipCreate).toHaveBeenCalledWith({
      data: { userId: "user-1", campusId: "campus-a", status: "ACTIVE" },
    });
  });
});
