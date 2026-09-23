import type { Prisma, VerificationStatus } from "@prisma/client";

import { hydrateSafeIdentities, UNAVAILABLE_USER_DISPLAY_NAME } from "@/lib/governance/safe-identity";
import {
  parseCanonicalCursorDate,
  parseCanonicalCursorJson,
} from "@/lib/governance/canonical-cursor";
import { prisma } from "@/lib/prisma";
import {
  isControlledVerificationEvidence,
  parseAssetReference,
} from "@/lib/asset-ref";
import { isVerificationReviewOverdue } from "@/lib/campus/verification-sla";
import {
  canReviewVerificationCampus,
  type VerificationReviewAccess,
} from "@/lib/campus/verification-review-access";

/**
 * Phase 7F：认证审核治理队列/详情授权读模型（operator surface 专用）。
 *
 * 授权在 DB 查询内完成——绝不"取全量后内存过滤"（7A/7E 同款冻结）：
 * - 唯一 scope truth = UserVerification.membership.campusId，且必须
 *   membership.status = ACTIVE（campus reviewer 分支 = exact campusId 合取
 *   ACTIVE membership；GLOBAL = 全部 ACTIVE membership——membership.campusId
 *   经 FK 必然是合法 Campus 行，等价于全校区 exact 分支的完备并集）；
 * - 禁止 User.campusId / User.schoolName / campusName 文本参与授权；
 * - 所有 requested filter（campus/status/overdue）恒 AND 在 scope 谓词之内
 *   ——filter 永远不能扩大授权范围；
 * - cursor 只是 UNTRUSTED 分页位置（base64url）；keyset tuple =
 *   (reviewDueAt, submittedAt, id) ASC 全列（稳定 tie-break）。
 *
 * DTO 最小化（冻结）：队列行绝不含 email / studentIdLast4 / studentCardImage /
 * asset id / reviewNote / raw policy metadata——仅运营 triage 最小面；
 * 详情两阶段读（FR：Stage A 最小 authority 锚点 → 授权 → Stage B 敏感水合），
 * evidence reference（asset: token）仅在授权通过后返回，实际读取仍须经
 * /api/assets/:assetId/access + content 的独立鉴权（含 sensitive access audit）。
 *
 * SLA 只读：overdue = status PENDING ∧ reviewDueAt < now（零自动决定、
 * 零 enforcement）。
 */

export const VERIFICATION_QUEUE_DEFAULT_PAGE_SIZE = 25;
export const VERIFICATION_QUEUE_MAX_PAGE_SIZE = 50;

export type VerificationQueueItemDto = {
  verificationId: string;
  /** 安全身份 displayName（missing/deleted/erased 统一 fallback） */
  userDisplayName: string;
  campusId: string;
  campusName: string;
  status: VerificationStatus;
  submittedAt: string;
  reviewDueAt: string;
  overdue: boolean;
};

export type VerificationQueuePage = {
  items: VerificationQueueItemDto[];
  nextCursor: string | null;
};

export type VerificationQueueFilters = {
  campusId?: string;
  status?: VerificationStatus;
  overdueOnly?: boolean;
};

export type VerificationCursor = { reviewDueAt: Date; submittedAt: Date; id: string };

/** 由实际返回的最后一条生成下一页 cursor（base64url(JSON)）。 */
export function encodeVerificationCursor(cursor: VerificationCursor): string {
  return Buffer.from(
    JSON.stringify({
      reviewDueAt: cursor.reviewDueAt.toISOString(),
      submittedAt: cursor.submittedAt.toISOString(),
      id: cursor.id,
    }),
  ).toString("base64url");
}

/** 解码客户端回传 cursor（FR03 canonical 纪律，与 decodeUserCursor 同一 SSOT
 * helper：exact keys / canonical ISO / re-encode equality）；任何解析/校验失败
 * 返回 null（调用方安全失败态）。 */
export function decodeVerificationCursor(raw: string): VerificationCursor | null {
  const payload = parseCanonicalCursorJson(raw, ["reviewDueAt", "submittedAt", "id"]);
  if (!payload) {
    return null;
  }
  const reviewDueAt = parseCanonicalCursorDate(payload.reviewDueAt);
  const submittedAt = parseCanonicalCursorDate(payload.submittedAt);
  if (!reviewDueAt || !submittedAt || payload.id.length === 0) {
    return null;
  }
  const cursor: VerificationCursor = { reviewDueAt, submittedAt, id: payload.id };
  // canonical 外层编码 + canonical JSON 键序的最终权威（FR03 C09/C10）
  if (encodeVerificationCursor(cursor) !== raw) {
    return null;
  }
  return cursor;
}

/** 授权 scope 谓词（fail-closed：无有效 scope 时返回 false → 永远空页）。 */
export function verificationScopePredicate(
  access: VerificationReviewAccess,
): Prisma.UserVerificationWhereInput | null {
  if (access.global) {
    // GLOBAL：全部 valid scope = 任意 ACTIVE membership（campusId 经 FK 合法）
    return { membership: { status: "ACTIVE" } };
  }
  if (access.campusIds.length === 0) {
    return null;
  }
  // campus reviewer：membership.campusId exact match ∧ ACTIVE membership
  return {
    membership: { OR: access.campusIds.map((campusId) => ({ campusId, status: "ACTIVE" })) },
  };
}

/**
 * campus 过滤下拉选项（由授权 scope 派生，绝不提供越权选项）：
 * GLOBAL → 全部 active 校区；campus reviewer → 仅其有效 scope 校区。
 */
export async function listVerificationQueueCampuses(
  access: VerificationReviewAccess,
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

/** keyset 条件（ASC 全 tuple：dueAt > ∨ (=∧submittedAt >) ∨ (=∧=∧id >)）。 */
function verificationKeysetCondition(
  cursor: VerificationCursor,
): Prisma.UserVerificationWhereInput {
  return {
    OR: [
      { reviewDueAt: { gt: cursor.reviewDueAt } },
      { reviewDueAt: { equals: cursor.reviewDueAt }, submittedAt: { gt: cursor.submittedAt } },
      {
        reviewDueAt: { equals: cursor.reviewDueAt },
        submittedAt: { equals: cursor.submittedAt },
        id: { gt: cursor.id },
      },
    ],
  };
}

const queueVerificationSelect = {
  id: true,
  status: true,
  submittedAt: true,
  reviewDueAt: true,
  userId: true,
  membership: {
    select: { campusId: true, campus: { select: { name: true } } },
  },
  // email / studentIdLast4 / studentCardImage / reviewNote / policy metadata
  // 结构性不在队列 select 内（DTO 最小化合同）
} satisfies Prisma.UserVerificationSelect;

export async function loadAuthorizedVerificationQueue(input: {
  access: VerificationReviewAccess;
  cursor?: VerificationCursor;
  limit: number;
  filters?: VerificationQueueFilters;
}): Promise<VerificationQueuePage> {
  const scopePredicate = verificationScopePredicate(input.access);

  // fail-closed：零有效 scope 永远空页（绝不让空谓词退化为无条件匹配）
  if (scopePredicate === null) {
    return { items: [], nextCursor: null };
  }

  const filters = input.filters ?? {};
  const andConditions: Prisma.UserVerificationWhereInput[] = [scopePredicate];

  // requested filters 恒 AND 在 scope 谓词之内（不能扩大授权范围）
  if (filters.campusId) {
    andConditions.push({ membership: { campusId: filters.campusId, status: "ACTIVE" } });
  }
  if (filters.status) {
    andConditions.push({ status: filters.status });
  }
  if (filters.overdueOnly) {
    andConditions.push({ status: "PENDING", reviewDueAt: { lt: new Date() } });
  }
  if (input.cursor) {
    andConditions.push(verificationKeysetCondition(input.cursor));
  }

  const rows = await prisma.userVerification.findMany({
    where: { AND: andConditions },
    orderBy: [{ reviewDueAt: "asc" }, { submittedAt: "asc" }, { id: "asc" }],
    take: input.limit + 1,
    select: queueVerificationSelect,
  });

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;

  const identities = await hydrateSafeIdentities(pageRows.map((row) => row.userId));
  const now = new Date();
  const items = pageRows.map((row) => ({
    verificationId: row.id,
    userDisplayName: identities.get(row.userId)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME,
    campusId: row.membership.campusId,
    campusName: row.membership.campus.name,
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    reviewDueAt: row.reviewDueAt.toISOString(),
    overdue: isVerificationReviewOverdue(row, now),
  }));

  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeVerificationCursor({
            reviewDueAt: last.reviewDueAt,
            submittedAt: last.submittedAt,
            id: last.id,
          })
        : null,
  };
}

// ── 详情（每请求独立重授权，绝不信任队列可见性）──────────────────────────────

export type VerificationEvidenceDisplay =
  | { state: "CONTROLLED"; ref: string }
  | { state: "UNAVAILABLE" };

/**
 * RB-01 Repair 2：证据渲染解析（read-model 层 fail-closed）。
 *
 * 仅当引用为受控 `asset:<id>` 且对应 UploadedAsset 确实存在、
 * category=VERIFICATION、access=PRIVATE、绑定到本认证记录、状态存活且
 * 未过保留期时，才返回 CONTROLLED 引用；其余一切形态（历史 /uploads/
 * 直链、http(s) 外链、任意未知/畸形串、伪造 asset id、跨类别绑定、
 * 已过期/已删除对象）一律 UNAVAILABLE——历史证据值绝不进入 DOM。
 *
 * 注意分层：本函数只决定"是否展示查看入口"；实际内容读取仍必须经
 * /api/assets/:assetId/access + content 的独立鉴权（含 sensitive access
 * audit），此处绝不签发任何内容 URL。
 */
export async function resolveVerificationEvidenceDisplay(
  verificationId: string,
  value: string,
): Promise<VerificationEvidenceDisplay> {
  const assetId = isControlledVerificationEvidence(value) ? parseAssetReference(value) : null;
  if (!assetId) {
    return { state: "UNAVAILABLE" };
  }

  const asset = await prisma.uploadedAsset.findFirst({
    where: {
      id: assetId,
      category: "VERIFICATION",
      access: "PRIVATE",
      verificationId,
      status: { in: ["UPLOADED", "ATTACHED"] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  });

  return asset ? { state: "CONTROLLED", ref: value } : { state: "UNAVAILABLE" };
}

export type VerificationDetailDto = {
  verificationId: string;
  status: VerificationStatus;
  /** 安全身份 displayName（missing/deleted/erased 统一 fallback） */
  userDisplayName: string;
  campusId: string;
  schoolName: string;
  campusName: string;
  studentIdLast4: string;
  reviewNote: string | null;
  reasonCode: string | null;
  submittedAt: string;
  reviewDueAt: string;
  overdue: boolean;
  reviewedAt: string | null;
  /** 上次审核人安全身份（未审核 = null） */
  reviewedByName: string | null;
  /** policy 快照的安全展示字段（不含 raw policy metadata / contentHash） */
  policyVersion: number | null;
  /**
   * 受控私有证据引用（严格合法的 asset: token，且已通过 RB-01 渲染解析：
   * 存在 / VERIFICATION 类别 / PRIVATE / 绑定本认证 / 未过期）——仅授权
   * 通过后返回；实际读取必须经 /api/assets/:assetId/access + content
   * 独立鉴权（含 sensitive access audit）
   */
  studentCardImageRef: string | null;
  /**
   * RB-01：证据值存在但不是可渲染的受控引用（legacy 直链/外链/未知串/
   * 伪造或失效 asset 引用/已清空）→ true，页面渲染非泄露的不可用状态，
   * 绝不输出原始值
   */
  evidenceUnavailable: boolean;
};

export type VerificationDetailResult = { ok: true; detail: VerificationDetailDto } | { ok: false };

/**
 * 详情授权（两阶段读，冻结顺序）：
 *
 *   Stage A — 最小 authority 锚点（仅 id/status/membership.id/campusId/status，
 *   结构性不含 studentIdLast4 / studentCardImage / reviewNote / email /
 *   policy evidence）
 *   → membership 必须 ACTIVE（否则 fail closed，与 missing 同形）
 *   → authorize（missing / inactive membership / 越权 统一 { ok:false }，
 *   调用方映射 notFound()，无存在性 oracle）
 *   → Stage B — 授权通过后才进行敏感水合（学号后四位 / 证据引用 /
 *   reviewNote / policy 快照 / 审核人身份）。
 *
 * 授权失败路径绝不触碰任何敏感列（D02/D03/D04）。
 */
export async function loadAuthorizedVerificationDetail(input: {
  access: VerificationReviewAccess;
  verificationId: string;
}): Promise<VerificationDetailResult> {
  // ---- Stage A：最小 authority 锚点（授权谓词所需字段，零敏感载荷） ----
  const anchor = await prisma.userVerification.findUnique({
    where: { id: input.verificationId },
    select: {
      id: true,
      status: true,
      membership: { select: { id: true, campusId: true, status: true } },
    },
  });

  if (!anchor) {
    return { ok: false };
  }

  // membership 必须 ACTIVE：scope truth 冻结（inactive → fail closed，同形 deny）
  if (anchor.membership.status !== "ACTIVE") {
    return { ok: false };
  }

  if (!canReviewVerificationCampus(input.access, anchor.membership.campusId)) {
    return { ok: false };
  }

  // ---- Stage B：授权通过后的敏感水合 ----
  const row = await prisma.userVerification.findUnique({
    where: { id: input.verificationId },
    select: {
      id: true,
      status: true,
      schoolName: true,
      campusName: true,
      studentIdLast4: true,
      studentCardImage: true,
      reviewNote: true,
      reasonCode: true,
      submittedAt: true,
      reviewDueAt: true,
      reviewedAt: true,
      reviewedById: true,
      policyVersion: true,
      userId: true,
      membership: { select: { campusId: true } },
    },
  });

  if (!row || row.membership.campusId !== anchor.membership.campusId) {
    // Stage A 与 B 之间的极端竞态（行被删除/membership 重绑）：与未授权同形
    return { ok: false };
  }

  const identities = await hydrateSafeIdentities(
    [row.userId, row.reviewedById].filter((id): id is string => id !== null),
  );

  // RB-01：证据引用仅在"受控 asset 引用 ∧ 资产校验通过"时进入 DTO；
  // 其余值以 evidenceUnavailable 表达，原始值绝不离开服务端
  const evidenceDisplay = await resolveVerificationEvidenceDisplay(
    row.id,
    row.studentCardImage,
  );

  return {
    ok: true,
    detail: {
      verificationId: row.id,
      status: row.status,
      userDisplayName: identities.get(row.userId)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME,
      campusId: row.membership.campusId,
      schoolName: row.schoolName,
      campusName: row.campusName,
      studentIdLast4: row.studentIdLast4,
      reviewNote: row.reviewNote,
      reasonCode: row.reasonCode,
      submittedAt: row.submittedAt.toISOString(),
      reviewDueAt: row.reviewDueAt.toISOString(),
      overdue: isVerificationReviewOverdue(row),
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      reviewedByName: row.reviewedById
        ? (identities.get(row.reviewedById)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME)
        : null,
      policyVersion: row.policyVersion,
      studentCardImageRef:
        evidenceDisplay.state === "CONTROLLED" ? evidenceDisplay.ref : null,
      evidenceUnavailable: evidenceDisplay.state === "UNAVAILABLE",
    },
  };
}
