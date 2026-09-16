import type { EnforcementActionType, EnforcementReasonCode, Prisma, RiskStateLevel } from "@prisma/client";

import type { EnforcementReadAccess } from "@/lib/enforcement/enforcement-read-access";
import {
  hasCompleteReversalProvenance,
  isPreMigrationLegacy,
} from "@/lib/enforcement/enforcement-sequence";
import { hydrateSafeIdentities, UNAVAILABLE_USER_DISPLAY_NAME } from "@/lib/governance/safe-identity";
import { prisma } from "@/lib/prisma";
import { encodeEnforcementSeq, encodeEnforcementSeqCursor } from "@/validators/enforcement";

/**
 * Phase 7D：/governance/enforcement 授权读模型（operator surface 专用）。
 *
 * 授权在 DB 查询内完成——绝不"取全量后内存过滤"：
 * - GLOBAL 读者：无 campus 谓词（campusId=null 的 GLOBAL 行可见）；
 * - campus 读者：`campusId IN 有效校区` 单列谓词（SQL IN 结构性排除 NULL——
 *   GLOBAL 行对 campus 读者不可见，且 MUST NOT 为其建立 target 存在性，
 *   R5/DECISION_13 冻结）；
 * - 所有过滤恒 AND 在 scope 谓词之内；cursor（enforcementSeq 单值，DB unique）
 *   只是 UNTRUSTED 分页位置。
 *
 * 因果序（enforcement-sequence.ts 冻结合同）：队列 ORDER BY enforcementSeq DESC、
 * 目标历史 ASC；createdAt 仅展示，绝不参与排序/因果/分页权威。历史分类
 * 复用 isPreMigrationLegacy / hasCompleteReversalProvenance，不重定义因果规则。
 *
 * scope 展示分类（DECISION_02A EnforcementAction 例外）：scopeKey 是独立
 * 权威——GLOBAL∧null=真 GLOBAL；不一致行（legacy/异常）fail closed 显示
 * SCOPE_INCONSISTENT 安全 fallback，不修数据、不推断。
 *
 * DTO 最小化（DECISION_04/05/06 冻结）：note / sourceId / 任意 metadata
 * 结构性不在 select 内；RiskFlag 完全不进入本模型；RiskState 仅 current
 * summary（不考古）。seq 以 canonical decimal string 过线（R6）。
 */

export type EnforcementScopeClassification = "GLOBAL" | "CAMPUS" | "SCOPE_INCONSISTENT";

export type EnforcementActionItemDto = {
  /** canonical decimal string（bigint 不直接过 DTO/JSON 线，R6 冻结） */
  seq: string;
  type: EnforcementActionType;
  scope: EnforcementScopeClassification;
  campusId: string | null;
  campusName: string | null;
  reasonCode: EnforcementReasonCode;
  sourceType: string | null;
  resultState: string;
  /** previousState 非空 = 反转溯源完整（仅 provenance 分类展示，不作 current truth） */
  provenanceComplete: boolean;
  /** seq < LEGACY_SEQ_BOUNDARY：迁移前 legacy 行（epoch 内相对顺序不可信） */
  legacyEpoch: boolean;
  /** 仅展示（wall-clock），绝不参与因果/分页判定 */
  createdAt: string;
  actor: { id: string; displayName: string };
  target: { id: string; displayName: string };
};

export type EnforcementQueuePage = {
  items: EnforcementActionItemDto[];
  nextCursor: string | null;
};

export type EnforcementQueueFilters = {
  campusId?: string;
  type?: EnforcementActionType;
  targetId?: string;
  actorId?: string;
  sourceType?: string;
};

/**
 * scopeKey 权威展示分类：GLOBAL∧null → GLOBAL；CAMPUS:<id>∧campusId=<id> →
 * CAMPUS；其余（mismatch/未知形状）→ SCOPE_INCONSISTENT（fail closed fallback）。
 */
function classifyScope(scopeKey: string, campusId: string | null): EnforcementScopeClassification {
  if (scopeKey === "GLOBAL") {
    return campusId === null ? "GLOBAL" : "SCOPE_INCONSISTENT";
  }
  if (scopeKey.startsWith("CAMPUS:")) {
    const scopedCampusId = scopeKey.slice("CAMPUS:".length);
    return scopedCampusId !== "" && scopedCampusId === campusId ? "CAMPUS" : "SCOPE_INCONSISTENT";
  }
  return "SCOPE_INCONSISTENT";
}

/**
 * campus 读者的执法可见性谓词（Final Review Repair 1 / FR01 冻结）。
 *
 * 授权权威 = (campusId, scopeKey) **exact pair**——单列 `campusId IN [...]`
 * 不得单独充当 scope 权威：scopeKey=GLOBAL 而 campusId=A 的 inconsistent 行
 * 会因此对 campus A 读者可见并可 anchor 目标存在性（错误授权）。
 * exact pair 的 OR 分支集合不产生 cross-product（禁止 campusId IN ∧ scopeKey IN）。
 *
 * - GLOBAL 读者：无 scope 谓词（inconsistent 行可见，DTO 以 SCOPE_INCONSISTENT
 *   呈现供平台运营排查）；
 * - campus 读者：仅 (A, CAMPUS:A) 形状的行可见；
 * - 零有效 scope：结构性不可见。
 *
 * 三个执法读面（queue / target history / target anchor）必须共用本 helper，
 * 不得各自手写授权谓词。RiskState 的可见性模型已另行冻结，不走本谓词。
 */
type EnforcementVisibility =
  | { kind: "ALL" }
  | { kind: "NONE" }
  | { kind: "SCOPED"; predicate: Prisma.EnforcementActionWhereInput };

function buildEnforcementVisibilityPredicate(access: EnforcementReadAccess): EnforcementVisibility {
  if (access.global) {
    return { kind: "ALL" };
  }
  if (access.campusIds.length === 0) {
    return { kind: "NONE" };
  }
  return {
    kind: "SCOPED",
    predicate: {
      OR: access.campusIds.map((campusId) => ({
        campusId,
        scopeKey: `CAMPUS:${campusId}`,
      })),
    },
  };
}

function riskStateScopeCondition(access: EnforcementReadAccess): Prisma.RiskStateWhereInput | null {
  if (access.global) {
    return null;
  }
  if (access.campusIds.length === 0) {
    return null;
  }
  return { campusId: { in: access.campusIds } };
}

// note / sourceId / previousState（原文）/ metadata 结构性不在 select 内：
// previousState 仅经 hasCompleteReversalProvenance 折算为布尔分类出 DTO。
const enforcementRowSelect = {
  enforcementSeq: true,
  type: true,
  campusId: true,
  campus: { select: { name: true } },
  scopeKey: true,
  reasonCode: true,
  sourceType: true,
  resultState: true,
  previousState: true,
  createdAt: true,
  actorId: true,
  targetId: true,
} satisfies Prisma.EnforcementActionSelect;

function toActionDto(
  row: {
    enforcementSeq: bigint;
    type: EnforcementActionType;
    campusId: string | null;
    campus: { name: string | null } | null;
    scopeKey: string;
    reasonCode: EnforcementReasonCode;
    sourceType: string | null;
    resultState: string;
    previousState: string | null;
    createdAt: Date;
    actorId: string;
    targetId: string;
  },
  actors: Map<string, { id: string; displayName: string }>,
): EnforcementActionItemDto {
  const actor = actors.get(row.actorId);
  const target = actors.get(row.targetId);
  return {
    seq: encodeEnforcementSeq(row.enforcementSeq),
    type: row.type,
    scope: classifyScope(row.scopeKey, row.campusId),
    campusId: row.campusId,
    campusName: row.campus?.name ?? null,
    reasonCode: row.reasonCode,
    sourceType: row.sourceType,
    resultState: row.resultState,
    provenanceComplete: hasCompleteReversalProvenance(row),
    legacyEpoch: isPreMigrationLegacy(row),
    createdAt: row.createdAt.toISOString(),
    actor: actor ?? { id: row.actorId, displayName: UNAVAILABLE_USER_DISPLAY_NAME },
    target: target ?? { id: row.targetId, displayName: UNAVAILABLE_USER_DISPLAY_NAME },
  };
}

/** 执法队列：因果最新优先（enforcementSeq DESC），§17 冻结。 */
export async function loadAuthorizedEnforcementQueue(input: {
  access: EnforcementReadAccess;
  cursor?: bigint;
  limit: number;
  filters?: EnforcementQueueFilters;
}): Promise<EnforcementQueuePage> {
  const visibility = buildEnforcementVisibilityPredicate(input.access);
  if (visibility.kind === "NONE") {
    return { items: [], nextCursor: null };
  }

  const filters = input.filters ?? {};
  const conditions: Prisma.EnforcementActionWhereInput[] = [];
  if (visibility.kind === "SCOPED") {
    conditions.push(visibility.predicate);
  }
  if (filters.campusId) {
    conditions.push({ campusId: filters.campusId });
  }
  if (filters.type) {
    conditions.push({ type: filters.type });
  }
  if (filters.targetId) {
    conditions.push({ targetId: filters.targetId });
  }
  if (filters.actorId) {
    conditions.push({ actorId: filters.actorId });
  }
  if (filters.sourceType) {
    conditions.push({ sourceType: filters.sourceType });
  }
  if (input.cursor !== undefined) {
    conditions.push({ enforcementSeq: { lt: input.cursor } });
  }

  const rows = await prisma.enforcementAction.findMany({
    where: conditions.length > 0 ? { AND: conditions } : {},
    orderBy: [{ enforcementSeq: "desc" }],
    take: input.limit + 1,
    select: enforcementRowSelect,
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const last = pageRows[pageRows.length - 1];

  const actors = await hydrateSafeIdentities(
    pageRows.flatMap((row) => [row.actorId, row.targetId]),
  );

  return {
    items: pageRows.map((row) => toActionDto(row, actors)),
    nextCursor: hasMore && last ? encodeEnforcementSeqCursor(last.enforcementSeq) : null,
  };
}

/**
 * 目标执法历史：因果读（enforcementSeq ASC），同样 bounded keyset
 * （§20 冻结——绝不 findMany(all history)）。continuation：seq > cursorSeq。
 */
export async function loadTargetEnforcementHistory(input: {
  access: EnforcementReadAccess;
  targetId: string;
  cursor?: bigint;
  limit: number;
}): Promise<EnforcementQueuePage> {
  const visibility = buildEnforcementVisibilityPredicate(input.access);
  if (visibility.kind === "NONE") {
    return { items: [], nextCursor: null };
  }

  const conditions: Prisma.EnforcementActionWhereInput[] = [
    { targetId: input.targetId },
  ];
  if (visibility.kind === "SCOPED") {
    conditions.push(visibility.predicate);
  }
  if (input.cursor !== undefined) {
    conditions.push({ enforcementSeq: { gt: input.cursor } });
  }

  const rows = await prisma.enforcementAction.findMany({
    where: { AND: conditions },
    orderBy: [{ enforcementSeq: "asc" }],
    take: input.limit + 1,
    select: enforcementRowSelect,
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const last = pageRows[pageRows.length - 1];

  const actors = await hydrateSafeIdentities(
    pageRows.flatMap((row) => [row.actorId, row.targetId]),
  );

  return {
    items: pageRows.map((row) => toActionDto(row, actors)),
    nextCursor: hasMore && last ? encodeEnforcementSeqCursor(last.enforcementSeq) : null,
  };
}

// ── RiskState current summary（DECISION_05：不考古；RiskFlag 排除，DECISION_06）──

export type RiskStateSummaryDto = {
  scopeKey: string;
  campusId: string | null;
  campusName: string | null;
  state: RiskStateLevel;
  reasonCode: string | null;
  updatedBy: { id: string; displayName: string } | null;
  updatedAt: string;
};

/**
 * 目标 current RiskState summary（硬上限 50 行/scope 数量级防御性 bounded）。
 * 已显式落行的 NORMAL 行本身是治理状态证据（§21），照常返回；
 * 无行 = 不合成 NORMAL（禁止 synthetic row）。
 */
export async function loadTargetRiskStateSummary(input: {
  access: EnforcementReadAccess;
  targetId: string;
}): Promise<RiskStateSummaryDto[]> {
  const scopeCondition = riskStateScopeCondition(input.access);
  if (!input.access.global && !scopeCondition) {
    return [];
  }

  const conditions: Prisma.RiskStateWhereInput[] = [{ userId: input.targetId }];
  if (scopeCondition) {
    conditions.push(scopeCondition);
  }

  const rows = await prisma.riskState.findMany({
    where: { AND: conditions },
    orderBy: [{ updatedAt: "desc" }],
    take: 50,
    select: {
      scopeKey: true,
      campusId: true,
      campus: { select: { name: true } },
      state: true,
      reasonCode: true,
      updatedById: true,
      updatedAt: true,
    },
  });

  const updaters = await hydrateSafeIdentities(
    rows.flatMap((row) => (row.updatedById ? [row.updatedById] : [])),
  );

  return rows.map((row) => ({
    scopeKey: row.scopeKey,
    campusId: row.campusId,
    campusName: row.campus?.name ?? null,
    state: row.state,
    reasonCode: row.reasonCode,
    updatedBy: row.updatedById
      ? (updaters.get(row.updatedById) ?? {
          id: row.updatedById,
          displayName: UNAVAILABLE_USER_DISPLAY_NAME,
        })
      : null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * target 详情存在性权威（R5 / DECISION_13 冻结）：AUTHORIZED EnforcementAction
 * OR AUTHORIZED RiskState 行（含显式 NORMAL 行）；User 绝不是存在性权威，
 * 身份水合只在 anchor 证明之后进行（调用方职责，见 targets/[targetId] 页）。
 */
export async function hasVisibleTargetAnchor(input: {
  access: EnforcementReadAccess;
  targetId: string;
}): Promise<boolean> {
  const visibility = buildEnforcementVisibilityPredicate(input.access);
  if (visibility.kind === "NONE") {
    return false;
  }

  // EnforcementAction anchor：exact-pair 授权谓词（FR01）——inconsistent
  // GLOBAL/A 行对 campus 读者既不可见也不可 anchor；
  // RiskState anchor：沿用已冻结的 campusId 可见性模型（本轮不改）。
  const enforcementWhere: Prisma.EnforcementActionWhereInput = {
    targetId: input.targetId,
    ...(visibility.kind === "SCOPED" ? { AND: [visibility.predicate] } : {}),
  };
  const anchored = await prisma.enforcementAction.findFirst({
    where: enforcementWhere,
    select: { id: true },
  });
  if (anchored) {
    return true;
  }

  const riskScope = riskStateScopeCondition(input.access);
  if (!input.access.global && !riskScope) {
    return false;
  }
  const riskWhere: Prisma.RiskStateWhereInput = {
    userId: input.targetId,
    ...(riskScope ? { AND: [riskScope] } : {}),
  };
  const riskAnchored = await prisma.riskState.findFirst({
    where: riskWhere,
    select: { id: true },
  });
  return riskAnchored !== null;
}
