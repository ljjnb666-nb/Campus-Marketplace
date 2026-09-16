import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 7D RBAC/迁移基础集成测试（真实 PostgreSQL）。
 *
 * 覆盖（实现指令 §27 M01..M09 + §28 R1-03/R1-06）：
 *  - M03：rerun 收敛语义（重复执行迁移 INSERT → 计数不变）；
 *  - M04/M05/M06：Permission enforcement.read 恰好一条；PLATFORM_ADMIN
 *    RolePermission 恰好一条；零其他角色持有 enforcement.read；
 *  - M07：ensureRbacFoundation 收敛后零语义漂移（permission 集 =
 *    PERMISSION_KEYS；PLATFORM_ADMIN 授权集与代码定义一致）；
 *  - M08：legacy admin 等价不变（exact 11-key GLOBAL → true；
 *    缺任一 legacy key → false）；
 *  - M09：两个 additive 审计索引存在；
 *  - R1-03：PLATFORM_ADMIN 上下文 hasPermission("enforcement.read") = true；
 *  - R1-06：isPrivilegedTarget 不因 enforcement.read 改变（仅 enforcement.read
 *    的 GLOBAL 用户 false；legacy 全量用户 true）。
 *
 * M01 fresh / M02 upgrade 由 CI 的两遍 `prisma migrate deploy`（fresh 库 →
 * upgrade → rerun）结构性覆盖；本文件断言其最终收敛状态。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p7d-rbac-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");
const ENFORCEMENT_READ_DESCRIPTION = "读取执法记录与账户限制状态（治理运营可见性）";

const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdCampusIds: string[] = [];

describe.skipIf(!integrationDatabaseUrl)("Phase 7D RBAC/迁移基础（真实 PostgreSQL）", () => {
  beforeAll(async () => {
    if (!rawClient) {
      return;
    }
    const campus = await rawClient.campus.create({
      data: { name: "7D-RBAC校区", slug: `${RUN_TAG}-campus`, schoolName: "集成测试大学" },
    });
    createdCampusIds.push(campus.id);
  });

  afterAll(async () => {
    if (!rawClient) {
      return;
    }
    await rawClient.userRoleAssignment.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
    await rawClient.role.deleteMany({ where: { id: { in: createdRoleIds } } });
    await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
    await rawClient.$disconnect();
  });

  async function createFixtureUser(name: string) {
    const user = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-${createdUserIds.length}@it.local`,
        name,
        passwordHash: FIXTURE_PASSWORD_HASH,
        schoolName: "集成测试大学",
        campusId: createdCampusIds[0],
        role: "STUDENT",
      },
    });
    createdUserIds.push(user.id);
    await rawClient!.campusMembership.create({
      data: { userId: user.id, campusId: createdCampusIds[0], status: "ACTIVE" },
    });
    return user;
  }

  async function createCustomRole(
    name: string,
    scope: "GLOBAL" | "CAMPUS",
    permissionKeys: string[],
  ) {
    const role = await rawClient!.role.create({
      data: {
        key: `${RUN_TAG}-${name}`,
        name,
        scope,
        isSystem: false,
        rolePermissions: {
          create: permissionKeys.map((key) => ({ permission: { connect: { key } } })),
        },
      },
    });
    createdRoleIds.push(role.id);
    return role;
  }

  it("M04/M05/M06：enforcement.read permission 恰好一条，PLATFORM_ADMIN 授权恰好一条，零其他角色", async () => {
    const permissions = await rawClient!.permission.findMany({
      where: { key: "enforcement.read" },
    });
    expect(permissions).toHaveLength(1);
    expect(permissions[0].description).toBe(ENFORCEMENT_READ_DESCRIPTION);

    const grants = await rawClient!.rolePermission.findMany({
      where: { permission: { key: "enforcement.read" } },
      include: { role: { select: { key: true } } },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].role.key).toBe("PLATFORM_ADMIN");
  });

  it("M03：迁移 rerun 收敛（重复 INSERT 语义 → 计数不变）", async () => {
    const before = await rawClient!.rolePermission.count({
      where: { permission: { key: "enforcement.read" } },
    });

    await rawClient!.$executeRaw`
      INSERT INTO "Permission" ("id", "key", "description", "createdAt")
      VALUES ('pm_' || md5('enforcement.read'), 'enforcement.read', ${ENFORCEMENT_READ_DESCRIPTION}, CURRENT_TIMESTAMP)
      ON CONFLICT ("key") DO NOTHING`;
    await rawClient!.$executeRaw`
      INSERT INTO "RolePermission" ("roleId", "permissionId")
      SELECT r."id", p."id"
      FROM "Role" r
      JOIN "Permission" p ON p."key" = 'enforcement.read'
      WHERE r."key" = 'PLATFORM_ADMIN'
      ON CONFLICT ("roleId", "permissionId") DO NOTHING`;

    const after = await rawClient!.rolePermission.count({
      where: { permission: { key: "enforcement.read" } },
    });
    expect(after).toBe(before);
    expect(after).toBe(1);
    expect(
      await rawClient!.permission.count({ where: { key: "enforcement.read" } }),
    ).toBe(1);
  });

  it("M07：ensureRbacFoundation 收敛后零语义漂移", async () => {
    const { PERMISSION_KEYS } = await import("@/lib/rbac/permissions");
    const { ensureRbacFoundation } = await import("@/lib/rbac/bootstrap");

    const beforeKeys = (
      await rawClient!.permission.findMany({ select: { key: true } })
    ).map((row) => row.key).sort();
    const adminRole = await rawClient!.role.findUniqueOrThrow({
      where: { key: "PLATFORM_ADMIN" },
      select: { id: true },
    });
    const beforeGrants = (
      await rawClient!.rolePermission.findMany({
        where: { roleId: adminRole.id },
        include: { permission: { select: { key: true } } },
      })
    ).map((row) => row.permission.key).sort();

    await ensureRbacFoundation(rawClient!);

    const afterKeys = (
      await rawClient!.permission.findMany({ select: { key: true } })
    ).map((row) => row.key).sort();
    const afterGrants = (
      await rawClient!.rolePermission.findMany({
        where: { roleId: adminRole.id },
        include: { permission: { select: { key: true } } },
      })
    ).map((row) => row.permission.key).sort();

    // 收敛不改变任何语义：permission 集 = 代码全集；PLATFORM_ADMIN 授权集不变
    expect(afterKeys).toEqual([...PERMISSION_KEYS].sort());
    expect(beforeKeys).toEqual(afterKeys);
    expect(beforeGrants).toEqual(afterGrants);
    expect(afterGrants).toEqual([...PERMISSION_KEYS].sort());
  });

  it("M08/R1-03：PLATFORM_ADMIN 上下文 → legacy 等价 true 且持有 enforcement.read", async () => {
    const adminUser = await createFixtureUser("平台管理员");
    const adminRole = await rawClient!.role.findUniqueOrThrow({
      where: { key: "PLATFORM_ADMIN" },
      select: { id: true },
    });
    await rawClient!.userRoleAssignment.create({
      data: { userId: adminUser.id, roleId: adminRole.id, campusId: null, scopeKey: "GLOBAL" },
    });

    const { loadAuthorizationContext, hasFullAdminSurfaceAccess, hasPermission, isPrivilegedTarget } =
      await import("@/lib/rbac/service");

    const context = await loadAuthorizationContext(adminUser.id);
    expect(context).not.toBeNull();
    expect(hasFullAdminSurfaceAccess(context)).toBe(true);
    expect(hasPermission(context, "enforcement.read")).toBe(true);
    expect(await isPrivilegedTarget(adminUser.id)).toBe(true);
  });

  it("M08/R1-06：exact 11-key GLOBAL → 等价 true；仅 enforcement.read → false 且非特权目标", async () => {
    const exactLegacyUser = await createFixtureUser("legacy11");
    const legacyRole = await createCustomRole("LEGACY11", "GLOBAL", [
      "verification.review",
      "report.review",
      "listing.moderate",
      "category.manage",
      "moderation.keyword.manage",
      "user.suspend",
      "appeal.review",
      "asset.sensitive.read",
      "campus.manage",
      "rbac.role.assign",
      "audit.read",
    ]);
    await rawClient!.userRoleAssignment.create({
      data: { userId: exactLegacyUser.id, roleId: legacyRole.id, campusId: null, scopeKey: "GLOBAL" },
    });

    const readerUser = await createFixtureUser("reader-only");
    const readerRole = await createCustomRole("READER", "GLOBAL", ["enforcement.read"]);
    await rawClient!.userRoleAssignment.create({
      data: { userId: readerUser.id, roleId: readerRole.id, campusId: null, scopeKey: "GLOBAL" },
    });

    const { loadAuthorizationContext, hasFullAdminSurfaceAccess, isPrivilegedTarget } =
      await import("@/lib/rbac/service");

    const legacyContext = await loadAuthorizationContext(exactLegacyUser.id);
    expect(hasFullAdminSurfaceAccess(legacyContext)).toBe(true);
    expect(await isPrivilegedTarget(exactLegacyUser.id)).toBe(true);

    const readerContext = await loadAuthorizationContext(readerUser.id);
    expect(hasFullAdminSurfaceAccess(readerContext)).toBe(false);
    expect(await isPrivilegedTarget(readerUser.id)).toBe(false);
  });

  it("M09：两个 additive 审计索引存在", async () => {
    const indexes = await rawClient!.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'AdminLog'`;
    const names = indexes.map((row) => row.indexname);
    expect(names).toContain("AdminLog_campusId_createdAt_id_idx");
    expect(names).toContain("AdminLog_createdAt_id_idx");
  });
});
