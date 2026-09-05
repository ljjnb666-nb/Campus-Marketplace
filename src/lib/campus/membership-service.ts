import type { CampusMembership, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { rbacError } from "@/lib/rbac/errors";

/**
 * Phase 6A：中央 active campus membership resolver。
 *
 * 核心语义：membership 存在 != membership active。
 * 任何 campus-scoped 逻辑都不得以 `campusId != null` 或裸查 membership 行
 * 判定资格，必须经本模块解析 ACTIVE membership（后续 Phase 的 campus-scoped
 * 操作一律复用，禁止逻辑漂移）。
 *
 * 当前产品为单 active campus（User.campusId 与之一致）；数据模型
 * （(userId, campusId) unique）已支持未来一用户多校区。
 */

const activeMembershipOrder: Prisma.CampusMembershipOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

export async function resolveActiveCampusMembership(
  userId: string,
  options: { campusId?: string; tx?: Prisma.TransactionClient } = {},
): Promise<CampusMembership | null> {
  const where: Prisma.CampusMembershipWhereInput = {
    userId,
    status: "ACTIVE",
    ...(options.campusId ? { campusId: options.campusId } : {}),
  };

  if (options.tx) {
    const rows = await options.tx.campusMembership.findMany({
      where,
      orderBy: activeMembershipOrder,
      take: 1,
    });
    return rows[0] ?? null;
  }

  const rows = await prisma.campusMembership.findMany({
    where,
    orderBy: activeMembershipOrder,
    take: 1,
  });
  return rows[0] ?? null;
}

/** 要求存在 ACTIVE membership（默认按用户全部校区解析），否则 fail closed。 */
export async function requireActiveCampusMembership(
  userId: string,
  options: { campusId?: string; tx?: Prisma.TransactionClient } = {},
): Promise<CampusMembership> {
  const membership = await resolveActiveCampusMembership(userId, options);

  if (!membership) {
    throw rbacError("MEMBERSHIP_NOT_ACTIVE");
  }

  return membership;
}

/**
 * 注册路径：与用户创建同事务建立 ACTIVE membership（加入校区开放，
 * 学生认证是独立的更高信任层级，不在注册时阻断）。
 */
export async function createActiveMembership(
  tx: Prisma.TransactionClient,
  input: { userId: string; campusId: string },
): Promise<CampusMembership> {
  return tx.campusMembership.create({
    data: {
      userId: input.userId,
      campusId: input.campusId,
      status: "ACTIVE",
    },
  });
}

/** 注销路径：账号匿名化时成员关系闭环为 LEFT（调用方须已持有 subject 治理锁）。 */
export async function markMembershipsLeft(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<number> {
  const result = await tx.campusMembership.updateMany({
    where: { userId, status: { not: "LEFT" } },
    data: { status: "LEFT" },
  });
  return result.count;
}
