import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p10d-rbac-${randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
let campusId = "";

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 10D risk.read RBAC / migration (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      const campus = await rawClient!.campus.create({
        data: {
          name: "P10D risk.read campus",
          slug: RUN_TAG,
          schoolName: "集成测试大学",
        },
      });
      campusId = campus.id;
    });

    afterAll(async () => {
      await rawClient!.userRoleAssignment.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await rawClient!.rolePermission.deleteMany({
        where: { roleId: { in: createdRoleIds } },
      });
      await rawClient!.role.deleteMany({ where: { id: { in: createdRoleIds } } });
      await rawClient!.campusMembership.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await rawClient!.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await rawClient!.campus.deleteMany({ where: { id: campusId } });
      await rawClient!.$disconnect();
    });

    it("P10D-RBAC-01: risk.read migration converges to one permission and PLATFORM_ADMIN grant", async () => {
      const permissions = await rawClient!.permission.findMany({
        where: { key: "risk.read" },
      });
      expect(permissions).toHaveLength(1);
      expect(permissions[0]?.description).toBe(
        "读取风险信号与规则化风险建议（治理运营可见性）",
      );

      const adminGrant = await rawClient!.rolePermission.findFirst({
        where: {
          role: { key: "PLATFORM_ADMIN" },
          permission: { key: "risk.read" },
        },
        select: { roleId: true, permissionId: true },
      });
      expect(adminGrant).not.toBeNull();
    });

    it("P10D-RBAC-02: campus risk.read is membership-scoped and never becomes legacy full admin", async () => {
      const user = await rawClient!.user.create({
        data: {
          email: `${RUN_TAG}@it.local`,
          name: "P10D campus risk reader",
          passwordHash: "test-only",
          schoolName: "集成测试大学",
          campusId,
          role: "STUDENT",
        },
      });
      createdUserIds.push(user.id);
      await rawClient!.campusMembership.create({
        data: { userId: user.id, campusId, status: "ACTIVE" },
      });

      const role = await rawClient!.role.create({
        data: {
          key: `${RUN_TAG}-ROLE`,
          name: "P10D 校区风险只读测试角色",
          scope: "CAMPUS",
          isSystem: false,
          rolePermissions: {
            create: [
              { permission: { connect: { key: "risk.read" } } },
            ],
          },
        },
      });
      createdRoleIds.push(role.id);

      await rawClient!.userRoleAssignment.create({
        data: {
          userId: user.id,
          roleId: role.id,
          campusId,
          scopeKey: `CAMPUS:${campusId}`,
        },
      });

      const { loadAuthorizationContext, hasFullAdminSurfaceAccess } = await import(
        "@/lib/rbac/service"
      );
      const { deriveRiskReadAccess } = await import("@/lib/risk/risk-read-access");
      const context = await loadAuthorizationContext(user.id);

      expect(deriveRiskReadAccess(context)).toEqual({
        global: false,
        campusIds: [campusId],
      });
      expect(hasFullAdminSurfaceAccess(context)).toBe(false);
    });
  },
);
