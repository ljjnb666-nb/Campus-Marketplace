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

import type { Prisma } from "@prisma/client";

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
  };
  userRoleAssignment: {
    findFirst: (args: Prisma.UserRoleAssignmentFindFirstArgs) => Promise<{ id: string } | null>;
    create: (args: Prisma.UserRoleAssignmentCreateArgs) => Promise<unknown>;
  };
  campusMembership: {
    findMany: (
      args: Prisma.CampusMembershipFindManyArgs,
    ) => Promise<Array<{ userId: string; campusId: string }>>;
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
    await client.userRoleAssignment.create({
      data: { userId: admin.id, roleId: role.id, scopeKey: GLOBAL_SCOPE_KEY },
    });
    created += 1;
  }

  return created;
}

/**
 * membership 补齐（幂等）：为没有 membership 的用户按 User.campusId 创建
 * ACTIVE membership。fresh DB 注册路径在注册事务内直接创建 membership；
 * 本函数服务于 seed / e2e-setup / 存量数据的 belt-and-braces 场景。
 */
export async function ensureCampusMemberships(client: RbacBootstrapClient): Promise<number> {
  const users = await client.user.findMany({
    select: { id: true, campusId: true },
  });

  const existing = await client.campusMembership.findMany({
    select: { userId: true, campusId: true },
  });
  const existingKeys = new Set(existing.map((m) => `${m.userId}:${m.campusId}`));

  let created = 0;
  for (const user of users) {
    const key = `${user.id}:${user.campusId}`;
    if (existingKeys.has(key)) {
      continue;
    }
    await client.campusMembership.create({
      data: {
        userId: user.id,
        campusId: user.campusId,
        status: "ACTIVE",
      },
    });
    existingKeys.add(key);
    created += 1;
  }

  return created;
}
