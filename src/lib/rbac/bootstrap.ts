/**
 * Phase 6A RBAC / membership bootstrap（幂等、确定性）。
 *
 * 运行位置：prisma/seed.ts（fresh DB）、scripts/e2e-setup.ts（E2E DB）、
 * 测试 fixture。生产既有数据的对应回填在 migration
 * 20260905120000_phase6_identity_membership_rbac 中以等价 SQL 完成。
 *
 * 运行时不做懒同步：数据库是唯一事实来源，代码变更（permission/角色定义）
 * 通过再次运行 bootstrap（seed/迁移）收敛，避免每次请求付出同步成本。
 */

import { Prisma } from "@prisma/client";

// 相对导入：本模块被 prisma/seed.ts 与 scripts/e2e-setup.ts 以 tsx 直接执行
// （tsx 无 @/ alias），且不依赖 prisma 单例——客户端一律由调用方传入。
import { PERMISSIONS, PERMISSION_KEYS } from "./permissions";
import { GLOBAL_SCOPE_KEY, SYSTEM_ROLES } from "./roles";

/**
 * bootstrap 运行所需的客户端形状（窄结构类型）：
 * plain PrismaClient（seed / e2e-setup）与 src/lib/prisma 的扩展单例
 * （测试 / 事务场景）均可传入——直接引用 PrismaClient 类型会因扩展客户端
 * 联合类型触发 Prisma excessive stack depth（见 legal-document-service.ts 同注）。
 */
export type RbacBootstrapClient = {
  permission: {
    upsert: (args: Prisma.PermissionUpsertArgs) => Promise<unknown>;
    findUniqueOrThrow: (args: Prisma.PermissionFindUniqueOrThrowArgs) => Promise<{ id: string }>;
  };
  role: {
    upsert: (args: Prisma.RoleUpsertArgs) => Promise<unknown>;
    findUnique: (args: Prisma.RoleFindUniqueArgs) => Promise<{ id: string } | null>;
    findUniqueOrThrow: (args: Prisma.RoleFindUniqueOrThrowArgs) => Promise<{ id: string }>;
  };
  rolePermission: {
    findMany: (args: Prisma.RolePermissionFindManyArgs) => Promise<Array<{ permissionId: string }>>;
    delete: (args: Prisma.RolePermissionDeleteArgs) => Promise<unknown>;
    upsert: (args: Prisma.RolePermissionUpsertArgs) => Promise<unknown>;
  };
  user: {
    findMany: (args: Prisma.UserFindManyArgs) => Promise<Array<{ id: string; campusId: string }>>;
    findUnique: (args: Prisma.UserFindUniqueArgs) => Promise<{ id: string } | null>;
  };
  userRoleAssignment: {
    findFirst: (args: Prisma.UserRoleAssignmentFindFirstArgs) => Promise<{ id: string } | null>;
    create: (args: Prisma.UserRoleAssignmentCreateArgs) => Promise<unknown>;
  };
  campus: {
    findUnique: (args: Prisma.CampusFindUniqueArgs) => Promise<{ id: string } | null>;
  };
  campusMembership: {
    findMany: (
      args: Prisma.CampusMembershipFindManyArgs,
    ) => Promise<Array<{ userId: string; campusId: string }>>;
    findUnique: (
      args: Prisma.CampusMembershipFindUniqueArgs,
    ) => Promise<{ status: string } | null>;
    create: (args: Prisma.CampusMembershipCreateArgs) => Promise<unknown>;
  };
};

/** 幂等写入 permission 与系统角色定义（描述/授权集合收敛到代码定义）。 */
export async function ensureRbacFoundation(client: RbacBootstrapClient): Promise<void> {
  for (const key of PERMISSION_KEYS) {
    await client.permission.upsert({
      where: { key },
      update: { description: PERMISSIONS[key] },
      create: { key, description: PERMISSIONS[key] },
    });
  }

  for (const role of SYSTEM_ROLES) {
    await client.role.upsert({
      where: { key: role.key },
      update: { name: role.name, scope: role.scope, isSystem: true },
      create: { key: role.key, name: role.name, scope: role.scope, isSystem: true },
    });

    const persistedRole = await client.role.findUniqueOrThrow({
      where: { key: role.key },
      select: { id: true },
    });

    const desiredPermissionIds = new Map<string, string>();
    for (const permissionKey of role.permissionKeys) {
      const permission = await client.permission.findUniqueOrThrow({
        where: { key: permissionKey },
        select: { id: true },
      });
      desiredPermissionIds.set(permission.id, permission.id);
    }

    // 收敛：缺则建，多余则删（系统角色权限集合与代码定义严格一致）
    const existingLinks = await client.rolePermission.findMany({
      where: { roleId: persistedRole.id },
      select: { permissionId: true },
    });
    for (const link of existingLinks) {
      if (!desiredPermissionIds.has(link.permissionId)) {
        await client.rolePermission.delete({
          where: { roleId_permissionId: { roleId: persistedRole.id, permissionId: link.permissionId } },
        });
      }
    }
    for (const permissionId of desiredPermissionIds.keys()) {
      await client.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: persistedRole.id, permissionId } },
        update: {},
        create: { roleId: persistedRole.id, permissionId },
      });
    }
  }
}

/**
 * legacy admin 迁移（幂等）：role='ADMIN' 的用户补授 PLATFORM_ADMIN。
 * 这是 User.role 字段参与授权的唯一残留用途（bootstrap 同步），
 * 授权判定本身只认 UserRoleAssignment。
 */
export async function syncLegacyAdminRoles(client: RbacBootstrapClient): Promise<number> {
  const admins = await client.user.findMany({
    where: { role: "ADMIN", erasedAt: null },
    select: { id: true },
  });

  const role = await client.role.findUnique({
    where: { key: "PLATFORM_ADMIN" },
    select: { id: true },
  });

  if (!role) {
    throw new Error("PLATFORM_ADMIN 角色不存在，请先运行 ensureRbacFoundation");
  }

  let created = 0;
  for (const admin of admins) {
    const existing = await client.userRoleAssignment.findFirst({
      where: { userId: admin.id, roleId: role.id, scopeKey: GLOBAL_SCOPE_KEY },
      select: { id: true },
    });
    if (existing) {
      continue;
    }
    try {
      await client.userRoleAssignment.create({
        data: { userId: admin.id, roleId: role.id, scopeKey: GLOBAL_SCOPE_KEY },
      });
      created += 1;
    } catch (error) {
      // 并发 bootstrap（如并行测试文件/多进程同时收敛）唯一约束兜底幂等
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        continue;
      }
      throw error;
    }
  }

  return created;
}

/**
 * P2002 是否命中指定字段的唯一约束。
 *
 * Prisma meta.target 的真实形状随版本/约束形态变化：字段数组
 * （["userId","campusId"]）或约束名字符串（"CampusMembership_userId_campusId_key"）。
 * 这里统一解析后要求请求的字段全部出现，防止无关唯一约束被误判吞掉。
 */
function isUniqueConstraintOn(error: unknown, fields: string[]): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const raw: unknown = error.meta?.target;
  const targetFields = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split(/[\s,_]+/).filter(Boolean)
      : [];
  return fields.every((field) => targetFields.includes(field));
}

/**
 * membership 补齐（convergent bootstrap / reconciliation，并发幂等）：
 * 为仍存在、且尚无 home-campus membership 的用户补建 ACTIVE membership。
 * fresh DB 注册路径在注册事务内直接创建 membership；本函数服务于
 * seed / e2e-setup / 测试 fixture / 存量数据的 belt-and-braces 场景。
 *
 * 并发收敛合同（与 syncLegacyAdminRoles 同一原则——并发赢家产出目标行
 * = 幂等成功）：
 * - P2002 且目标为 (userId, campusId)：复查 exact membership——已存在（任何
 *   status，含 SUSPENDED/LEFT 等）则视为并发赢家已写入，幂等成功；仍不存在
 *   则 rethrow 原错误。绝不 rehabilitate 既有 membership（bootstrap 不绕过
 *   正式 membership 状态机）。
 * - P2003：复查 candidate user 与 campus 是否仍存在——任一已被并发删除
 *   （STALE_BOOTSTRAP_SNAPSHOT）则本轮 no-op；referent 仍在则 rethrow
 *   （真实数据库完整性问题不得静默吞掉）。
 * - 其余错误一律 rethrow。
 *
 * `options.afterSnapshot` 是 internal/testing-only seam（默认 undefined，
 * production 行为不变）：在快照读取后、写入前插入 barrier，供集成测试
 * 确定性复现并发竞态（替代 sleep 定序）。
 */
export async function ensureCampusMemberships(
  client: RbacBootstrapClient,
  options?: { afterSnapshot?: () => Promise<void> },
): Promise<number> {
  const users = await client.user.findMany({
    select: { id: true, campusId: true },
  });

  const existing = await client.campusMembership.findMany({
    select: { userId: true, campusId: true },
  });
  const existingKeys = new Set(existing.map((m) => `${m.userId}:${m.campusId}`));

  if (options?.afterSnapshot) {
    await options.afterSnapshot();
  }

  let created = 0;
  for (const user of users) {
    const key = `${user.id}:${user.campusId}`;
    if (existingKeys.has(key)) {
      continue;
    }
    try {
      await client.campusMembership.create({
        data: {
          userId: user.id,
          campusId: user.campusId,
          status: "ACTIVE",
        },
      });
      created += 1;
    } catch (error) {
      if (isUniqueConstraintOn(error, ["userId", "campusId"])) {
        // CONCURRENT_WINNER_CONFIRMED 路径：exact membership 已由并发执行写入
        // → 幂等成功；任何现有 status 都不改写（禁止 SUSPENDED/LEFT → ACTIVE）
        const winner = await client.campusMembership.findUnique({
          where: { userId_campusId: { userId: user.id, campusId: user.campusId } },
          select: { status: true },
        });
        if (!winner) {
          throw error;
        }
      } else if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2003"
      ) {
        // STALE_BOOTSTRAP_SNAPSHOT 路径：candidate user / campus 已被并发删除
        // → 本轮 no-op；referent 仍在 → 真实完整性问题，rethrow
        const [userStillExists, campusStillExists] = await Promise.all([
          client.user.findUnique({ where: { id: user.id }, select: { id: true } }),
          client.campus.findUnique({ where: { id: user.campusId }, select: { id: true } }),
        ]);
        if (userStillExists && campusStillExists) {
          throw error;
        }
      } else {
        throw error;
      }
    }
    existingKeys.add(key);
  }

  return created;
}
