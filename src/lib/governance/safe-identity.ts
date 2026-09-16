import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Phase 7D：治理读面安全身份水合（批量，无 N+1；Planning DECISION_12A / R4 冻结）。
 *
 * 内部 hydration 合同：select 仅 {id, name, deletedAt, erasedAt}；
 * missing / deletedAt != null / erasedAt != null 三种情况统一 fallback
 * 「已注销用户」，互不可区分——DTO 绝不暴露 deletedAt/erasedAt 等
 * privacy-state flag，也绝不返回 email/phone/studentId 等私有字段。
 *
 * 注意：不依赖 erasure 将 name 覆写为常量的副作用作判定依据
 * （ERASED_USER_DISPLAY_NAME 只是展示巧合，判定以显式状态列为准）。
 */

export const UNAVAILABLE_USER_DISPLAY_NAME = "已注销用户";

export type SafeIdentity = {
  id: string;
  displayName: string;
};

type SafeIdentityRow = {
  id: string;
  name: string;
  deletedAt: Date | null;
  erasedAt: Date | null;
};

const safeIdentitySelect = {
  id: true,
  name: true,
  deletedAt: true,
  erasedAt: true,
} satisfies Prisma.UserSelect;

function toSafeIdentity(row: SafeIdentityRow | undefined, id: string): SafeIdentity {
  if (!row || row.deletedAt !== null || row.erasedAt !== null) {
    return { id, displayName: UNAVAILABLE_USER_DISPLAY_NAME };
  }
  return { id, displayName: row.name };
}

/**
 * 批量水合：单次 findMany（IN 查询），绝不 N+1。入参重复 id 自动去重；
 * 返回 Map 覆盖全部入参 id（缺失行也产出 fallback 项，调用方无需判空）。
 */
export async function hydrateSafeIdentities(
  userIds: string[],
  tx?: Prisma.TransactionClient,
): Promise<Map<string, SafeIdentity>> {
  const uniqueIds = [...new Set(userIds)];
  const identities = new Map<string, SafeIdentity>();
  if (uniqueIds.length === 0) {
    return identities;
  }

  const rows: SafeIdentityRow[] = tx
    ? await tx.user.findMany({
        where: { id: { in: uniqueIds } },
        select: safeIdentitySelect,
      })
    : await prisma.user.findMany({
        where: { id: { in: uniqueIds } },
        select: safeIdentitySelect,
      });

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  for (const id of uniqueIds) {
    identities.set(id, toSafeIdentity(rowsById.get(id), id));
  }

  return identities;
}
