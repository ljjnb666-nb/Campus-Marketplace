import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { softDeleteExtension } from "@/lib/prisma-soft-delete";
import { revokeRole } from "@/lib/rbac/assignment-service";

/**
 * CI-FLAKE-01 / TX-ESCAPE：软删除扩展 delete 钩子的事务上下文回归（真实 PostgreSQL）。
 *
 * 根因：delete 钩子旧实现经 defineExtension 闭包（root client）解析 delegate，
 * 交互事务内的 tx.<非软删除模型>.delete 以 autocommit 逃逸事务——assignment 删除
 * 对外可见早于同链路 ROLE_REVOKED 审计提交，且回滚无法恢复删除。
 *
 * 门禁（全部使用真实 PG / 真实 Prisma client extension / 真实 interactive transaction）：
 *  - TX-ESCAPE-01 回滚原子性：事务内删除 + 强制失败 → 行必须恢复（旧实现必 FAIL）
 *  - TX-ESCAPE-02 提交前可见性：删除后、提交前，独立观察者连接必须仍能看到该行
 *    （Promise barrier 同步，零 sleep；旧实现必 FAIL）
 *  - TX-ESCAPE-03 revoke 域原子性：真实 revokeRole 成功 → assignment 缺席 +
 *    ROLE_REVOKED 审计恰 1 条（targetId/roleKey/campusId 正确）
 *
 * PRISMA-SOFT-DELETE-IMPL-01 后软删除模型 delete/deleteMany 已 fail closed；
 * PRISMA-SOFT-DELETE-READ-01 在本文件追加真实 PG selective unique-read 回归，
 * 同时验证修复仍只使用当前 transaction query context，不引入 root-client 二次查询。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

// 与 src/lib/prisma.ts 相同的构造：base client + $extends(softDeleteExtension)
const txBase = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;
const extendedClient = txBase ? txBase.$extends(softDeleteExtension) : null;

// 独立观察者连接（独立连接池）：TX-ESCAPE-02 的第二观测上下文
const observer = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `txesc-${randomUUID().slice(0, 8)}`;
const REVIEWER_ROLE_KEY = "CAMPUS_APPEAL_REVIEWER";
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdRoleIds: string[] = [];

describe.skipIf(!integrationDatabaseUrl)(
  "软删除扩展 delete 钩子事务上下文（真实 PostgreSQL）",
  () => {
    let campus: { id: string };
    let reviewerRoleId = "";

    async function createAssignmentRow(userId: string) {
      return observer!.userRoleAssignment.create({
        data: {
          userId,
          roleId: reviewerRoleId,
          campusId: campus.id,
          scopeKey: `CAMPUS:${campus.id}`,
        },
      });
    }

    beforeAll(async () => {
      const reviewerRole = await observer!.role.findUnique({ where: { key: REVIEWER_ROLE_KEY } });
      if (!reviewerRole) {
        throw new Error("系统角色缺失：请先执行 prisma migrate deploy / ensureRbacFoundation");
      }
      reviewerRoleId = reviewerRole.id;

      campus = await observer!.campus.create({
        data: {
          name: "tx-escape-campus",
          slug: `${RUN_TAG}-campus`,
          schoolName: "集成测试大学",
        },
      });
      createdCampusIds.push(campus.id);
    }, 60_000);

    afterAll(async () => {
      await observer!.adminLog.deleteMany({ where: { adminId: { in: createdUserIds } } });
      await observer!.userRoleAssignment.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await observer!.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
      await observer!.role.deleteMany({ where: { id: { in: createdRoleIds } } });
      await observer!.campusMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
      await observer!.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await observer!.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
      await txBase!.$disconnect();
      await observer!.$disconnect();
    });

    it("TX-ESCAPE-01: 事务内删除 + 强制失败 → 回滚必须恢复 assignment", async () => {
      const user = await observer!.user.create({
        data: {
          email: `${RUN_TAG}-r1@it.local`,
          name: "TXESCAPE01",
          passwordHash: FIXTURE_PASSWORD_HASH,
          schoolName: "集成测试大学",
          campusId: campus.id,
        },
      });
      createdUserIds.push(user.id);
      const assignment = await createAssignmentRow(user.id);

      await expect(
        extendedClient!.$transaction(async (tx) => {
          await tx.userRoleAssignment.delete({ where: { id: assignment.id } });
          throw new Error("TX_ESCAPE_01_SENTINEL");
        }),
      ).rejects.toThrow("TX_ESCAPE_01_SENTINEL");

      // ROLLBACK_RESTORES_DELETE：删除必须随事务一起回滚（旧实现：0 → FAIL）
      const remaining = await observer!.userRoleAssignment.count({
        where: { id: assignment.id },
      });
      expect(remaining).toBe(1);
    });

    it("TX-ESCAPE-02: 提交前独立观察者必须仍可见 assignment（barrier 同步，零 sleep）", async () => {
      const user = await observer!.user.create({
        data: {
          email: `${RUN_TAG}-r2@it.local`,
          name: "TXESCAPE02",
          passwordHash: FIXTURE_PASSWORD_HASH,
          schoolName: "集成测试大学",
          campusId: campus.id,
        },
      });
      createdUserIds.push(user.id);
      const assignment = await createAssignmentRow(user.id);

      let signalDeleteDone!: () => void;
      const deleteDone = new Promise<void>((resolve) => {
        signalDeleteDone = resolve;
      });
      let releaseCommit!: () => void;
      const commitGate = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });

      const txOutcome = extendedClient!.$transaction(async (tx) => {
        await tx.userRoleAssignment.delete({ where: { id: assignment.id } });
        signalDeleteDone();
        await commitGate;
        return "committed";
      });

      // TX A 持有未提交删除；观察者 B（独立连接）在提交前查询
      await deleteDone;
      const visibleBeforeCommit = await observer!.userRoleAssignment.count({
        where: { id: assignment.id },
      });
      expect(visibleBeforeCommit).toBe(1);

      releaseCommit();
      await expect(txOutcome).resolves.toBe("committed");

      // 提交后：观察者 B 最终看到行缺席（$transaction resolve 即已 commit，无需 sleep）
      const visibleAfterCommit = await observer!.userRoleAssignment.count({
        where: { id: assignment.id },
      });
      expect(visibleAfterCommit).toBe(0);
    });

    it("TX-ESCAPE-03: 真实 revokeRole 成功 → assignment 缺席 + ROLE_REVOKED 审计恰 1 条且字段正确", async () => {
      const manager = await observer!.user.create({
        data: {
          email: `${RUN_TAG}-mgr@it.local`,
          name: "TXESCAPE03-Manager",
          passwordHash: FIXTURE_PASSWORD_HASH,
          schoolName: "集成测试大学",
          campusId: campus.id,
        },
      });
      createdUserIds.push(manager.id);
      const target = await observer!.user.create({
        data: {
          email: `${RUN_TAG}-tgt@it.local`,
          name: "TXESCAPE03-Target",
          passwordHash: FIXTURE_PASSWORD_HASH,
          schoolName: "集成测试大学",
          campusId: campus.id,
        },
      });
      createdUserIds.push(target.id);
      await observer!.campusMembership.create({
        data: { userId: target.id, campusId: campus.id, status: "ACTIVE" },
      });

      // actor 持 GLOBAL rbac.role.assign（自定义角色，RUN_TAG 隔离）
      const managerRole = await observer!.role.create({
        data: {
          key: `${RUN_TAG}-global-assigner`,
          name: "global-assigner",
          scope: "GLOBAL",
          isSystem: false,
          rolePermissions: {
            create: [{ permission: { connect: { key: "rbac.role.assign" } } }],
          },
        },
      });
      createdRoleIds.push(managerRole.id);
      await observer!.userRoleAssignment.create({
        data: {
          userId: manager.id,
          roleId: managerRole.id,
          campusId: null,
          scopeKey: "GLOBAL",
        },
      });

      const assignment = await createAssignmentRow(target.id);

      const result = await revokeRole({
        actorId: manager.id,
        targetUserId: target.id,
        roleKey: REVIEWER_ROLE_KEY,
        campusId: campus.id,
        expectedAssignmentId: assignment.id,
      });
      expect(result.removed).toBe(true);

      const remaining = await observer!.userRoleAssignment.count({
        where: { id: assignment.id },
      });
      expect(remaining).toBe(0);

      const audits = await observer!.adminLog.findMany({
        where: { action: "ROLE_REVOKED", targetId: target.id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.adminId).toBe(manager.id);
      expect(audits[0]!.targetType).toBe("USER");
      expect(audits[0]!.campusId).toBe(campus.id);
      expect(audits[0]!.metadata).toMatchObject({ roleKey: REVIEWER_ROLE_KEY });
    });

    it("SD-READ-IT-01: select/omit 均不得让软删除 User 通过 findUnique 泄漏", async () => {
      const user = await observer!.user.create({
        data: {
          email: `${RUN_TAG}-sdread-deleted@it.local`,
          name: "SDREAD-DELETED",
          passwordHash: FIXTURE_PASSWORD_HASH,
          schoolName: "集成测试大学",
          campusId: campus.id,
        },
      });
      createdUserIds.push(user.id);

      await observer!.user.update({
        where: { id: user.id },
        data: { deletedAt: new Date() },
      });

      await expect(
        extendedClient!.user.findUnique({
          where: { id: user.id },
          select: { id: true, name: true },
        }),
      ).resolves.toBeNull();

      await expect(
        extendedClient!.user.findUnique({
          where: { id: user.id },
          omit: { deletedAt: true },
        }),
      ).resolves.toBeNull();

      await expect(
        extendedClient!.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { id: true },
        }),
      ).rejects.toMatchObject({ code: "P2025" });
    });

    it("SD-READ-IT-02: live selective shape 保持不变，interactive tx 中软删除仍隐藏", async () => {
      const live = await observer!.user.create({
        data: {
          email: `${RUN_TAG}-sdread-live@it.local`,
          name: "SDREAD-LIVE",
          passwordHash: FIXTURE_PASSWORD_HASH,
          schoolName: "集成测试大学",
          campusId: campus.id,
        },
      });
      createdUserIds.push(live.id);

      await expect(
        extendedClient!.user.findUnique({
          where: { id: live.id },
          select: { id: true, name: true },
        }),
      ).resolves.toEqual({ id: live.id, name: "SDREAD-LIVE" });

      const deleted = await observer!.user.create({
        data: {
          email: `${RUN_TAG}-sdread-tx@it.local`,
          name: "SDREAD-TX",
          passwordHash: FIXTURE_PASSWORD_HASH,
          schoolName: "集成测试大学",
          campusId: campus.id,
        },
      });
      createdUserIds.push(deleted.id);
      await observer!.user.update({
        where: { id: deleted.id },
        data: { deletedAt: new Date() },
      });

      const insideTx = await extendedClient!.$transaction((tx) =>
        tx.user.findUnique({
          where: { id: deleted.id },
          select: { id: true, name: true },
        }),
      );
      expect(insideTx).toBeNull();
    });
  },
);
