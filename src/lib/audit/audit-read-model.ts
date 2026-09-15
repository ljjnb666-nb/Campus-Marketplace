import type { Prisma } from "@prisma/client";

import { projectAuditMetadata, type AuditMetadataEntry } from "@/lib/audit/audit-metadata";
import type { AuditReadAccess } from "@/lib/audit/audit-access";
import { hydrateSafeIdentities, UNAVAILABLE_USER_DISPLAY_NAME } from "@/lib/governance/safe-identity";
import { prisma } from "@/lib/prisma";
import { auditDateRange, encodeAuditCursor, type AuditCursor } from "@/validators/audit";

/**
 * Phase 7D：/governance/audit 授权读模型（operator surface 专用）。
 *
 * 授权在 DB 查询内完成——绝不"取全量后内存过滤"：
 * - GLOBAL 读者：无 campus 谓词（campusId=null 行可见）；
 * - campus 读者：`campusId IN 有效校区` 单列谓词（SQL IN 结构性排除 NULL——
 *   campusId=null 行对 campus 读者不可见，R2/DECISION_02A 冻结）；
 * - 所有过滤（campusId/actorId/targetType/action/date）恒 AND 在 scope
 *   谓词之内；cursor 只是 UNTRUSTED 分页位置，伪造只能改变位置、
 *   永远改变不了授权范围。
 *
 * DTO 最小化（DECISION_03/12 冻结）：
 * - AdminLog.detail 结构性不在 select 内（NEVER RETURN——7 个写入点含
 *   操作员自由文本，R2/R3 普查在案）；
 * - metadata 仅经 AUDIT_READ_METADATA_PROJECTION 投影（raw object 永不透出）；
 * - actor 走批量安全身份水合（无 N+1，隐私安全 fallback）。
 *
 * scope 展示语义与授权语义分离（DECISION_02A）：campusId=null 授权上
 * GLOBAL-reader-only，但展示为 NO_CAMPUS_SCOPE_RECORDED（无校区归属记录），
 * 绝不显示"全局操作"——null 混有 legacy/写入缺口，AdminLog 无独立 scope 权威。
 * 本模型不做任何 campusId 回填/推断，7D 不修历史行。
 */

export type AuditScopeClassification = "CAMPUS" | "NO_CAMPUS_SCOPE_RECORDED";

export type AuditQueueItemDto = {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  result: string;
  createdAt: string;
  /** 授权 scope 分类（展示语义：NO_CAMPUS_SCOPE_RECORDED ≠ proven GLOBAL） */
  scope: AuditScopeClassification;
  campusId: string | null;
  campusName: string | null;
  actor: { id: string; displayName: string };
  metadata: AuditMetadataEntry[];
};

export type AuditQueuePage = {
  items: AuditQueueItemDto[];
  nextCursor: string | null;
};

export type AuditQueueFilters = {
  campusId?: string;
  actorId?: string;
  targetType?: string;
  action?: string;
  from?: string;
  to?: string;
};

/** 真实 keyset：createdAt < c OR (createdAt = c AND id < c.id)（§16 冻结）。 */
function auditKeysetCondition(cursor: AuditCursor): Prisma.AdminLogWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      {
        AND: [{ createdAt: { equals: cursor.createdAt } }, { id: { lt: cursor.id } }],
      },
    ],
  };
}

const auditRowSelect = {
  id: true,
  adminId: true,
  action: true,
  targetType: true,
  targetId: true,
  result: true,
  createdAt: true,
  campusId: true,
  metadata: true,
  campus: { select: { name: true } },
  // detail / updatePath 等其余列结构性不在 select 内：queue DTO 永不携带
} satisfies Prisma.AdminLogSelect;

export async function loadAuthorizedAuditPage(input: {
  access: AuditReadAccess;
  cursor?: AuditCursor;
  limit: number;
  filters?: AuditQueueFilters;
}): Promise<AuditQueuePage> {
  // fail-closed（与 DEFAULT_DENY 同语义）：零有效 scope 永远空页
  if (!input.access.global && input.access.campusIds.length === 0) {
    return { items: [], nextCursor: null };
  }

  const filters = input.filters ?? {};
  const conditions: Prisma.AdminLogWhereInput[] = [];

  if (!input.access.global) {
    conditions.push({ campusId: { in: input.access.campusIds } });
  }
  if (filters.campusId) {
    conditions.push({ campusId: filters.campusId });
  }
  if (filters.actorId) {
    conditions.push({ adminId: filters.actorId });
  }
  if (filters.targetType) {
    conditions.push({ targetType: filters.targetType });
  }
  if (filters.action) {
    conditions.push({ action: filters.action });
  }
  if (filters.from || filters.to) {
    // 日期→UTC range 的唯一构造点（FR03 集中化，防 validator/读模型语义漂移）
    const createdAtRange = auditDateRange(filters.from, filters.to);
    if (createdAtRange.gte || createdAtRange.lte) {
      conditions.push({ createdAt: createdAtRange });
    }
  }
  if (input.cursor) {
    conditions.push(auditKeysetCondition(input.cursor));
  }

  const rows = await prisma.adminLog.findMany({
    where: conditions.length > 0 ? { AND: conditions } : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: auditRowSelect,
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const last = pageRows[pageRows.length - 1];

  const actors = await hydrateSafeIdentities(pageRows.map((row) => row.adminId));

  return {
    items: pageRows.map((row) => {
      const actor = actors.get(row.adminId);
      return {
        id: row.id,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        result: row.result,
        createdAt: row.createdAt.toISOString(),
        scope: row.campusId === null ? "NO_CAMPUS_SCOPE_RECORDED" : "CAMPUS",
        campusId: row.campusId,
        campusName: row.campus?.name ?? null,
        actor: actor ?? { id: row.adminId, displayName: UNAVAILABLE_USER_DISPLAY_NAME },
        metadata: projectAuditMetadata(row.metadata),
      };
    }),
    nextCursor:
      hasMore && last ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
