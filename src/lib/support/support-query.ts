import type { Prisma, SupportTicketStatus } from "@prisma/client";

import {
  parseCanonicalCursorDate,
  parseCanonicalCursorJson,
} from "@/lib/governance/canonical-cursor";
import { hydrateSafeIdentities, UNAVAILABLE_USER_DISPLAY_NAME } from "@/lib/governance/safe-identity";
import { prisma } from "@/lib/prisma";
import { canManageSupportScope, type SupportManageAccess } from "@/lib/support/support-access";
import { isSupportTicketOverdue } from "@/lib/support/support-sla";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7G：支持工单运营队列/详情授权读模型（operator surface 专用）。
 *
 * 授权在 DB 查询内完成（7A/7E 同款冻结）——绝不"取全量后内存过滤"：
 * - UNSCOPED 工单（campusId null + scopeKey 'UNSCOPED'）仅 GLOBAL 读者；
 * - CAMPUS 工单 = (campusId, scopeKey) exact 合取；GLOBAL 读者 = 权威 Campus
 *   全表枚举的 exact pair（FK 保证分支集完备）；
 * - 所有 filter 恒 AND 在 scope 谓词之内——filter 永远不能扩大授权范围；
 * - cursor = canonical base64url（FR03 SSOT 纪律），keyset tuple =
 *   (dueAt, createdAt, id) ASC 全列；
 * - DTO 最小化（queue privacy 冻结）：队列行绝不含 description /
 *   internalNote / email / phone；详情两阶段读（Stage A 最小 authority 锚点
 *   → 授权 → Stage B description/internal 字段），授权失败路径绝不触碰敏感列。
 */

export const SUPPORT_QUEUE_DEFAULT_PAGE_SIZE = 25;
export const SUPPORT_QUEUE_MAX_PAGE_SIZE = 50;

export type SupportQueueItemDto = {
  ticketId: string;
  status: SupportTicketStatus;
  category: string;
  campusName: string | null;
  /** 安全 requester displayName（missing/deleted/erased 统一 fallback） */
  requesterName: string;
  /** 领用人 displayName（privacy-safe；未领用 = null） */
  assignedAgent: string | null;
  subject: string;
  createdAt: string;
  dueAt: string;
  overdue: boolean;
};

export type SupportQueuePage = {
  items: SupportQueueItemDto[];
  nextCursor: string | null;
};

export type SupportQueueFilters = {
  campusId?: string;
  status?: SupportTicketStatus;
  assignment?: "mine" | "unassigned" | "all";
  overdueOnly?: boolean;
};

export type SupportCursor = { dueAt: Date; createdAt: Date; id: string };

/** 由实际返回的最后一条生成下一页 cursor（base64url(JSON)）。 */
export function encodeSupportCursor(cursor: SupportCursor): string {
  return Buffer.from(
    JSON.stringify({
      dueAt: cursor.dueAt.toISOString(),
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
  ).toString("base64url");
}

/** 解码客户端回传 cursor（FR03 canonical 纪律，SSOT helper）；任何解析/校验
 * 失败返回 null（调用方安全失败态）。 */
export function decodeSupportCursor(raw: string): SupportCursor | null {
  const payload = parseCanonicalCursorJson(raw, ["dueAt", "createdAt", "id"]);
  if (!payload) {
    return null;
  }
  const dueAt = parseCanonicalCursorDate(payload.dueAt);
  const createdAt = parseCanonicalCursorDate(payload.createdAt);
  if (!dueAt || !createdAt || payload.id.length === 0) {
    return null;
  }
  const cursor: SupportCursor = { dueAt, createdAt, id: payload.id };
  if (encodeSupportCursor(cursor) !== raw) {
    return null;
  }
  return cursor;
}

type SupportBranch = { campusId: string | null; scopeKey: string };

/** 授权分支集合（fail-closed：无有效 scope 时返回空数组 → 永远空页）。 */
export async function authorizedSupportBranches(
  access: SupportManageAccess,
): Promise<SupportBranch[]> {
  if (access.global) {
    const campuses = await prisma.campus.findMany({ select: { id: true } });
    return [{ campusId: null, scopeKey: "UNSCOPED" }, ...campuses.map((c) => ({ campusId: c.id, scopeKey: `CAMPUS:${c.id}` }))];
  }
  return access.campusIds.map((campusId) => ({ campusId, scopeKey: `CAMPUS:${campusId}` }));
}

/**
 * campus 过滤下拉选项（由授权 scope 派生，绝不提供越权选项）：
 * GLOBAL → 全部 active 校区；campus agent → 仅其有效 scope 校区。
 */
export async function listSupportQueueCampuses(
  access: SupportManageAccess,
): Promise<Array<{ id: string; name: string }>> {
  if (!access.global && access.campusIds.length === 0) {
    return [];
  }
  return prisma.campus.findMany({
    where: access.global
      ? { isActive: true }
      : { id: { in: access.campusIds }, isActive: true },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

/** keyset 条件（ASC 全 tuple：dueAt > ∨ (=∧createdAt >) ∨ (=∧=∧id >)）。 */
function supportKeysetCondition(cursor: SupportCursor): Prisma.SupportTicketWhereInput {
  return {
    OR: [
      { dueAt: { gt: cursor.dueAt } },
      { dueAt: { equals: cursor.dueAt }, createdAt: { gt: cursor.createdAt } },
      {
        dueAt: { equals: cursor.dueAt },
        createdAt: { equals: cursor.createdAt },
        id: { gt: cursor.id },
      },
    ],
  };
}

// 队列 select 结构性不含 description / internalNote / requester email/phone
const queueTicketSelect = {
  id: true,
  status: true,
  category: true,
  campusId: true,
  campus: { select: { name: true } },
  requesterId: true,
  subject: true,
  dueAt: true,
  createdAt: true,
  assignedToId: true,
} satisfies Prisma.SupportTicketSelect;

export async function loadAuthorizedSupportQueue(input: {
  viewerId: string;
  access: SupportManageAccess;
  cursor?: SupportCursor;
  limit: number;
  filters?: SupportQueueFilters;
}): Promise<SupportQueuePage> {
  const branches = await authorizedSupportBranches(input.access);

  // fail-closed：零有效 scope 永远空页（绝不让空 OR 退化为无条件匹配）
  if (branches.length === 0) {
    return { items: [], nextCursor: null };
  }

  const filters = input.filters ?? {};
  const scopePredicate: Prisma.SupportTicketWhereInput = {
    OR: branches.map((branch) => ({
      campusId: branch.campusId,
      scopeKey: branch.scopeKey,
    })),
  };

  const andConditions: Prisma.SupportTicketWhereInput[] = [scopePredicate];

  if (filters.campusId) {
    andConditions.push({ campusId: filters.campusId, scopeKey: `CAMPUS:${filters.campusId}` });
  }
  if (filters.status) {
    andConditions.push({ status: filters.status });
  }
  if (filters.assignment === "mine") {
    andConditions.push({ assignedToId: input.viewerId });
  } else if (filters.assignment === "unassigned") {
    andConditions.push({ assignedToId: null });
  }
  if (filters.overdueOnly) {
    // OVERDUE 只读判定 = active ∧ dueAt < now（DB 侧同语义前置过滤）
    andConditions.push({ status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: new Date() } });
  }
  if (input.cursor) {
    andConditions.push(supportKeysetCondition(input.cursor));
  }

  const rows = await prisma.supportTicket.findMany({
    where: { AND: andConditions },
    orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: input.limit + 1,
    select: queueTicketSelect,
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;

  const identityIds = pageRows.flatMap((row) =>
    row.assignedToId ? [row.requesterId, row.assignedToId] : [row.requesterId],
  );
  const identities = await hydrateSafeIdentities(identityIds);

  const now = new Date();
  const items = pageRows.map((row) => ({
    ticketId: row.id,
    status: row.status,
    category: row.category,
    campusName: row.campus?.name ?? null,
    requesterName: identities.get(row.requesterId)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME,
    assignedAgent:
      row.assignedToId !== null
        ? (identities.get(row.assignedToId)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME)
        : null,
    subject: row.subject,
    createdAt: row.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    overdue: isSupportTicketOverdue({ status: row.status, dueAt: row.dueAt }, now),
  }));

  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeSupportCursor({ dueAt: last.dueAt, createdAt: last.createdAt, id: last.id })
        : null,
  };
}

// ── 详情（两阶段读；每请求独立重授权，绝不信任队列可见性）──────────────────────

export type SupportDetailDto = {
  ticketId: string;
  status: SupportTicketStatus;
  category: string;
  campusName: string | null;
  requesterName: string;
  subject: string;
  /** 用户描述全文（Stage B：授权通过后才查询） */
  description: string;
  /** 操作员内部备注（OPERATOR_ONLY；queue 结构性不含） */
  internalNote: string | null;
  createdAt: string;
  dueAt: string;
  overdue: boolean;
  assignedAgent: { id: string; displayName: string } | null;
  selfAssigned: boolean;
  resolution: {
    code: string | null;
    /** USER_VISIBLE（内部沟通展示给操作员；requester 读面另有独立模型） */
    message: string | null;
    resolvedAt: string | null;
    resolvedByName: string | null;
  };
  /** viewer 对该工单 scope 的处理权（UI 控件呈现便利；域服务恒为权威） */
  scopeAuthorized: boolean;
};

export type SupportDetailResult = { ok: true; detail: SupportDetailDto } | { ok: false };

/**
 * 详情授权（FR02 两阶段读，7E 同款冻结顺序）：
 *
 *   Stage A — 最小 authority 锚点（仅 id/campusId/scopeKey/status，
 *   结构性不含 description/internalNote/requester 身份）
 *   → authorize（missing / malformed scope / 越权统一 { ok:false }，
 *   调用方映射 notFound()，无存在性 oracle）
 *   → Stage B — 授权通过后才进行敏感水合（description/internalNote/requester
 *   身份/终局信息）。
 */
export async function loadAuthorizedSupportDetail(input: {
  viewerId: string;
  context: AuthorizationContext;
  access: SupportManageAccess;
  ticketId: string;
}): Promise<SupportDetailResult> {
  // ---- Stage A：最小 authority 锚点（授权谓词所需字段，零敏感载荷） ----
  const anchor = await prisma.supportTicket.findUnique({
    where: { id: input.ticketId },
    select: {
      id: true,
      campusId: true,
      scopeKey: true,
      status: true,
    },
  });

  if (!anchor) {
    return { ok: false };
  }
  if (!canManageSupportScope(input.access, anchor)) {
    return { ok: false };
  }

  // ---- Stage B：授权通过后的敏感水合 ----
  const row = await prisma.supportTicket.findUnique({
    where: { id: input.ticketId },
    select: {
      id: true,
      status: true,
      category: true,
      campusId: true,
      scopeKey: true,
      campus: { select: { name: true } },
      requesterId: true,
      subject: true,
      description: true,
      internalNote: true,
      createdAt: true,
      dueAt: true,
      assignedToId: true,
      resolutionCode: true,
      resolutionMessage: true,
      resolvedAt: true,
      resolvedById: true,
    },
  });

  if (!row) {
    // Stage A 与 B 之间的极端竞态：与未授权同形，反 oracle
    return { ok: false };
  }
  // Stage A ↔ B 竞态复查：scope 快照 immutable，不一致即 fail closed
  if (row.campusId !== anchor.campusId || row.scopeKey !== anchor.scopeKey) {
    return { ok: false };
  }

  const identityIds = [row.requesterId, row.assignedToId, row.resolvedById].filter(
    (id): id is string => id !== null,
  );
  const identities = await hydrateSafeIdentities(identityIds);
  const fallbackName = (id: string) =>
    identities.get(id)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME;

  return {
    ok: true,
    detail: {
      ticketId: row.id,
      status: row.status,
      category: row.category,
      campusName: row.campus?.name ?? null,
      requesterName: fallbackName(row.requesterId),
      subject: row.subject,
      description: row.description,
      internalNote: row.internalNote,
      createdAt: row.createdAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
      overdue: isSupportTicketOverdue({ status: row.status, dueAt: row.dueAt }),
      assignedAgent:
        row.assignedToId !== null
          ? { id: row.assignedToId, displayName: fallbackName(row.assignedToId) }
          : null,
      selfAssigned: row.assignedToId !== null && row.assignedToId === input.viewerId,
      resolution: {
        code: row.resolutionCode,
        message: row.resolutionMessage,
        resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
        resolvedByName: row.resolvedById ? fallbackName(row.resolvedById) : null,
      },
      scopeAuthorized: canManageSupportScope(input.access, {
        campusId: row.campusId,
        scopeKey: row.scopeKey,
      }),
    },
  };
}
