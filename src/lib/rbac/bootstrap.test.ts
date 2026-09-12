import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

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
  userFindUnique,
  userRoleAssignmentFindFirst,
  userRoleAssignmentCreate,
  campusFindUnique,
  campusMembershipFindMany,
  campusMembershipFindUnique,
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
  userFindUnique: vi.fn(),
  userRoleAssignmentFindFirst: vi.fn(),
  userRoleAssignmentCreate: vi.fn(),
  campusFindUnique: vi.fn(),
  campusMembershipFindMany: vi.fn(),
  campusMembershipFindUnique: vi.fn(),
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
    user: { findMany: userFindMany, findUnique: userFindUnique },
    userRoleAssignment: {
      findFirst: userRoleAssignmentFindFirst,
      create: userRoleAssignmentCreate,
    },
    campus: { findUnique: campusFindUnique },
    campusMembership: {
      findMany: campusMembershipFindMany,
      findUnique: campusMembershipFindUnique,
      create: campusMembershipCreate,
    },
  } as unknown as import("@/lib/rbac/bootstrap").RbacBootstrapClient;
}

import {
  ensureCampusMemberships,
  ensureRbacFoundation,
  syncLegacyAdminRoles,
} from "@/lib/rbac/bootstrap";
import { SYSTEM_ROLES } from "@/lib/rbac/roles";

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
  userFindUnique.mockReset().mockResolvedValue({ id: "user-1" });
  userRoleAssignmentFindFirst.mockReset().mockResolvedValue(null);
  userRoleAssignmentCreate.mockReset().mockResolvedValue({});
  campusFindUnique.mockReset().mockResolvedValue({ id: "campus-a" });
  campusMembershipFindMany.mockReset().mockResolvedValue([]);
  campusMembershipFindUnique.mockReset().mockResolvedValue(null);
  campusMembershipCreate.mockReset().mockResolvedValue({});
});

describe("ensureRbacFoundation（幂等 bootstrap）", () => {
  it("upserts every permission and every system role（7A：PLATFORM_ADMIN + CAMPUS_APPEAL_REVIEWER）", async () => {
    await ensureRbacFoundation(buildClient());

    expect(roleUpsert).toHaveBeenCalledTimes(SYSTEM_ROLES.length);
    expect(roleUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "PLATFORM_ADMIN" },
        update: expect.objectContaining({ scope: "GLOBAL", isSystem: true }),
      }),
    );
    expect(roleUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "CAMPUS_APPEAL_REVIEWER" },
        update: expect.objectContaining({ scope: "CAMPUS", isSystem: true }),
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

  it("skips users whose (userId, campusId) membership already exists in any status（不 rehabilitate）", async () => {
    userFindMany.mockResolvedValue([
      { id: "user-1", campusId: "campus-a" },
      { id: "user-2", campusId: "campus-a" },
    ]);
    // SUSPENDED / LEFT 均视为已存在：bootstrap 不补建、不改写状态
    campusMembershipFindMany.mockResolvedValue([
      { userId: "user-1", campusId: "campus-a" },
      { userId: "user-2", campusId: "campus-a" },
    ]);

    const created = await ensureCampusMemberships(buildClient());

    expect(created).toBe(0);
    expect(campusMembershipCreate).not.toHaveBeenCalled();
    // 窄类型不存在 update/upsert —— 结构上保证不可能 rehabilitate
  });
});

describe("ensureCampusMemberships 并发收敛（convergent bootstrap）", () => {
  const TARGET_KEY = { userId: "user-1", campusId: "campus-a" };

  function membershipFindUniqueDefault() {
    campusMembershipFindUnique.mockImplementation(async ({ where }: { where: { userId_campusId: typeof TARGET_KEY } }) => {
      if (
        where.userId_campusId.userId === TARGET_KEY.userId &&
        where.userId_campusId.campusId === TARGET_KEY.campusId
      ) {
        return { status: "ACTIVE" };
      }
      return null;
    });
  }

  it("Test A: P2002(userId,campusId) + recheck exact membership exists → 幂等 resolve", async () => {
    userFindMany.mockResolvedValue([{ id: "user-1", campusId: "campus-a" }]);
    campusMembershipCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["userId", "campusId"] },
      }),
    );
    membershipFindUniqueDefault();

    const created = await ensureCampusMemberships(buildClient());

    expect(created).toBe(0);
    expect(campusMembershipFindUnique).toHaveBeenCalledWith({
      where: { userId_campusId: { userId: "user-1", campusId: "campus-a" } },
      select: { status: true },
    });
  });

  it("Test A2: P2002 赢家行即使 SUSPENDED 也只幂等收敛，绝不改写状态", async () => {
    userFindMany.mockResolvedValue([{ id: "user-1", campusId: "campus-a" }]);
    campusMembershipCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["userId", "campusId"] },
      }),
    );
    campusMembershipFindUnique.mockResolvedValue({ status: "SUSPENDED" });

    await expect(ensureCampusMemberships(buildClient())).resolves.toBe(0);
    // 只有 findUnique 复查，无任何写路径（client 类型无 update/upsert）
    expect(campusMembershipCreate).toHaveBeenCalledTimes(1);
  });

  it("Test B: P2002 + recheck exact membership 仍不存在 → rethrow 原错误", async () => {
    userFindMany.mockResolvedValue([{ id: "user-1", campusId: "campus-a" }]);
    const original = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["userId", "campusId"] },
    });
    campusMembershipCreate.mockRejectedValue(original);
    campusMembershipFindUnique.mockResolvedValue(null);

    await expect(ensureCampusMemberships(buildClient())).rejects.toBe(original);
  });

  it("Test C: 无关唯一约束的 P2002 → rethrow（不吞）", async () => {
    userFindMany.mockResolvedValue([{ id: "user-1", campusId: "campus-a" }]);
    const unrelated = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["email"] },
    });
    campusMembershipCreate.mockRejectedValue(unrelated);

    await expect(ensureCampusMemberships(buildClient())).rejects.toBe(unrelated);
    expect(campusMembershipFindUnique).not.toHaveBeenCalled();
  });

  it("Test C2: 约束名字符串形态的 P2002(target 含两字段) 也被识别为预期目标", async () => {
    userFindMany.mockResolvedValue([{ id: "user-1", campusId: "campus-a" }]);
    campusMembershipCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: "CampusMembership_userId_campusId_key" },
      }),
    );
    campusMembershipFindUnique.mockResolvedValue({ status: "ACTIVE" });

    await expect(ensureCampusMemberships(buildClient())).resolves.toBe(0);
  });

  it("Test D: 非 P2002 错误 → rethrow", async () => {
    userFindMany.mockResolvedValue([{ id: "user-1", campusId: "campus-a" }]);
    const boom = new Error("db down");
    campusMembershipCreate.mockRejectedValue(boom);

    await expect(ensureCampusMemberships(buildClient())).rejects.toBe(boom);
  });

  it("Test E: P2003 + candidate user 已被并发删除 → STALE_BOOTSTRAP_SNAPSHOT no-op", async () => {
    userFindMany.mockResolvedValue([{ id: "user-1", campusId: "campus-a" }]);
    campusMembershipCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
        code: "P2003",
        clientVersion: "test",
      }),
    );
    userFindUnique.mockResolvedValue(null);

    await expect(ensureCampusMemberships(buildClient())).resolves.toBe(0);
    expect(userFindUnique).toHaveBeenCalledWith({ where: { id: "user-1" }, select: { id: true } });
  });

  it("Test E2: P2003 + user 仍在但 campus 已被删 → 同为 stale snapshot no-op", async () => {
    userFindMany.mockResolvedValue([{ id: "user-1", campusId: "campus-a" }]);
    campusMembershipCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
        code: "P2003",
        clientVersion: "test",
      }),
    );
    campusFindUnique.mockResolvedValue(null);

    await expect(ensureCampusMemberships(buildClient())).resolves.toBe(0);
  });

  it("Test F: P2003 + user 与 campus 均仍存在 → rethrow（真实完整性问题）", async () => {
    userFindMany.mockResolvedValue([{ id: "user-1", campusId: "campus-a" }]);
    const original = new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
      code: "P2003",
      clientVersion: "test",
    });
    campusMembershipCreate.mockRejectedValue(original);
    // beforeEach 默认 user/campus 均存在

    await expect(ensureCampusMemberships(buildClient())).rejects.toBe(original);
  });

  it("seam（testing-only）：afterSnapshot 在快照后、写入前执行一次", async () => {
    userFindMany.mockResolvedValue([{ id: "user-1", campusId: "campus-a" }]);
    const order: string[] = [];
    campusMembershipFindMany.mockImplementation(async () => {
      order.push("snapshot");
      return [];
    });
    campusMembershipCreate.mockImplementation(async () => {
      order.push("create");
      return {};
    });

    await ensureCampusMemberships(buildClient(), {
      afterSnapshot: async () => {
        order.push("seam");
      },
    });

    expect(order).toEqual(["snapshot", "seam", "create"]);
  });
});
