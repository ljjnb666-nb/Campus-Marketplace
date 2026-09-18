import type { Prisma, ReportReason, ReportStatus, ReportTargetType } from "@prisma/client";

import { hydrateSafeIdentities, UNAVAILABLE_USER_DISPLAY_NAME } from "@/lib/governance/safe-identity";
import { isModerationCaseOverdue } from "@/lib/reports/moderation-case-sync";
import { prisma } from "@/lib/prisma";
import { canReviewReportScope, type ReportReviewAccess } from "@/lib/reports/report-access";
import {
  reportScopeLabel,
  reportReviewCampusBranch,
  reportReviewUnscopedBranch,
  resolveReportReviewScope,
} from "@/lib/reports/report-scope";
import type { AuthorizationContext } from "@/lib/rbac/service";
import { hasPermission } from "@/lib/rbac/service";

/**
 * Phase 7E：举报运营队列/详情授权读模型（operator surface 专用）。
 *
 * 授权在 DB 查询内完成——绝不"取全量后内存过滤"（7A 同款冻结）：
 * - 分支集合由 deriveReportReviewAccess 的有效 scope 派生；
 * - 每个分支是 (campusId, scopeKey) exact 合取（campusId 与 scopeKey 由同一
 *   campusId 派生，禁止叉积）；GLOBAL 读者 = UNSCOPED 分支 + 权威 Campus
 *   全表枚举的 exact pair（FK 保证 canonical 行必在 Campus 内 → 分支集完备）；
 * - malformed 交叉对结构上不命中任何分支（DB CHECK 兜底 + 分支 fail closed）；
 * - 所有 requested filter（campus/status/targetType/reason/assignment/overdue）
 *   恒 AND 在 scope 谓词之内——filter 永远不能扩大授权范围；
 * - cursor 只是 UNTRUSTED 分页位置（base64url），伪造只能改变位置，改变不了
 *   授权范围；keyset tuple = (dueAt, createdAt, id) ASC 全列（稳定 tie-break）。
 *
 * DTO 最小化（P01-P04 冻结）：队列行绝不含 report detail / handledNote /
 * message content / email / phone / studentId / 私有资产 URL / raw metadata；
 * 目标 USER / 举报人身份一律走批量安全身份水合（missing/deleted/erased 统一
 * fallback，互不可区分）；详情仅在授权通过后查询，仍不携带无必要 PII。
 */

export const REPORT_QUEUE_DEFAULT_PAGE_SIZE = 25;
export const REPORT_QUEUE_MAX_PAGE_SIZE = 50;

export type ReportQueueItemDto = {
  reportId: string;
  caseId: string;
  reason: ReportReason;
  status: ReportStatus;
  targetType: ReportTargetType;
  safeTargetLabel: string;
  scopeLabel: string;
  createdAt: string;
  dueAt: string;
  overdue: boolean;
  /** 领用人 displayName（privacy-safe；未领用 = null） */
  assignedReviewer: string | null;
};

export type ReportQueuePage = {
  items: ReportQueueItemDto[];
  nextCursor: string | null;
};

export type ReportQueueFilters = {
  campusId?: string;
  status?: ReportStatus;
  targetType?: ReportTargetType;
  reason?: ReportReason;
  assignment?: "mine" | "unassigned" | "all";
  overdueOnly?: boolean;
};

export type ReportCursor = { dueAt: Date; createdAt: Date; id: string };

/** 由实际返回的最后一条 case 生成下一页 cursor（base64url(JSON)）。 */
export function encodeReportCursor(cursor: ReportCursor): string {
  return Buffer.from(
    JSON.stringify({
      dueAt: cursor.dueAt.toISOString(),
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
  ).toString("base64url");
}

/** 解码客户端回传 cursor；任何解析/校验失败返回 null（调用方安全失败态）。 */
export function decodeReportCursor(raw: string): ReportCursor | null {
  let payload: unknown;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const { dueAt, createdAt, id } = payload as Record<string, unknown>;
  if (typeof dueAt !== "string" || typeof createdAt !== "string" || typeof id !== "string" || id.length === 0) {
    return null;
  }
  const dueAtDate = new Date(dueAt);
  const createdAtDate = new Date(createdAt);
  if (Number.isNaN(dueAtDate.getTime()) || Number.isNaN(createdAtDate.getTime())) {
    return null;
  }
  return { dueAt: dueAtDate, createdAt: createdAtDate, id };
}

/** 授权分支集合（fail-closed：无有效 scope 时返回空数组 → 永远空页）。 */
async function authorizedReportBranches(
  access: ReportReviewAccess,
): Promise<Array<{ campusId: string | null; scopeKey: string }>> {
  if (access.global) {
    const campuses = await prisma.campus.findMany({ select: { id: true } });
    return [reportReviewUnscopedBranch(), ...campuses.map((c) => reportReviewCampusBranch(c.id))];
  }
  return access.campusIds.map((campusId) => reportReviewCampusBranch(campusId));
}

/**
 * campus 过滤下拉选项（由授权 scope 派生，绝不提供越权选项）：
 * GLOBAL → 全部 active 校区；campus reviewer → 仅其有效 scope 校区。
 * 与 7B loadManageableRoleCampuses 同构（presentation-only，授权谓词独立）。
 */
export async function listReportQueueCampuses(
  access: ReportReviewAccess,
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

/** keyset 条件（ASC 全 tuple：dueAt > ∨ (=∧createdAt >) ∨ (=∧id >)）。 */
function reportKeysetCondition(cursor: ReportCursor): Prisma.ModerationCaseWhereInput {
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

const queueCaseSelect = {
  id: true,
  campusId: true,
  scopeKey: true,
  dueAt: true,
  closedAt: true,
  assignedToId: true,
  createdAt: true,
  report: {
    select: {
      id: true,
      reason: true,
      status: true,
      targetType: true,
      createdAt: true,
      campusId: true,
      campus: { select: { name: true } },
      product: { select: { title: true } },
      errandTask: { select: { title: true } },
      serviceListing: { select: { title: true } },
      rentalListing: { select: { title: true } },
      targetUserId: true,
      // messageId / message content / reporter 私有字段结构性不在 select 内
    },
  },
} satisfies Prisma.ModerationCaseSelect;

type SafeTargetLabelSource = {
  targetType: ReportTargetType;
  product: { title: string } | null;
  errandTask: { title: string } | null;
  serviceListing: { title: string } | null;
  rentalListing: { title: string } | null;
  targetUserId: string | null;
};

function buildSafeTargetLabel(
  row: SafeTargetLabelSource,
  userNames: Map<string, string>,
): string {
  switch (row.targetType) {
    case "PRODUCT":
      return row.product ? `商品：${row.product.title}` : "商品（目标不可用）";
    case "ERRAND_TASK":
      return row.errandTask ? `任务：${row.errandTask.title}` : "任务（目标不可用）";
    case "SERVICE_LISTING":
      return row.serviceListing ? `服务：${row.serviceListing.title}` : "服务（目标不可用）";
    case "RENTAL_LISTING":
      return row.rentalListing ? `租赁：${row.rentalListing.title}` : "租赁（目标不可用）";
    case "USER":
      return `用户：${row.targetUserId ? (userNames.get(row.targetUserId) ?? UNAVAILABLE_USER_DISPLAY_NAME) : UNAVAILABLE_USER_DISPLAY_NAME}`;
    case "MESSAGE":
      // P03：队列绝不携带消息内容
      return "消息举报";
    default:
      return "未知目标";
  }
}

export async function loadAuthorizedReportQueue(input: {
  viewerId: string;
  access: ReportReviewAccess;
  cursor?: ReportCursor;
  limit: number;
  filters?: ReportQueueFilters;
}): Promise<ReportQueuePage> {
  const branches = await authorizedReportBranches(input.access);

  // fail-closed：零有效 scope 永远空页（绝不让空 OR 退化为无条件匹配）
  if (branches.length === 0) {
    return { items: [], nextCursor: null };
  }

  const filters = input.filters ?? {};
  const scopePredicate: Prisma.ModerationCaseWhereInput = {
    OR: branches.map((branch) => ({
      campusId: branch.campusId,
      scopeKey: branch.scopeKey,
    })),
  };

  const andConditions: Prisma.ModerationCaseWhereInput[] = [scopePredicate];

  // requested filters 恒 AND 在 scope 谓词之内（不能扩大授权范围）
  if (filters.campusId) {
    andConditions.push({ campusId: filters.campusId, scopeKey: `CAMPUS:${filters.campusId}` });
  }
  if (filters.status) {
    andConditions.push({ report: { status: filters.status } });
  }
  if (filters.targetType) {
    andConditions.push({ report: { targetType: filters.targetType } });
  }
  if (filters.reason) {
    andConditions.push({ report: { reason: filters.reason } });
  }
  if (filters.assignment === "mine") {
    andConditions.push({ assignedToId: input.viewerId });
  } else if (filters.assignment === "unassigned") {
    andConditions.push({ assignedToId: null });
  }
  if (filters.overdueOnly) {
    andConditions.push({ closedAt: null, dueAt: { lt: new Date() } });
  }
  if (input.cursor) {
    andConditions.push(reportKeysetCondition(input.cursor));
  }

  const rows = await prisma.moderationCase.findMany({
    where: { AND: andConditions },
    orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: input.limit + 1,
    select: queueCaseSelect,
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;

  const assigneeIds = pageRows
    .map((row) => row.assignedToId)
    .filter((id): id is string => id !== null);
  const targetUserIds = pageRows
    .map((row) => row.report.targetUserId)
    .filter((id): id is string => id !== null);
  const [assigneeIdentities, targetUserIdentities] = await Promise.all([
    hydrateSafeIdentities(assigneeIds),
    hydrateSafeIdentities(targetUserIds),
  ]);
  const assigneeNames = new Map(
    [...assigneeIdentities.entries()].map(([id, identity]) => [id, identity.displayName]),
  );
  const targetUserNames = new Map(
    [...targetUserIdentities.entries()].map(([id, identity]) => [id, identity.displayName]),
  );

  const now = new Date();
  const items = pageRows.map((row) => ({
    reportId: row.report.id,
    caseId: row.id,
    reason: row.report.reason,
    status: row.report.status,
    targetType: row.report.targetType,
    safeTargetLabel: buildSafeTargetLabel(row.report, targetUserNames),
    scopeLabel: reportScopeLabel(row.report.campusId, row.report.campus?.name ?? null),
    createdAt: row.report.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    overdue: isModerationCaseOverdue({ closedAt: row.closedAt, dueAt: row.dueAt }, now),
    assignedReviewer:
      row.assignedToId !== null ? (assigneeNames.get(row.assignedToId) ?? UNAVAILABLE_USER_DISPLAY_NAME) : null,
  }));

  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeReportCursor({ dueAt: last.dueAt, createdAt: last.createdAt, id: last.id })
        : null,
  };
}

// ── 详情（每请求独立重授权，绝不信任队列可见性）──────────────────────────────

export type ReportDetailDto = {
  reportId: string;
  caseId: string;
  status: ReportStatus;
  reason: ReportReason;
  targetType: ReportTargetType;
  /** 举报人提交的说明文本（详情面允许；队列结构性不含） */
  detail: string | null;
  safeTargetLabel: string;
  scopeLabel: string;
  /** 举报人安全身份（missing/deleted/erased 统一 fallback） */
  reporterName: string;
  createdAt: string;
  handledAt: string | null;
  /** 上次处理备注（详情面允许；队列结构性不含——P02） */
  handledNote: string | null;
  caseTiming: {
    openedAt: string;
    dueAt: string;
    lastActivityAt: string;
    closedAt: string | null;
    overdue: boolean;
  };
  assignedReviewer: { id: string; displayName: string } | null;
  selfAssigned: boolean;
  /** viewer 对该 report scope 的审核权（UI 控件呈现便利；域服务恒为权威） */
  scopeAuthorized: boolean;
};

export type ReportDetailResult = { ok: true; detail: ReportDetailDto } | { ok: false };

/**
 * 详情授权（FR02 两阶段读，Final Review Repair 1 冻结顺序）：
 *
 *   Stage A — 最小 authority 锚点（仅 id/campusId/scopeKey/case 存在性，
 *   结构性不含 detail/handledNote/reporterId/目标内容/身份字段）
 *   → authorize（missing/缺 case/malformed scope/越权 统一 { ok:false }，
 *   调用方映射 notFound()，无存在性 oracle——P05/P06）
 *   → Stage B — 授权通过后才进行敏感水合（detail/handledNote/目标关系/
 *   case 时钟/assignedToId）+ 批量安全身份水合。
 *
 * 授权失败路径绝不触碰任何敏感列（D02/D03/D04）。
 */
export async function loadAuthorizedReportDetail(input: {
  viewerId: string;
  context: AuthorizationContext;
  access: ReportReviewAccess;
  reportId: string;
}): Promise<ReportDetailResult> {
  // ---- Stage A：最小 authority 锚点（授权谓词所需字段，零敏感载荷） ----
  const anchor = await prisma.report.findUnique({
    where: { id: input.reportId },
    select: {
      id: true,
      campusId: true,
      scopeKey: true,
      moderationCase: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!anchor || !anchor.moderationCase) {
    return { ok: false };
  }

  const scope = resolveReportReviewScope({
    campusId: anchor.campusId,
    scopeKey: anchor.scopeKey,
  });
  if (!scope) {
    return { ok: false };
  }
  if (!canReviewReportScope(input.access, scope)) {
    return { ok: false };
  }

  // ---- Stage B：授权通过后的敏感水合 ----
  const row = await prisma.report.findUnique({
    where: { id: input.reportId },
    select: {
      id: true,
      status: true,
      reason: true,
      targetType: true,
      detail: true,
      createdAt: true,
      handledAt: true,
      handledNote: true,
      reporterId: true,
      campusId: true,
      campus: { select: { name: true } },
      product: { select: { title: true } },
      errandTask: { select: { title: true } },
      serviceListing: { select: { title: true } },
      rentalListing: { select: { title: true } },
      targetUserId: true,
      moderationCase: {
        select: {
          id: true,
          openedAt: true,
          dueAt: true,
          lastActivityAt: true,
          closedAt: true,
          assignedToId: true,
        },
      },
    },
  });

  if (!row || !row.moderationCase) {
    // Stage A 与 B 之间的极端竞态（行被删除）：与未授权同形，反 oracle
    return { ok: false };
  }

  const identityIds = [row.reporterId, row.targetUserId, row.moderationCase.assignedToId].filter(
    (id): id is string => id !== null,
  );
  const identities = await hydrateSafeIdentities(identityIds);
  const reporter = identities.get(row.reporterId);
  const assignee = row.moderationCase.assignedToId
    ? identities.get(row.moderationCase.assignedToId)
    : undefined;

  const safeTargetLabel = buildSafeTargetLabel(
    row,
    new Map([...identities.entries()].map(([id, identity]) => [id, identity.displayName])),
  );

  return {
    ok: true,
    detail: {
      reportId: row.id,
      caseId: row.moderationCase.id,
      status: row.status,
      reason: row.reason,
      targetType: row.targetType,
      detail: row.detail,
      safeTargetLabel,
      scopeLabel: reportScopeLabel(row.campusId, row.campus?.name ?? null),
      reporterName: reporter?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME,
      createdAt: row.createdAt.toISOString(),
      handledAt: row.handledAt ? row.handledAt.toISOString() : null,
      handledNote: row.handledNote,
      caseTiming: {
        openedAt: row.moderationCase.openedAt.toISOString(),
        dueAt: row.moderationCase.dueAt.toISOString(),
        lastActivityAt: row.moderationCase.lastActivityAt.toISOString(),
        closedAt: row.moderationCase.closedAt ? row.moderationCase.closedAt.toISOString() : null,
        overdue: isModerationCaseOverdue(
          { closedAt: row.moderationCase.closedAt, dueAt: row.moderationCase.dueAt },
        ),
      },
      assignedReviewer:
        row.moderationCase.assignedToId && assignee
          ? { id: row.moderationCase.assignedToId, displayName: assignee.displayName }
          : null,
      selfAssigned:
        row.moderationCase.assignedToId !== null &&
        row.moderationCase.assignedToId === input.viewerId,
      scopeAuthorized: hasPermission(
        input.context,
        "report.review",
        scope.kind === "CAMPUS" ? scope.campusId : null,
      ),
    },
  };
}
