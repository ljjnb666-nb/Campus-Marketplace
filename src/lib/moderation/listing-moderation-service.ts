import type { ListingModerationReasonCode, ListingModerationTargetType, Prisma } from "@prisma/client";

import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { getActiveListingModeration } from "@/lib/moderation/listing-moderation-query";
import { moderationError } from "@/lib/moderation/errors";
import { prisma, withTransaction } from "@/lib/prisma";
import {
  LISTING_MODERATE_PERMISSION,
} from "@/lib/moderation/listing-moderation-access";
import { rbacError } from "@/lib/rbac/errors";
import { loadAuthorizationContext, requirePermissionInContext } from "@/lib/rbac/service";

/**
 * Phase 7C：listing 治理 canonical 服务（OPTION B overlay）。
 *
 * 硬合同（planning + Repair 1 + Repair 2 冻结）：
 * - 全局锁序：USER SUBJECT LOCKS → LISTING ROW LOCK → domain writes。
 *   moderation 取 `USER:moderator`（序列化 role revoke / 账号停用/注销 /
 *   membership 停用 vs 治理写，R2-01），不取 owner USER 锁（owner 是 listing
 *   域数据，moderation 零 owner 账户变更）。
 * - 授权在锁内重读：loadAuthorizationContext(moderatorId, tx) + exact-campus
 *   requirePermissionInContext——事务外页面授权绝不作为 authority。
 * - SELF_MODERATION = DENY：moderator == listing owner 零例外（GLOBAL 也不例外）。
 * - takedown 零业务状态变更（Product RESERVED 保持 RESERVED / Errand
 *   CLAIMED 保持 CLAIMED / 租赁在途订单不变）；活跃行承载"隐藏中"语义。
 * - 重复 takedown 幂等：已有活跃行 → 确定性 ALREADY_MODERATED（partial
 *   unique index 为 DB 侧兜底）。
 * - restore 精确身份 + 新鲜内容（R2-03）：锁内解析活跃行后必须
 *   activeModeration.id == input.moderationId 且 listing.updatedAt ==
 *   expectedListingUpdatedAt，任一不满足 → STALE_MODERATION_REVIEW
 *   （零 resolve、零 RESTORED 审计）；owner deletedAt/erasedAt →
 *   NOT_RESTORABLE（泛化文案，不泄露注销事实）。
 * - 四个 target table 的 FOR UPDATE 为硬编码 typed 分支（禁止
 *   $queryRawUnsafe 动态表名）；ID 全部参数化。
 * - 审计：AdminAudit 仅记治理 trail（LISTING_TAKEDOWN/LISTING_RESTORED，
 *   metadata=listingType/moderationId/reasonCode），authoritative 状态唯一
 *   来源是 ListingModeration 行；note 不入审计。
 */

export type ModerationRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

/** 锁内现势 listing（FOR UPDATE 行读出的权威字段）。 */
type LockedListing = {
  id: string;
  campusId: string;
  ownerId: string;
  status: string;
  updatedAt: Date;
  deletedAt: Date | null;
};

// ── 四域硬编码行锁分支（typed；ID 参数化）───────────────────────────────────

const LOCKED_LISTING_COLUMNS = `id, "campusId", status, "updatedAt", "deletedAt"`;

async function lockProductRow(
  tx: Prisma.TransactionClient,
  listingId: string,
): Promise<LockedListing | null> {
  const rows = await tx.$queryRaw<Array<{
    id: string; campusId: string; status: string; updatedAt: Date; deletedAt: Date | null; ownerId: string;
  }>>`
    SELECT id, "campusId", status, "updatedAt", "deletedAt", "sellerId" AS "ownerId"
    FROM "Product"
    WHERE id = ${listingId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockServiceRow(
  tx: Prisma.TransactionClient,
  listingId: string,
): Promise<LockedListing | null> {
  const rows = await tx.$queryRaw<Array<{
    id: string; campusId: string; status: string; updatedAt: Date; deletedAt: Date | null; ownerId: string;
  }>>`
    SELECT id, "campusId", status, "updatedAt", "deletedAt", "providerId" AS "ownerId"
    FROM "ServiceListing"
    WHERE id = ${listingId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockErrandRow(
  tx: Prisma.TransactionClient,
  listingId: string,
): Promise<LockedListing | null> {
  const rows = await tx.$queryRaw<Array<{
    id: string; campusId: string; status: string; updatedAt: Date; deletedAt: Date | null; ownerId: string;
  }>>`
    SELECT id, "campusId", status, "updatedAt", "deletedAt", "publisherId" AS "ownerId"
    FROM "ErrandTask"
    WHERE id = ${listingId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockRentalRow(
  tx: Prisma.TransactionClient,
  listingId: string,
): Promise<LockedListing | null> {
  const rows = await tx.$queryRaw<Array<{
    id: string; campusId: string; status: string; updatedAt: Date; deletedAt: Date | null; ownerId: string;
  }>>`
    SELECT id, "campusId", status, "updatedAt", "deletedAt", "ownerId"
    FROM "RentalListing"
    WHERE id = ${listingId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

const LOCK_ROW_BY_TYPE: Record<
  ListingModerationTargetType,
  (tx: Prisma.TransactionClient, listingId: string) => Promise<LockedListing | null>
> = {
  PRODUCT: lockProductRow,
  SERVICE: lockServiceRow,
  ERRAND: lockErrandRow,
  RENTAL: lockRentalRow,
};

// ── 共享锁内核（takedown / restore 同一安全链）──────────────────────────────

type ModerationCoreContext = {
  tx: Prisma.TransactionClient;
  moderatorId: string;
  targetType: ListingModerationTargetType;
  listingId: string;
  racePoint?: ModerationRacePoint;
};

/**
 * USER:moderator → listing 行锁 → 现势重读。失败统一抛
 * MODERATION_TARGET_NOT_FOUND（deleted/missing 不可区分；反 oracle）。
 */
async function lockTargetListing(
  tx: Prisma.TransactionClient,
  targetType: ListingModerationTargetType,
  listingId: string,
): Promise<LockedListing> {
  const locked = await LOCK_ROW_BY_TYPE[targetType](tx, listingId);
  if (!locked || locked.deletedAt !== null) {
    throw moderationError("MODERATION_TARGET_NOT_FOUND");
  }
  return locked;
}

/**
 * 冻结安全链的共享前段（R2-01）：
 * USER:moderator subject lock → listing 行锁 → 现势重读 → racePoint →
 * 授权重载（account active + listing.moderate exact-campus）→ self-deny。
 */
async function withModerationAuthority(
  core: ModerationCoreContext,
): Promise<{ core: ModerationCoreContext; locked: LockedListing }> {
  const { tx, moderatorId, targetType, listingId } = core;

  // 1. actor 序列化（role revoke / 账号停用/注销 / membership 停用 同锁）
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: moderatorId },
  ]);

  // 2. listing 行锁 + 现势重读（不信任事务外 snapshot）
  const locked = await lockTargetListing(tx, targetType, listingId);

  // 3. 测试 seam（C12B/C13B/C14B waiter 证明注入点；生产路径不传）
  if (core.racePoint) {
    await core.racePoint(tx);
  }

  // 4. AFTER locks：授权重读（角色撤销/账号停用/membership 停用关闭点）
  const context = await loadAuthorizationContext(moderatorId, tx);
  if (!context || !context.accountActive) {
    throw rbacError("AUTH_ACCOUNT_INACTIVE");
  }
  // GLOBAL 放行；CAMPUS grant 须 exact campus 且 membership ACTIVE
  // （必须 await：requirePermissionInContext 是异步复核，未 await 会把
  //   授权拒绝吞成 unhandled rejection 并继续写——fail-open）
  await requirePermissionInContext(context, LISTING_MODERATE_PERMISSION, locked.campusId);

  // 5. SELF_MODERATION = DENY（零例外）
  if (moderatorId === locked.ownerId) {
    throw moderationError("MODERATION_SELF_DENIED");
  }

  return { core, locked };
}

function moderationAuditInput(args: {
  moderatorId: string;
  action: "LISTING_TAKEDOWN" | "LISTING_RESTORED";
  listingId: string;
  campusId: string;
  moderationId: string;
  targetType: ListingModerationTargetType;
  reasonCode?: ListingModerationReasonCode;
}) {
  return {
    actorId: args.moderatorId,
    action: args.action,
    targetType: "LISTING",
    targetId: args.listingId,
    campusId: args.campusId,
    // note 不入审计（governance internal；仅存 moderation 行）
    detail: null,
    metadata: {
      listingType: args.targetType,
      moderationId: args.moderationId,
      ...(args.reasonCode ? { reasonCode: args.reasonCode } : {}),
    },
  };
}

// ── Takedown ────────────────────────────────────────────────────────────────

export type ListingTakedownInput = {
  moderatorId: string;
  listingId: string;
  reasonCode: ListingModerationReasonCode;
  note?: string | null;
  racePoint?: ModerationRacePoint;
};

export type ListingTakedownResult = {
  outcome: "TAKEDOWN" | "ALREADY_MODERATED";
  moderationId: string;
};

/**
 * 一次 takedown = 一个 ListingModeration 活跃行；业务 status 零变更。
 * 已有活跃行 → 幂等 ALREADY_MODERATED（不得新增第二条 active row；
 * partial unique index 为 DB 兜底）。
 */
async function takedownTxLocked(
  core: ModerationCoreContext & Pick<ListingTakedownInput, "reasonCode" | "note">,
  locked: LockedListing,
): Promise<ListingTakedownResult> {
  const { tx, moderatorId, targetType, listingId } = core;

  const existing = await getActiveListingModeration(tx, targetType, listingId);
  if (existing) {
    return { outcome: "ALREADY_MODERATED", moderationId: existing.id };
  }

  const created = await tx.listingModeration.create({
    data: {
      targetType,
      productId: targetType === "PRODUCT" ? listingId : null,
      serviceListingId: targetType === "SERVICE" ? listingId : null,
      errandTaskId: targetType === "ERRAND" ? listingId : null,
      rentalListingId: targetType === "RENTAL" ? listingId : null,
      campusId: locked.campusId,
      observedStatus: locked.status,
      reasonCode: core.reasonCode,
      note: core.note?.trim() ? core.note.trim() : null,
      moderatorId,
    },
    select: { id: true },
  });

  await recordAdminAudit(
    moderationAuditInput({
      moderatorId,
      action: "LISTING_TAKEDOWN",
      listingId,
      campusId: locked.campusId,
      moderationId: created.id,
      targetType,
      reasonCode: core.reasonCode,
    }),
    tx,
  );

  return { outcome: "TAKEDOWN", moderationId: created.id };
}

// ── Restore ─────────────────────────────────────────────────────────────────

export type ListingRestoreInput = {
  moderatorId: string;
  /** 服务器解析的 listing id（typed seam 由 identity resolver / action 提供） */
  listingId: string;
  /** 精确身份 token：必须是锁内解析出的现行活跃行 id（R2-03） */
  moderationId: string;
  /** 新鲜内容 token：必须是 moderator 检视时的 listing.updatedAt（R2-03） */
  expectedListingUpdatedAt: Date;
  racePoint?: ModerationRacePoint;
};

export type ListingRestoreResult = { outcome: "RESTORED"; moderationId: string };

/**
 * restore = 解除治理隐藏：resolve 确切活跃行。零业务状态回写（业务 status
 * 在隐藏期间可能已合法变化——SOLD/COMPLETED 等——restore 只解除隐藏）。
 */
async function restoreTxLocked(
  core: ModerationCoreContext & Pick<ListingRestoreInput, "moderationId" | "expectedListingUpdatedAt">,
  locked: LockedListing,
): Promise<ListingRestoreResult> {
  const { tx, moderatorId, targetType, listingId } = core;

  // 1. 锁内解析现行活跃行（严格 scoped 到本 listing）
  const active = await getActiveListingModeration(tx, targetType, listingId);
  if (!active) {
    throw moderationError("STALE_MODERATION_REVIEW");
  }

  // 2. 精确身份（ABA 关闭：M1 已被 resolve → M2 活跃时，stale M1 提交必然失配）
  if (active.id !== core.moderationId) {
    throw moderationError("STALE_MODERATION_REVIEW");
  }

  // 3. 新鲜内容（owner 在隐藏期编辑过 → 旧 token 失效，必须重检）
  if (locked.updatedAt.getTime() !== core.expectedListingUpdatedAt.getTime()) {
    throw moderationError("STALE_MODERATION_REVIEW");
  }

  // 4. owner 可恢复性（最小字段；deleted/erased → 泛化 NOT_RESTORABLE）
  const owner = await tx.user.findUnique({
    where: { id: locked.ownerId },
    select: { id: true, deletedAt: true, erasedAt: true },
  });
  if (!owner || owner.deletedAt !== null || owner.erasedAt !== null) {
    throw moderationError("RESTORE_NOT_RESTORABLE");
  }

  // 5. resolve 确切行（行锁下串行；belt-and-braces 条件更新）
  const resolved = await tx.listingModeration.updateMany({
    where: { id: active.id, resolvedAt: null },
    data: { resolvedAt: new Date(), resolvedById: moderatorId },
  });
  if (resolved.count !== 1) {
    throw moderationError("STALE_MODERATION_REVIEW");
  }

  await recordAdminAudit(
    moderationAuditInput({
      moderatorId,
      action: "LISTING_RESTORED",
      listingId,
      campusId: locked.campusId,
      moderationId: active.id,
      targetType,
    }),
    tx,
  );

  return { outcome: "RESTORED", moderationId: active.id };
}

// ── 公开 typed seams（8 个；共享上述内核，禁止大 switch SSOT）──────────────

const NOTE_MAX_LENGTH = 500;

function assertNoteLength(note: string | null | undefined): void {
  if (note && note.trim().length > NOTE_MAX_LENGTH) {
    throw moderationError("STALE_MODERATION_REVIEW", `备注不能超过 ${NOTE_MAX_LENGTH} 字`);
  }
}

function makeTakedownSeam(targetType: ListingModerationTargetType) {
  return async (input: ListingTakedownInput): Promise<ListingTakedownResult> => {
    assertNoteLength(input.note);
    return withTransaction((tx) =>
      withModerationAuthority({
        tx,
        moderatorId: input.moderatorId,
        targetType,
        listingId: input.listingId,
        racePoint: input.racePoint,
      }).then(({ locked }) =>
        takedownTxLocked(
          {
            tx,
            moderatorId: input.moderatorId,
            targetType,
            listingId: input.listingId,
            reasonCode: input.reasonCode,
            note: input.note ?? null,
          },
          locked,
        ),
      ),
    );
  };
}

function makeRestoreSeam(targetType: ListingModerationTargetType) {
  return async (input: ListingRestoreInput): Promise<ListingRestoreResult> =>
    withTransaction((tx) =>
      withModerationAuthority({
        tx,
        moderatorId: input.moderatorId,
        targetType,
        listingId: input.listingId,
        racePoint: input.racePoint,
      }).then(({ locked }) =>
        restoreTxLocked(
          {
            tx,
            moderatorId: input.moderatorId,
            targetType,
            listingId: input.listingId,
            moderationId: input.moderationId,
            expectedListingUpdatedAt: input.expectedListingUpdatedAt,
          },
          locked,
        ),
      ),
    );
}

export const moderateProductListing = makeTakedownSeam("PRODUCT");
export const moderateServiceListing = makeTakedownSeam("SERVICE");
export const moderateErrandListing = makeTakedownSeam("ERRAND");
export const moderateRentalListing = makeTakedownSeam("RENTAL");

export const restoreProductListing = makeRestoreSeam("PRODUCT");
export const restoreServiceListing = makeRestoreSeam("SERVICE");
export const restoreErrandListing = makeRestoreSeam("ERRAND");
export const restoreRentalListing = makeRestoreSeam("RENTAL");

const RESTORE_BY_TYPE: Record<
  ListingModerationTargetType,
  (input: ListingRestoreInput) => Promise<ListingRestoreResult>
> = {
  PRODUCT: restoreProductListing,
  SERVICE: restoreServiceListing,
  ERRAND: restoreErrandListing,
  RENTAL: restoreRentalListing,
};

/**
 * R2-03 冻结的 restore 客户端合同入口：客户端只提交
 * { moderationId, expectedListingUpdatedAt }；listing type / target identity
 * 由服务器从 moderation 行解析（row id → target 映射创建后不可变，事务外
 * 解析安全；行已 resolve / 不存在 → 统一 STALE）。canonical 锁内核再做
 * 活跃行 == moderationId 的精确身份复核（ABA 关闭）。
 */
export async function restoreListingByModerationIdentity(input: {
  moderatorId: string;
  moderationId: string;
  expectedListingUpdatedAt: Date;
  racePoint?: ModerationRacePoint;
}): Promise<ListingRestoreResult & { targetType: ListingModerationTargetType; listingId: string }> {
  const row = await prisma.listingModeration.findUnique({
    where: { id: input.moderationId },
    select: {
      targetType: true,
      productId: true,
      serviceListingId: true,
      errandTaskId: true,
      rentalListingId: true,
    },
  });
  if (!row) {
    throw moderationError("STALE_MODERATION_REVIEW");
  }
  const listingId = row.productId ?? row.serviceListingId ?? row.errandTaskId ?? row.rentalListingId;
  if (!listingId) {
    // CHECK 约束下不可达；fail closed
    throw moderationError("STALE_MODERATION_REVIEW");
  }
  const result = await RESTORE_BY_TYPE[row.targetType]({
    moderatorId: input.moderatorId,
    listingId,
    moderationId: input.moderationId,
    expectedListingUpdatedAt: input.expectedListingUpdatedAt,
    racePoint: input.racePoint,
  });
  return { ...result, targetType: row.targetType, listingId };
}
