import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  MANAGEABLE_GOVERNANCE_ROLE_KEYS,
  canManageCampus,
  isManageableGovernanceRoleKey,
  type RoleManageAccess,
} from "@/lib/rbac/role-manage-access";
import { campusScopeKey } from "@/lib/rbac/roles";
import {
  encodeGovernanceRoleCursor,
  type GovernanceRoleCursor,
} from "@/validators/governance-role";

/**
 * Phase 7B 角色供给面读模型 / server-only 授权 seam（Planning Repair + P1 冻结）。
 *
 * - 列表/查找/撤回 resolver 只覆盖显式 allowlist
 *   （MANAGEABLE_GOVERNANCE_ROLE_KEYS）：allowlist 外角色（未来 CAMPUS 角色、
 *   GLOBAL 角色）结构性不可见/不可撤，不随 SYSTEM_ROLES 增长自动变宽；
 * - 列表谓词 = role.key IN allowlist（campus actor 附加单列 campusId IN），
 *   不构造 role×campus×scope 笛卡尔策略；
 * - MANAGE AUTHORIZATION 不检查 Campus.isActive（inactive campus 的 stale
 *   assignment 必须仍可见/可撤）；Campus.isActive 只进入 NEW-GRANT
 *   ELIGIBILITY（resolveGrantEligibleCampus），且 Campus 查询必须先于
 *   User email lookup（P1：inactive campus 伪造请求不得驱动 User 表查询）；
 * - DTO 最小面：列表无 email/userId/roleId/scopeKey/permission/audit 元数据；
 *   assignedBy 由两阶段批量 map 解析（零 N+1），客户端永不见 assignedById；
 * - 分页 = bounded keyset（default 25 / max 50 / assignedAt DESC, id DESC /
 *   base64url cursor，Phase 7B 自有 codec）：cursor 只是 UNTRUSTED 分页位置，
 *   scope 过滤独立附加。
 */

export type ManageableRoleCampusDto = {
  id: string;
  name: string;
};

/**
 * 可授予 campus picker（NEW-GRANT ELIGIBILITY 的 UI discovery 面）：
 * GLOBAL → 全部 isActive campus（零 assignment 的 campus 也在列，可授首个
 * reviewer）；CAMPUS actor → 仅 access.campusIds ∩ isActive。
 * 注意：picker eligibility 与 existing-assignment visibility 是两条独立规则。
 */
export async function loadManageableRoleCampuses(
  access: RoleManageAccess,
): Promise<ManageableRoleCampusDto[]> {
  if (!access.global && access.campusIds.length === 0) {
    return [];
  }

  return prisma.campus.findMany({
    where:
      access.global
        ? { isActive: true }
        : { id: { in: access.campusIds }, isActive: true },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

/**
 * NEW-GRANT ELIGIBILITY server-only seam（P1 冻结顺序）：
 * 1. actor authorization 已由调用方完成（access 为必传派生参数）；
 * 2. verify actor may manage campusId；
 * 3. Campus { id, isActive: true } 精确查询（select 仅 { id }）；
 * 4. missing / inactive / unauthorized → 统一 null（调用方映射统一 deny）。
 * 调用方必须在 User email lookup 之前调用本 seam。
 */
export async function resolveGrantEligibleCampus(input: {
  access: RoleManageAccess;
  campusId: string;
}): Promise<{ id: string } | null> {
  if (!canManageCampus(input.access, input.campusId)) {
    return null;
  }

  return prisma.campus.findFirst({
    where: { id: input.campusId, isActive: true },
    select: { id: true },
  });
}

/**
 * exact-email candidate 解析（仅 UX 便利，canonical assignRole 锁后全量重验）。
 * 前置条件：调用方已完成 manage 授权 + eligibility + allowlist 校验。
 * 查询条件含账号 ACTIVE / 未删除 / 未擦除 / 目标校区 membership ACTIVE；
 * 任一不满足 → null（与不存在统一，无差异信号）。
 */
export async function resolveGrantCandidate(input: {
  campusId: string;
  email: string;
}): Promise<{ id: string; name: string } | null> {
  return prisma.user.findFirst({
    where: {
      email: input.email,
      status: "ACTIVE",
      deletedAt: null,
      erasedAt: null,
      memberships: {
        some: { campusId: input.campusId, status: "ACTIVE" },
      },
    },
    select: { id: true, name: true },
  });
}

export type ManagedRoleAssignmentDto = {
  /** assignmentId（revoke 唯一客户端入口） */
  id: string;
  roleKey: string;
  campusName: string;
  userDisplayName: string;
  assignedByDisplayName: string;
  assignedAt: string;
};

export type ManagedRoleAssignmentPage = {
  items: ManagedRoleAssignmentDto[];
  nextCursor: string | null;
};

/** assignedBy 三态映射（Planning Repair 6 冻结）：null→系统，未解析→未知，命中→name。 */
export function assignedByDisplayName(
  assignedById: string | null,
  nameById: Map<string, string>,
): string {
  if (assignedById === null) {
    return "系统";
  }
  return nameById.get(assignedById) ?? "未知";
}

function roleKeysetCondition(
  cursor: GovernanceRoleCursor,
): Prisma.UserRoleAssignmentWhereInput {
  return {
    OR: [
      { assignedAt: { lt: cursor.assignedAt } },
      {
        AND: [{ assignedAt: { equals: cursor.assignedAt } }, { id: { lt: cursor.id } }],
      },
    ],
  };
}

/**
 * allowlist assignments 列表（授权在 DB 查询内，fail-closed）：
 * 零有效 scope 永远空页。 campus actor 单列 IN，无叉积；
 * campus.isActive 不参与可见性（inactive campus 的 stale assignment 仍可见）。
 */
export async function loadManagedRoleAssignments(input: {
  access: RoleManageAccess;
  cursor?: GovernanceRoleCursor;
  limit: number;
}): Promise<ManagedRoleAssignmentPage> {
  if (!input.access.global && input.access.campusIds.length === 0) {
    return { items: [], nextCursor: null };
  }

  const rows = await prisma.userRoleAssignment.findMany({
    where: {
      role: { key: { in: [...MANAGEABLE_GOVERNANCE_ROLE_KEYS] } },
      ...(input.access.global
        ? {}
        : { campusId: { in: input.access.campusIds } }),
      ...(input.cursor ? roleKeysetCondition(input.cursor) : {}),
    },
    orderBy: [{ assignedAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: {
      id: true,
      assignedAt: true,
      assignedById: true,
      role: { select: { key: true } },
      user: { select: { name: true } },
      campus: { select: { name: true } },
    },
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const last = pageRows[pageRows.length - 1];

  // assignedBy 两阶段批量读取（Repair 6：零 N+1、零 email/phone select）
  const assignerIds = [
    ...new Set(
      pageRows
        .map((row) => row.assignedById)
        .filter((id): id is string => id !== null),
    ),
  ];
  const assigners = assignerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: assignerIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(assigners.map((user) => [user.id, user.name]));

  return {
    items: pageRows.map((row) => ({
      id: row.id,
      roleKey: row.role.key,
      campusName: row.campus?.name ?? "未知校区",
      userDisplayName: row.user.name,
      assignedByDisplayName: assignedByDisplayName(row.assignedById, nameById),
      assignedAt: row.assignedAt.toISOString(),
    })),
    nextCursor:
      hasMore && last
        ? encodeGovernanceRoleCursor({ assignedAt: last.assignedAt, id: last.id })
        : null,
  };
}

export type RevocableAssignment = {
  id: string;
  userId: string;
  campusId: string;
  roleKey: string;
};

/**
 * revoke assignment resolver（Repair 1 冻结顺序）：assignment minimal load →
 * role allowlist → CAMPUS exact pair（campusId != null ∧ scopeKey ===
 * campusScopeKey(campusId)）→ actor manage 授权。任一失败 → 统一 null
 * （不存在/越权/unmanaged/malformed 不可区分，无存在性 oracle）。
 * 不检查 Campus.isActive（P4）：inactive campus 的 assignment 一样可解析。
 */
export async function resolveRevocableAssignment(input: {
  access: RoleManageAccess;
  assignmentId: string;
}): Promise<RevocableAssignment | null> {
  const row = await prisma.userRoleAssignment.findUnique({
    where: { id: input.assignmentId },
    select: {
      id: true,
      userId: true,
      campusId: true,
      scopeKey: true,
      role: { select: { key: true, scope: true } },
    },
  });

  if (!row) {
    return null;
  }
  if (!isManageableGovernanceRoleKey(row.role.key)) {
    return null;
  }
  if (row.role.scope !== "CAMPUS") {
    return null;
  }
  if (row.campusId === null) {
    return null;
  }
  if (row.scopeKey !== campusScopeKey(row.campusId)) {
    return null;
  }
  if (!canManageCampus(input.access, row.campusId)) {
    return null;
  }

  return {
    id: row.id,
    userId: row.userId,
    campusId: row.campusId,
    roleKey: row.role.key,
  };
}
