import type { AppealDecisionReasonCode, AppealStatus, EnforcementActionType } from "@prisma/client";

import { encodeAppealCursor, type AppealCursor } from "@/validators/appeal";
import { prisma } from "@/lib/prisma";

/**
 * Phase 6C-2：Appeal self-service 只读 seam（eligible-actions discovery +
 * appellant self DTO loader）。
 *
 * Discovery 资格与 6C-1B domain 完全对齐（无 HTTP-only cutoff）：
 *   targetId == caller AND type IN {ACCOUNT_SUSPEND, MEMBERSHIP_SUSPEND,
 *   MARKETPLACE_RESTRICT}。已有 Appeal（含 WITHDRAWN/terminal）保持
 *   discoverable 并返回 {id,status}；stale / already-reversed / legacy
 *   provenance 属 review workflow 的程序性判断，这里绝不过滤。
 *
 * 分页 = bounded keyset（Planning Repair 2 冻结）：
 *   ORDER BY createdAt DESC, id DESC（行不可变键上的稳定全序），
 *   next-page 条件 createdAt < c OR (createdAt == c AND id < i)，
 *   take = limit + 1，nextCursor 由实际返回的最后一条 item 生成；
 *   遍历的是"当前有序结果集"，不是跨请求快照。
 *
 * DTO 披露面 = 6C-1B appellant 冻结域（与 privacy export v2 一致）：
 * 绝不查询/返回 reasonCode、actorId、note、sourceType/sourceId、
 * previousState、resultState、enforcementSeq、reviewer 身份、AdminAudit。
 */

const PUNITIVE_TYPES: EnforcementActionType[] = [
  "ACCOUNT_SUSPEND",
  "MEMBERSHIP_SUSPEND",
  "MARKETPLACE_RESTRICT",
];

export type EligibleAppealActionDto = {
  enforcementActionId: string;
  type: EnforcementActionType;
  scopeKind: "GLOBAL" | "CAMPUS";
  createdAt: string;
  appeal: { id: string; status: AppealStatus } | null;
};

export type EligibleAppealActionPage = {
  items: EligibleAppealActionDto[];
  nextCursor: string | null;
};

function toEligibleActionDto(row: {
  id: string;
  type: EnforcementActionType;
  campusId: string | null;
  createdAt: Date;
  appeal: { id: string; status: AppealStatus } | null;
}): EligibleAppealActionDto {
  return {
    enforcementActionId: row.id,
    type: row.type,
    scopeKind: row.campusId === null ? "GLOBAL" : "CAMPUS",
    createdAt: row.createdAt.toISOString(),
    appeal: row.appeal ? { id: row.appeal.id, status: row.appeal.status } : null,
  };
}

export async function listEligibleAppealActions(input: {
  targetUserId: string;
  /** 经 decodeAppealCursor 校验的 UNTRUSTED 分页位置（§13） */
  cursor?: AppealCursor;
  /** 已由 appealPageLimitSchema 校验的 1..50 整数 */
  limit: number;
}): Promise<EligibleAppealActionPage> {
  const rows = await prisma.enforcementAction.findMany({
    where: {
      targetId: input.targetUserId,
      type: { in: PUNITIVE_TYPES },
      ...(input.cursor
        ? {
            OR: [
              { createdAt: { lt: input.cursor.createdAt } },
              {
                AND: [
                  { createdAt: { equals: input.cursor.createdAt } },
                  { id: { lt: input.cursor.id } },
                ],
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: {
      id: true,
      type: true,
      campusId: true,
      createdAt: true,
      appeal: { select: { id: true, status: true } },
    },
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const last = pageRows[pageRows.length - 1];

  return {
    items: pageRows.map(toEligibleActionDto),
    nextCursor: hasMore && last ? encodeAppealCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

// ── appellant self DTO（6C-1B 冻结域，submit/withdraw 响应使用）──────────────

export type AppellantAppealDto = {
  id: string;
  enforcementActionId: string;
  status: AppealStatus;
  statement: string;
  decisionReasonCode: AppealDecisionReasonCode | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
};

/**
 * 提交/撤回成功后按冻结的 appellant self DTO 回读（domain service 的返回
 * 形状是内部 AppealRecord，本 loader 是 HTTP 响应的唯一 DTO 来源）。
 * decisionNote / reviewedById / reviewer 身份结构性不在 select 内。
 */
export async function loadAppellantAppealSelfDto(
  appealId: string,
): Promise<AppellantAppealDto | null> {
  const appeal = await prisma.appeal.findUnique({
    where: { id: appealId },
    select: {
      id: true,
      enforcementActionId: true,
      status: true,
      statement: true,
      decisionReasonCode: true,
      createdAt: true,
      updatedAt: true,
      reviewedAt: true,
    },
  });

  if (!appeal) {
    return null;
  }

  return {
    id: appeal.id,
    enforcementActionId: appeal.enforcementActionId,
    status: appeal.status,
    statement: appeal.statement,
    decisionReasonCode: appeal.decisionReasonCode,
    createdAt: appeal.createdAt.toISOString(),
    updatedAt: appeal.updatedAt.toISOString(),
    reviewedAt: appeal.reviewedAt?.toISOString() ?? null,
  };
}
