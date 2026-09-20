import type { Prisma, RentalDisputeStatus } from "@prisma/client";

import {
  parseCanonicalCursorDate,
  parseCanonicalCursorJson,
} from "@/lib/governance/canonical-cursor";
import { hydrateSafeIdentities, UNAVAILABLE_USER_DISPLAY_NAME } from "@/lib/governance/safe-identity";
import { prisma } from "@/lib/prisma";
import {
  canReviewDisputeCampus,
  DISPUTE_EVIDENCE_PERMISSION,
  type DisputeReviewAccess,
} from "@/lib/disputes/dispute-access";
import { isDisputeOverdue } from "@/lib/disputes/dispute-sla";
import { disputeReviewCampusBranch, resolveDisputeScope } from "@/lib/disputes/dispute-scope";
import { hasPermission, type AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7G：纠纷运营队列/详情授权读模型（operator surface 专用）。
 *
 * 授权在 DB 查询内完成（7A/7E 同款冻结）——绝不"取全量后内存过滤"：
 * - 分支集合由 deriveDisputeReviewAccess 的有效 scope 派生；
 * - 每个分支是 (campusId, scopeKey) exact 合取；GLOBAL 读者 = 权威 Campus
 *   全表枚举的 exact pair（FK 保证 canonical 行必在 Campus 内 → 分支集完备）；
 *   campus reviewer → 仅其有效校区的 exact pair；
 * - 所有 requested filter（campus/status/assignment/overdue）恒 AND 在 scope
 *   谓词之内——filter 永远不能扩大授权范围；
 * - cursor = canonical base64url（FR03 SSOT 纪律：exact keys / canonical ISO /
 *   re-encode equality），keyset tuple = (dueAt, createdAt, id) ASC 全列；
 * - DTO 最小化（queue privacy 冻结）：队列行绝不含 reason / evidencePhotos /
 *   adminNote / 私有 asset ref / email / phone；身份一律批量安全水合
 *   （missing/deleted/erased 统一 fallback）；详情仅在授权通过后进行 Stage B
 *   敏感水合（两阶段读，授权失败路径绝不触碰敏感列）。
 */

export const DISPUTE_QUEUE_DEFAULT_PAGE_SIZE = 25;
export const DISPUTE_QUEUE_MAX_PAGE_SIZE = 50;

export type DisputeQueueItemDto = {
  disputeId: string;
  status: RentalDisputeStatus;
  campusId: string;
  campusName: string;
  /** 安全订单摘要（订单号 + 租赁标题；无 PII） */
  safeOrderLabel: string;
  /** 发起人安全身份 displayName（missing/deleted/erased 统一 fallback） */
  initiatorName: string;
  /** 领用人 displayName（privacy-safe；未领用 = null） */
  assignedReviewer: string | null;
  createdAt: string;
  dueAt: string;
  overdue: boolean;
};

export type DisputeQueuePage = {
  items: DisputeQueueItemDto[];
  nextCursor: string | null;
};

export type DisputeQueueFilters = {
  campusId?: string;
  status?: RentalDisputeStatus;
  assignment?: "mine" | "unassigned" | "all";
  overdueOnly?: boolean;
};

export type DisputeCursor = { dueAt: Date; createdAt: Date; id: string };

/** 由实际返回的最后一条生成下一页 cursor（base64url(JSON)）。 */
export function encodeDisputeCursor(cursor: DisputeCursor): string {
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
export function decodeDisputeCursor(raw: string): DisputeCursor | null {
  const payload = parseCanonicalCursorJson(raw, ["dueAt", "createdAt", "id"]);
  if (!payload) {
    return null;
  }
  const dueAt = parseCanonicalCursorDate(payload.dueAt);
  const createdAt = parseCanonicalCursorDate(payload.createdAt);
  if (!dueAt || !createdAt || payload.id.length === 0) {
    return null;
  }
  const cursor: DisputeCursor = { dueAt, createdAt, id: payload.id };
  // canonical 外层编码 + canonical JSON 键序的最终权威（FR03）
  if (encodeDisputeCursor(cursor) !== raw) {
    return null;
  }
  return cursor;
}

/** 授权分支集合（fail-closed：无有效 scope 时返回空数组 → 永远空页）。 */
export async function authorizedDisputeBranches(
  access: DisputeReviewAccess,
): Promise<Array<{ campusId: string; scopeKey: string }>> {
  if (access.global) {
    const campuses = await prisma.campus.findMany({ select: { id: true } });
    return campuses.map((c) => disputeReviewCampusBranch(c.id));
  }
  return access.campusIds.map((campusId) => disputeReviewCampusBranch(campusId));
}

/**
 * campus 过滤下拉选项（由授权 scope 派生，绝不提供越权选项）：
 * GLOBAL → 全部 active 校区；campus reviewer → 仅其有效 scope 校区。
 */
export async function listDisputeQueueCampuses(
  access: DisputeReviewAccess,
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
function disputeKeysetCondition(cursor: DisputeCursor): Prisma.RentalDisputeWhereInput {
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

// 队列 select 结构性不含 reason / evidencePhotos / adminNote（queue privacy 冻结）
const queueDisputeSelect = {
  id: true,
  status: true,
  campusId: true,
  campus: { select: { name: true } },
  initiatorId: true,
  dueAt: true,
  createdAt: true,
  assignedToId: true,
  order: {
    select: {
      orderNumber: true,
      rentalListing: { select: { title: true } },
    },
  },
} satisfies Prisma.RentalDisputeSelect;

export async function loadAuthorizedDisputeQueue(input: {
  viewerId: string;
  access: DisputeReviewAccess;
  cursor?: DisputeCursor;
  limit: number;
  filters?: DisputeQueueFilters;
}): Promise<DisputeQueuePage> {
  const branches = await authorizedDisputeBranches(input.access);

  // fail-closed：零有效 scope 永远空页（绝不让空 OR 退化为无条件匹配）
  if (branches.length === 0) {
    return { items: [], nextCursor: null };
  }

  const filters = input.filters ?? {};
  const scopePredicate: Prisma.RentalDisputeWhereInput = {
    OR: branches.map((branch) => ({
      campusId: branch.campusId,
      scopeKey: branch.scopeKey,
    })),
  };

  const andConditions: Prisma.RentalDisputeWhereInput[] = [scopePredicate];

  // requested filters 恒 AND 在 scope 谓词之内（不能扩大授权范围）
  if (filters.campusId) {
    andConditions.push({
      campusId: filters.campusId,
      scopeKey: disputeReviewCampusBranch(filters.campusId).scopeKey,
    });
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
    andConditions.push({ status: { in: ["OPEN", "IN_REVIEW"] }, dueAt: { lt: new Date() } });
  }
  if (input.cursor) {
    andConditions.push(disputeKeysetCondition(input.cursor));
  }

  const rows = await prisma.rentalDispute.findMany({
    where: { AND: andConditions },
    orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: input.limit + 1,
    select: queueDisputeSelect,
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;

  const identityIds = pageRows.flatMap((row) =>
    row.assignedToId ? [row.initiatorId, row.assignedToId] : [row.initiatorId],
  );
  const identities = await hydrateSafeIdentities(identityIds);

  const now = new Date();
  const items = pageRows.map((row) => ({
    disputeId: row.id,
    status: row.status,
    campusId: row.campusId,
    campusName: row.campus?.name ?? "未知校区",
    safeOrderLabel: `订单 ${row.order.orderNumber} · ${row.order.rentalListing.title}`,
    initiatorName: identities.get(row.initiatorId)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME,
    assignedReviewer:
      row.assignedToId !== null
        ? (identities.get(row.assignedToId)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME)
        : null,
    createdAt: row.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    overdue: isDisputeOverdue({ status: row.status, dueAt: row.dueAt }, now),
  }));

  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeDisputeCursor({ dueAt: last.dueAt, createdAt: last.createdAt, id: last.id })
        : null,
  };
}

// ── 详情（两阶段读；每请求独立重授权，绝不信任队列可见性）──────────────────────

export type DisputeDetailDto = {
  disputeId: string;
  status: RentalDisputeStatus;
  campusId: string;
  campusName: string;
  orderId: string;
  safeOrderLabel: string;
  /** 纠纷发起人安全身份 */
  initiatorName: string;
  /** 出租者 / 租客安全身份（订单当事人） */
  ownerName: string;
  renterName: string;
  /** 纠纷描述全文（Stage B：授权通过后才查询） */
  reason: string;
  /** 证据 asset:<id> token 列表（Stage B；实际读取必须经 /api/assets 独立鉴权） */
  evidenceRefs: string[];
  /** 操作员内部备注（Stage B；queue 结构性不含） */
  adminNote: string | null;
  createdAt: string;
  dueAt: string;
  overdue: boolean;
  assignedReviewer: { id: string; displayName: string } | null;
  selfAssigned: boolean;
  resolution: {
    code: string | null;
    action: string | null;
    resolvedAt: string | null;
    resolvedByName: string | null;
  };
  openedFromOrderStatus: string | null;
  /** viewer 对该 dispute 校区的审核权（UI 控件呈现便利；域服务恒为权威） */
  scopeAuthorized: boolean;
  /** viewer 是否可呈现证据查看入口（UI 便利；实际读取仍经 asset API 独立鉴权） */
  canViewEvidence: boolean;
};

export type DisputeDetailResult = { ok: true; detail: DisputeDetailDto } | { ok: false };

/**
 * 详情授权（FR02 两阶段读，7E 同款冻结顺序）：
 *
 *   Stage A — 最小 authority 锚点（仅 id/campusId/scopeKey/status/orderId，
 *   结构性不含 reason/evidence/adminNote/当事人身份）
 *   → authorize（missing / malformed scope / 越权统一 { ok:false }，
 *   调用方映射 notFound()，无存在性 oracle）
 *   → Stage B — 授权通过后才进行敏感水合（reason/evidencePhotos/adminNote/
 *   当事人身份/终局信息）。
 *
 * 授权失败路径绝不触碰任何敏感列（queue privacy / D02-D04 同款）。
 */
export async function loadAuthorizedDisputeDetail(input: {
  viewerId: string;
  context: AuthorizationContext;
  access: DisputeReviewAccess;
  disputeId: string;
}): Promise<DisputeDetailResult> {
  // ---- Stage A：最小 authority 锚点（授权谓词所需字段，零敏感载荷） ----
  const anchor = await prisma.rentalDispute.findUnique({
    where: { id: input.disputeId },
    select: {
      id: true,
      campusId: true,
      scopeKey: true,
      status: true,
      orderId: true,
    },
  });

  if (!anchor) {
    return { ok: false };
  }

  const scope = resolveDisputeScope({
    campusId: anchor.campusId,
    scopeKey: anchor.scopeKey,
  });
  if (!scope) {
    return { ok: false };
  }
  if (!canReviewDisputeCampus(input.access, scope.campusId)) {
    return { ok: false };
  }

  // ---- Stage B：授权通过后的敏感水合 ----
  const row = await prisma.rentalDispute.findUnique({
    where: { id: input.disputeId },
    select: {
      id: true,
      status: true,
      campusId: true,
      campus: { select: { name: true } },
      scopeKey: true,
      initiatorId: true,
      reason: true,
      evidencePhotos: true,
      adminNote: true,
      createdAt: true,
      dueAt: true,
      assignedToId: true,
      resolutionCode: true,
      resolutionAction: true,
      resolvedAt: true,
      resolvedById: true,
      openedFromOrderStatus: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          ownerId: true,
          renterId: true,
          rentalListing: { select: { title: true } },
        },
      },
    },
  });

  if (!row) {
    // Stage A 与 B 之间的极端竞态（行被删除）：与未授权同形，反 oracle
    return { ok: false };
  }
  // Stage A ↔ B 竞态复查：campus 快照 immutable，不一致即 fail closed
  if (row.campusId !== anchor.campusId || row.scopeKey !== anchor.scopeKey) {
    return { ok: false };
  }

  const identityIds = [
    row.initiatorId,
    row.order.ownerId,
    row.order.renterId,
    row.assignedToId,
    row.resolvedById,
  ].filter((id): id is string => id !== null);
  const identities = await hydrateSafeIdentities(identityIds);

  const fallbackName = (id: string) =>
    identities.get(id)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME;

  return {
    ok: true,
    detail: {
      disputeId: row.id,
      status: row.status,
      campusId: row.campusId,
      campusName: row.campus?.name ?? "未知校区",
      orderId: row.order.id,
      safeOrderLabel: `订单 ${row.order.orderNumber} · ${row.order.rentalListing.title}`,
      initiatorName: fallbackName(row.initiatorId),
      ownerName: fallbackName(row.order.ownerId),
      renterName: fallbackName(row.order.renterId),
      reason: row.reason,
      evidenceRefs: row.evidencePhotos,
      adminNote: row.adminNote,
      createdAt: row.createdAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
      overdue: isDisputeOverdue({ status: row.status, dueAt: row.dueAt }),
      assignedReviewer:
        row.assignedToId !== null
          ? { id: row.assignedToId, displayName: fallbackName(row.assignedToId) }
          : null,
      selfAssigned: row.assignedToId !== null && row.assignedToId === input.viewerId,
      resolution: {
        code: row.resolutionCode,
        action: row.resolutionAction,
        resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
        resolvedByName: row.resolvedById ? fallbackName(row.resolvedById) : null,
      },
      openedFromOrderStatus: row.openedFromOrderStatus,
      scopeAuthorized: canReviewDisputeCampus(input.access, row.campusId),
      canViewEvidence:
        hasPermission(input.context, DISPUTE_EVIDENCE_PERMISSION, row.campusId) ||
        hasPermission(input.context, "asset.sensitive.read", row.campusId),
    },
  };
}
