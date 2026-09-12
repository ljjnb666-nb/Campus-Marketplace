import type { AppealDecisionReasonCode, AppealStatus, EnforcementActionType, EnforcementReasonCode, Prisma } from "@prisma/client";

import { encodeAppealCursor, type AppealCursor } from "@/validators/appeal";
import {
  appealReviewCampusBranch,
  appealReviewGlobalBranch,
  resolveAppealReviewScope,
} from "@/lib/appeals/review-scope";
import {
  deriveAppealReviewCapabilities,
  canReviewScope,
  type AppealReviewAccess,
  type AppealReviewCapabilities,
} from "@/lib/appeals/reviewer-access";
import { prisma } from "@/lib/prisma";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7A：申诉审核队列/详情授权读模型（operator surface 专用）。
 *
 * 授权在 DB 查询内完成（Planning §14/§15/§16 冻结）——绝不"取全量后内存过滤"：
 * - 分支集合由 deriveAppealReviewAccess 的有效 scope 派生；
 * - 每个分支是 (type, campusId, scopeKey) exact canonical 合取
 *   （appealReviewGlobalBranch / appealReviewCampusBranch），malformed 交叉对
 *   结构性不命中任何分支；
 * - GLOBAL reviewer：GLOBAL 三元 + 权威 Campus 全表枚举的 exact pair
 *   （FK 保证 canonical CAMPUS 行 campusId 必在 Campus 内 → 分支集完备）；
 * - campus reviewer：仅其有效校区（grant ∧ ACTIVE membership）的 exact pair。
 *
 * 分页 = 6C-2 已验证的 bounded keyset（default 25 / max 50 / createdAt DESC,
 * id DESC / base64url cursor）：cursor 只是 UNTRUSTED 分页位置，scope 过滤
 * 独立附加——结构合法的伪造 cursor 只能改变位置，永远改变不了授权范围。
 *
 * DTO 最小化（Planning §18/§22 冻结）：队列/详情均不含 statement 之外的
 * 机密面（队列无 statement；decisionNote/EA.note/sourceId/email/phone/
 * AdminAudit 结构性不在 select 内）。
 */

const QUEUE_STATUSES: AppealStatus[] = ["SUBMITTED", "IN_REVIEW"];

export type AppealQueueItemDto = {
  id: string;
  status: AppealStatus;
  createdAt: string;
  enforcementType: EnforcementActionType;
  scopeKind: "GLOBAL" | "CAMPUS";
  /** CAMPUS 行的校区显示名；GLOBAL 行恒 null */
  campusName: string | null;
  appellantName: string;
  /** viewer 是否为该处罚的原执行者（self-review 预警，域允许 + 审计显式） */
  selfReview: boolean;
};

export type AppealQueuePage = {
  items: AppealQueueItemDto[];
  nextCursor: string | null;
};

/** 授权分支集合（fail-closed：无有效 scope 时返回不可能命中的空数组）。 */
async function authorizedEnforcementBranches(
  access: AppealReviewAccess,
): Promise<Prisma.EnforcementActionWhereInput[]> {
  if (access.global) {
    const campuses = await prisma.campus.findMany({ select: { id: true } });
    return [appealReviewGlobalBranch(), ...campuses.map((c) => appealReviewCampusBranch(c.id))];
  }
  return access.campusIds.map((campusId) => appealReviewCampusBranch(campusId));
}

function keysetCondition(cursor: AppealCursor): Prisma.AppealWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      {
        AND: [{ createdAt: { equals: cursor.createdAt } }, { id: { lt: cursor.id } }],
      },
    ],
  };
}

export async function loadAuthorizedAppealQueue(input: {
  viewerId: string;
  access: AppealReviewAccess;
  cursor?: AppealCursor;
  limit: number;
}): Promise<AppealQueuePage> {
  const branches = await authorizedEnforcementBranches(input.access);

  // fail-closed（与 DEFAULT_DENY 同语义）：零有效 scope 永远空页，
  // 绝不让空 OR 分支集在 SQL 层退化为无条件匹配。
  if (branches.length === 0) {
    return { items: [], nextCursor: null };
  }

  const rows = await prisma.appeal.findMany({
    where: {
      status: { in: QUEUE_STATUSES },
      ...(input.cursor ? keysetCondition(input.cursor) : {}),
      enforcementAction: { OR: branches },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: {
      id: true,
      status: true,
      createdAt: true,
      enforcementAction: {
        select: {
          type: true,
          actorId: true,
          campusId: true,
          campus: { select: { name: true } },
          target: { select: { name: true } },
        },
      },
    },
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const last = pageRows[pageRows.length - 1];

  return {
    items: pageRows.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      enforcementType: row.enforcementAction.type,
      scopeKind: row.enforcementAction.campusId === null ? "GLOBAL" : "CAMPUS",
      campusName: row.enforcementAction.campus?.name ?? null,
      appellantName: row.enforcementAction.target.name ?? "未知用户",
      selfReview: row.enforcementAction.actorId === input.viewerId,
    })),
    nextCursor:
      hasMore && last ? encodeAppealCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

// ── 详情（每请求独立重授权，绝不信任队列可见性）──────────────────────────────

export type AppealDetailDto = {
  id: string;
  status: AppealStatus;
  statement: string;
  createdAt: string;
  /** 申诉终局原因码（terminal 后展示；机器码，隐私导出 v2 对 appellant 同样披露） */
  decisionReasonCode: AppealDecisionReasonCode | null;
  enforcement: {
    type: EnforcementActionType;
    createdAt: string;
    reasonCode: EnforcementReasonCode | null;
    previousState: string | null;
    scopeKind: "GLOBAL" | "CAMPUS";
    campusName: string | null;
  };
  appellantName: string;
  selfReview: boolean;
};

export type AppealDetailResult =
  | { ok: true; detail: AppealDetailDto; capabilities: AppealReviewCapabilities }
  | { ok: false };

/**
 * 详情授权（Planning §21 冻结顺序）：
 * missing → malformed scope → reviewer==appellant → scope 授权，全部统一
 * { ok: false }（调用方映射 notFound()，无存在性 oracle）；
 * capability hints 由 deriveAppealReviewCapabilities 派生（W1：SUBMITTED 仅
 * begin，IN_REVIEW 终局控件；canGrant 额外要求 canonical 恢复权）。
 */
export async function loadAuthorizedAppealDetail(input: {
  viewerId: string;
  context: AuthorizationContext;
  access: AppealReviewAccess;
  appealId: string;
}): Promise<AppealDetailResult> {
  const row = await prisma.appeal.findUnique({
    where: { id: input.appealId },
    select: {
      id: true,
      status: true,
      statement: true,
      createdAt: true,
      decisionReasonCode: true,
      enforcementAction: {
        select: {
          type: true,
          actorId: true,
          targetId: true,
          campusId: true,
          scopeKey: true,
          createdAt: true,
          reasonCode: true,
          previousState: true,
          campus: { select: { name: true } },
          target: { select: { name: true } },
        },
      },
    },
  });

  if (!row) {
    return { ok: false };
  }

  const action = row.enforcementAction;
  const scope = resolveAppealReviewScope({
    type: action.type,
    campusId: action.campusId,
    scopeKey: action.scopeKey,
  });
  if (!scope) {
    return { ok: false };
  }
  if (input.viewerId === action.targetId) {
    return { ok: false };
  }
  if (!canReviewScope(input.access, scope)) {
    return { ok: false };
  }

  return {
    ok: true,
    detail: {
      id: row.id,
      status: row.status,
      statement: row.statement,
      createdAt: row.createdAt.toISOString(),
      decisionReasonCode: row.decisionReasonCode,
      enforcement: {
        type: action.type,
        createdAt: action.createdAt.toISOString(),
        reasonCode: action.reasonCode,
        previousState: action.previousState,
        scopeKind: scope.kind,
        campusName: action.campus?.name ?? null,
      },
      appellantName: action.target.name ?? "未知用户",
      selfReview: input.viewerId === action.actorId,
    },
    capabilities: deriveAppealReviewCapabilities({
      context: input.context,
      status: row.status,
      scope,
    }),
  };
}
