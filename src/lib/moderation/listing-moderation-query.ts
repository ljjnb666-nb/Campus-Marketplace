import type { ListingModerationTargetType, Prisma } from "@prisma/client";

import type { ListingModerationAccess } from "@/lib/moderation/listing-moderation-access";
import { prisma } from "@/lib/prisma";

/**
 * Phase 7C：listing 治理读模型（只读；canonical mutation 在 service）。
 *
 * READ-SURFACE 合同（R6 冻结五分类）：
 * - PUBLIC：活跃 moderation 行存在 → 排除（谓词经四个 typed back-relation
 *   `moderations`，partial unique index 支撑 targetId + active 查询）；
 * - OWNER：不过滤（owner 仍可发现自己被治理的 listing，仅呈现安全 badge）；
 * - GOVERNANCE：不过滤（授权 moderator 始终可检视现势内容）；
 * - EXISTING OBLIGATION / INTERNAL：不过滤（履约上下文保留）。
 */

/** 兼容扩展 client（软删 $extends）与事务客户端的最小结构面（方法双变）。 */
type ModerationReader = {
  listingModeration: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id: boolean; createdAt: boolean };
    }): Promise<{ id: string; createdAt: Date } | null>;
  };
};

/** PUBLIC 面共享谓词片段：四个 listing 模型的 `moderations` back-relation
 * 同名，同一对象可安全注入各模型 where（结构子类型，类型收窄由调用方
 * Prisma where 类型承载）。 */
export function listingModerationPublicFilter(): {
  moderations: { none: { resolvedAt: null } };
} {
  return {
    moderations: {
      none: { resolvedAt: null },
    },
  };
}

/** 服务端解析的目标类型（typed route/action 只允许这四个字面量）。 */
export const LISTING_MODERATION_TARGET_TYPES = [
  "PRODUCT",
  "SERVICE",
  "ERRAND",
  "RENTAL",
] as const satisfies readonly ListingModerationTargetType[];

/** 目标 FK 列（服务端 typed switch 专用；绝不接客户端输入拼接）。 */
const TARGET_FK_FIELD: Record<
  ListingModerationTargetType,
  "productId" | "serviceListingId" | "errandTaskId" | "rentalListingId"
> = {
  PRODUCT: "productId",
  SERVICE: "serviceListingId",
  ERRAND: "errandTaskId",
  RENTAL: "rentalListingId",
};

/**
 * 活跃 moderation 行最小读取（义务 gate / PUBLIC detail 特例共用）。
 * 仅返回 id/createdAt——绝不返回 reasonCode/note（不暴露给 owner 面与
 * 义务 gate）。
 */
export async function getActiveListingModeration(
  client: ModerationReader,
  targetType: ListingModerationTargetType,
  listingId: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const where: Record<string, unknown> = { resolvedAt: null };
  where[TARGET_FK_FIELD[targetType]] = listingId;

  const row = await client.listingModeration.findFirst({
    where,
    select: { id: true, createdAt: true },
  });
  return row ?? null;
}

/**
 * FR-03：PUBLIC metadata 面专用（generateMetadata 属公开读面，owner
 * exception 不适用）——活跃 moderation 存在 → 调用方返回 generic fallback
 * metadata，hidden listing 的 title/description/pricing/location/images
 * 不得进入 <title>/meta/OG/Twitter。封装在 lib 层以保持页面零 prisma 导入。
 */
export async function hasActiveModerationForPublicSurface(
  targetType: ListingModerationTargetType,
  listingId: string,
): Promise<boolean> {
  return hasActiveListingModeration(prisma, targetType, listingId);
}

/** 义务 gate 便捷形态：活跃 moderation 是否存在（存在 → 新义务必须拒绝）。 */
export async function hasActiveListingModeration(
  client: ModerationReader,
  targetType: ListingModerationTargetType,
  listingId: string,
): Promise<boolean> {
  return (await getActiveListingModeration(client, targetType, listingId)) !== null;
}

/**
 * PUBLIC detail 页治理特例（R1/R6 冻结三态）：
 * - HIDDEN：活跃 moderation ∧ viewer 非 owner（且非 additionalAllowedViewerIds
 *   成员，如 errand accepter——EXISTING_OBLIGATION 履约上下文保留）→
 *   调用方 notFound()（反 oracle）；
 * - OWNER_VIEW：活跃 moderation ∧ viewer 是 owner/履约参与方 → 渲染 + 安全
 *   badge；
 * - OPEN：无活跃 moderation → 正常渲染。
 * viewer=null（匿名 / SUSPENDED 会话）恒为非 owner。
 */
export async function resolvePublicDetailModerationGate(args: {
  viewerId: string | null;
  ownerId: string;
  /** 履约参与方白名单（errand accepter 等；EXISTING_OBLIGATION 读面） */
  additionalAllowedViewerIds?: (string | null)[];
  targetType: ListingModerationTargetType;
  listingId: string;
}): Promise<"OPEN" | "OWNER_VIEW" | "HIDDEN"> {
  const active = await getActiveListingModeration(
    prisma,
    args.targetType,
    args.listingId,
  );
  if (!active) {
    return "OPEN";
  }
  const allowed =
    args.viewerId !== null &&
    (args.viewerId === args.ownerId ||
      (args.additionalAllowedViewerIds ?? []).some((id) => id !== null && id === args.viewerId));
  return allowed ? "OWNER_VIEW" : "HIDDEN";
}

// ── 会话创建锁后资源重读（R1 冻结：participant 锁 → listing 行锁 → 复查）──

/** 会话创建的现势资源快照（锁内行读；participant 集合由各域闭包重建）。 */
export type ListingConversationSnapshot = {
  campusId: string;
  ownerId: string;
  /** 仅 errand 使用：accepter（publisher 视角的对端）；他域恒 null */
  counterpartId: string | null;
};

/**
 * getOrCreateConversationSafe 的 rereadResource 共享实现（Phase 7C 冻结序列）：
 * listing 行 FOR UPDATE → 现势 campus/owner 读取 → 活跃 moderation 复查。
 * 返回 null = 资源缺失/已删除/活跃治理中（复用既有"资源不可用"回退语义，
 * 新会话拒绝；既有 conversationKey 命中路径不经过本函数，永不断开）。
 * 必须在 participant governance 锁取得之后调用（全局锁序 USER → ROW）。
 * 四域硬编码 typed 分支；ID 参数化。
 */
export async function rereadListingForConversation(
  tx: Prisma.TransactionClient,
  targetType: ListingModerationTargetType,
  listingId: string,
): Promise<ListingConversationSnapshot | null> {
  type SnapshotRow = {
    id: string;
    campusId: string;
    ownerId: string;
    deletedAt: Date | null;
    counterpartId?: string | null;
  };
  const readers: Record<ListingModerationTargetType, () => Promise<SnapshotRow | null>> = {
    PRODUCT: async () => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; campusId: string; ownerId: string; deletedAt: Date | null }>
      >`
        SELECT id, "campusId", "sellerId" AS "ownerId", "deletedAt"
        FROM "Product"
        WHERE id = ${listingId}
        FOR UPDATE
      `;
      return rows[0] ?? null;
    },
    SERVICE: async () => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; campusId: string; ownerId: string; deletedAt: Date | null }>
      >`
        SELECT id, "campusId", "providerId" AS "ownerId", "deletedAt"
        FROM "ServiceListing"
        WHERE id = ${listingId}
        FOR UPDATE
      `;
      return rows[0] ?? null;
    },
    ERRAND: async () => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; campusId: string; ownerId: string; counterpartId: string | null; deletedAt: Date | null }>
      >`
        SELECT id, "campusId", "publisherId" AS "ownerId", "accepterId" AS "counterpartId", "deletedAt"
        FROM "ErrandTask"
        WHERE id = ${listingId}
        FOR UPDATE
      `;
      return rows[0] ?? null;
    },
    RENTAL: async () => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; campusId: string; ownerId: string; deletedAt: Date | null }>
      >`
        SELECT id, "campusId", "ownerId", "deletedAt"
        FROM "RentalListing"
        WHERE id = ${listingId}
        FOR UPDATE
      `;
      return rows[0] ?? null;
    },
  };

  const snapshot = await readers[targetType]();
  if (!snapshot || snapshot.deletedAt !== null) {
    return null;
  }
  if (await hasActiveListingModeration(tx, targetType, listingId)) {
    return null;
  }
  return {
    campusId: snapshot.campusId,
    ownerId: snapshot.ownerId,
    counterpartId: snapshot.counterpartId ?? null,
  };
}

// ── 治理队列读模型（/governance/listings 三 tab；R6/R2 + Final Review FR-01 冻结）──

export type ModerationQueueItem = {
  key: string;
  targetType: ListingModerationTargetType;
  listingId: string;
  title: string;
  businessStatus: string;
  campusName: string | null;
  ownerDisplayName: string | null;
  createdAt: Date;
  /** 活跃 moderation 摘要（处置中标识） */
  activeModeration: { id: string; createdAt: Date; reasonCode: string } | null;
  /** 待处置 tab：未结举报 reason 枚举（最多 5 条；绝不返回 detail 自由文本） */
  openReportReasons: string[];
  /** FR-01 内部分页元组（客户端无需理解领域含义）：
   *  browse/reports = listing.(createdAt,id)；active = moderation.(createdAt,id) */
  cursorCreatedAt: Date;
  cursorId: string;
};

/** FR-01 冻结 keyset 谓词（与 scope/campus/type/status/search/治理谓词 AND 合并，
 * 绝不覆盖既有过滤）：排序 (createdAt DESC, id DESC) 的续页条件为
 * createdAt < c OR (createdAt = c AND id < c.id)。 */
function listingKeysetWhere(cursor: { createdAt: Date; id: string } | null): Record<string, unknown> {
  if (!cursor) {
    return {};
  }
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      {
        AND: [{ createdAt: { equals: cursor.createdAt } }, { id: { lt: cursor.id } }],
      },
    ],
  };
}

/** FR-01 冻结分页返回形态：take = limit+1 → hasMore = rows.length > limit。 */
export type ModerationQueuePage = {
  items: ModerationQueueItem[];
  hasMore: boolean;
};

const REPORT_OPEN_STATUSES = ["OPEN", "IN_REVIEW"] as const;

type QueueOwnerRow = { id: string; title: string; status: string; createdAt: Date; campus: { name: string } | null; moderations: Array<{ id: string; createdAt: Date; reasonCode: string }>; reports: Array<{ reason: string }>; owner: { name: string } | null };

interface QueueDelegate {
  findMany(args: {
    where: Record<string, unknown>;
    orderBy: Array<Record<string, string>>;
    take: number;
    select: Record<string, unknown>;
  }): Promise<unknown[]>;
}

/** 四域 owner 关系键（select 用） */
const QUEUE_OWNER_KEY: Record<ListingModerationTargetType, string> = {
  PRODUCT: "seller",
  SERVICE: "provider",
  ERRAND: "publisher",
  RENTAL: "owner",
};

function queueSelect(targetType: ListingModerationTargetType): Record<string, unknown> {
  return {
    id: true,
    title: true,
    status: true,
    createdAt: true,
    campus: { select: { name: true } },
    [QUEUE_OWNER_KEY[targetType]]: { select: { name: true } },
    moderations: {
      where: { resolvedAt: null },
      take: 1,
      select: { id: true, createdAt: true, reasonCode: true },
    },
    reports: {
      where: { status: { in: [...REPORT_OPEN_STATUSES] } },
      select: { reason: true },
      take: 5,
      orderBy: { createdAt: "desc" },
    },
  };
}

function toQueueItem(
  targetType: ListingModerationTargetType,
  row: QueueOwnerRow,
): ModerationQueueItem {
  const owner = (row as unknown as Record<string, { name: string } | null>)[
    QUEUE_OWNER_KEY[targetType]
  ];
  return {
    key: `${targetType}:${row.id}`,
    targetType,
    listingId: row.id,
    title: row.title,
    businessStatus: row.status,
    campusName: row.campus?.name ?? null,
    ownerDisplayName: owner?.name ?? null,
    createdAt: row.createdAt,
    activeModeration: row.moderations[0] ?? null,
    openReportReasons: row.reports.map((report) => report.reason),
    cursorCreatedAt: row.createdAt,
    cursorId: row.id,
  };
}

async function runQueueQuery(
  targetType: ListingModerationTargetType,
  delegate: QueueDelegate,
  baseWhere: Record<string, unknown>,
  cursor: { createdAt: Date; id: string } | null,
  limit: number,
): Promise<ModerationQueuePage> {
  const rows = (await delegate.findMany({
    where: {
      ...baseWhere,
      ...listingKeysetWhere(cursor),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: queueSelect(targetType),
  })) as unknown as QueueOwnerRow[];
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map((row) => toQueueItem(targetType, row)),
    hasMore,
  };
}

/**
 * campus scope → 单列谓词（R2 冻结：campusId 是普通列——GLOBAL 无过滤，
 * campus-scoped 为 campusId IN manageableCampusIds；禁止 exact-pair 笛卡尔
 * 分支，不复刻 7A M-1 形态）。
 */
function queueCampusWhere(access: ListingModerationAccess): Record<string, unknown> {
  if (!access.global) {
    return { campusId: { in: access.campusIds } };
  }
  return {};
}

/** 每域 delegate + 主键过滤的静态绑定（服务端 typed switch，无动态表名）。 */
const QUEUE_DELEGATES: Record<
  ListingModerationTargetType,
  { delegate: QueueDelegate; listingIdField: string }
> = {
  PRODUCT: { delegate: prisma.product as unknown as QueueDelegate, listingIdField: "id" },
  SERVICE: { delegate: prisma.serviceListing as unknown as QueueDelegate, listingIdField: "id" },
  ERRAND: { delegate: prisma.errandTask as unknown as QueueDelegate, listingIdField: "id" },
  RENTAL: { delegate: prisma.rentalListing as unknown as QueueDelegate, listingIdField: "id" },
};

/** tab① 待处置举报：有 OPEN/IN_REVIEW 举报的 listing（举报域只读）。
 *  FR-01 冻结：排序元组 = listing.(createdAt, id)——四域 id 全局唯一，
 *  跨域 union 共用同一 (createdAt,id) cursor tuple 全局一致。 */
export async function loadReportFlaggedListings(args: {
  access: ListingModerationAccess;
  targetType: ListingModerationTargetType;
  cursor: { createdAt: Date; id: string } | null;
  limit: number;
}): Promise<ModerationQueuePage> {
  const { delegate } = QUEUE_DELEGATES[args.targetType];
  return runQueueQuery(
    args.targetType,
    delegate,
    {
      deletedAt: null,
      ...queueCampusWhere(args.access),
      reports: { some: { status: { in: [...REPORT_OPEN_STATUSES] } } },
    },
    args.cursor,
    args.limit,
  );
}

/** tab③ 浏览检视：campus 自动 scope + title 检索 + 状态过滤（独立于举报域）。
 *  FR-01 冻结：排序元组 = listing.(createdAt, id)。 */
export async function browseListings(args: {
  access: ListingModerationAccess;
  targetType: ListingModerationTargetType;
  q?: string;
  cursor: { createdAt: Date; id: string } | null;
  limit: number;
}): Promise<ModerationQueuePage> {
  const { delegate } = QUEUE_DELEGATES[args.targetType];
  return runQueueQuery(
    args.targetType,
    delegate,
    {
      deletedAt: null,
      ...queueCampusWhere(args.access),
      ...(args.q ? { title: { contains: args.q, mode: "insensitive" } } : {}),
    },
    args.cursor,
    args.limit,
  );
}

/** tab② 治理处置中：活跃 ListingModeration 行（跨四域统一视图）。
 *  FR-01 冻结：排序元组 = ListingModeration.(createdAt, id)（非 listingId）。 */
export async function loadActiveModerations(args: {
  access: ListingModerationAccess;
  cursor: { createdAt: Date; id: string } | null;
  limit: number;
}): Promise<ModerationQueuePage> {
  const rows = await prisma.listingModeration.findMany({
    where: {
      resolvedAt: null,
      ...queueCampusWhere(args.access),
      ...listingKeysetWhere(args.cursor),
    },
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    take: args.limit + 1,
    include: {
      product: { select: { title: true, status: true, seller: { select: { name: true } } } },
      serviceListing: { select: { title: true, status: true, provider: { select: { name: true } } } },
      errandTask: { select: { title: true, status: true, publisher: { select: { name: true } } } },
      rentalListing: { select: { title: true, status: true, owner: { select: { name: true } } } },
      campus: { select: { name: true } },
      moderator: { select: { name: true } },
      resolvedBy: { select: { name: true } },
    },
  });
  const hasMore = rows.length > args.limit;

  const items = rows.slice(0, args.limit).map((row) => {
    const target =
      row.product ?? row.serviceListing ?? row.errandTask ?? row.rentalListing;
    if (!target) {
      // CHECK 约束下不可达；fail closed
      throw new Error("LISTING_MODERATION_TARGET_MISSING");
    }
    const ownerName =
      ("seller" in target && target.seller?.name) ||
      ("provider" in target && target.provider?.name) ||
      ("publisher" in target && target.publisher?.name) ||
      ("owner" in target && target.owner?.name) ||
      null;
    return {
      key: `MODERATION:${row.id}`,
      targetType: row.targetType,
      listingId:
        row.productId ?? row.serviceListingId ?? row.errandTaskId ?? row.rentalListingId ?? "",
      title: target.title,
      businessStatus: target.status,
      campusName: row.campus.name,
      ownerDisplayName: ownerName,
      createdAt: row.createdAt,
      activeModeration: { id: row.id, createdAt: row.createdAt, reasonCode: row.reasonCode },
      openReportReasons: [],
      cursorCreatedAt: row.createdAt,
      cursorId: row.id,
    };
  });
  return { items, hasMore };
}

/** 治理 detail：目标 listing 的全部 moderation 历史（含 resolved）。 */
export async function loadListingModerationHistory(args: {
  targetType: ListingModerationTargetType;
  listingId: string;
}): Promise<
  Array<{
    id: string;
    reasonCode: string;
    note: string | null;
    createdAt: Date;
    resolvedAt: Date | null;
    moderatorDisplayName: string | null;
    resolvedByDisplayName: string | null;
  }>
> {
  const where: Record<string, unknown> = {};
  where[TARGET_FK_FIELD[args.targetType]] = args.listingId;
  const rows = await prisma.listingModeration.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      moderator: { select: { name: true } },
      resolvedBy: { select: { name: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    reasonCode: row.reasonCode,
    note: row.note,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    moderatorDisplayName: row.moderator.name,
    resolvedByDisplayName: row.resolvedBy?.name ?? null,
  }));
}


export type GovernanceListingDetail = {
  targetType: ListingModerationTargetType;
  listingId: string;
  title: string;
  description: string | null;
  businessStatus: string;
  campusId: string;
  campusName: string;
  ownerDisplayName: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  imageUrls: string[];
  pricing: string | null;
  locationText: string | null;
};

/** 四域 detail 加载（硬编码 typed 分支；显式 select = 数据最小化，禁 select *）。 */
export async function loadGovernanceListingDetail(
  targetType: ListingModerationTargetType,
  listingId: string,
): Promise<GovernanceListingDetail | null> {
  switch (targetType) {
    case "PRODUCT": {
      const row = await prisma.product.findFirst({
        where: { id: listingId, deletedAt: null },
        select: {
          id: true, title: true, description: true, status: true, createdAt: true, updatedAt: true,
          campus: { select: { id: true, name: true } },
          seller: { select: { id: true, name: true } },
          images: { orderBy: { sortOrder: "asc" }, select: { url: true } },
          price: true,
          locationText: true,
        },
      });
      if (!row) return null;
      return {
        targetType, listingId: row.id, title: row.title, description: row.description,
        businessStatus: row.status, campusId: row.campus.id, campusName: row.campus.name,
        ownerDisplayName: row.seller.name, ownerId: row.seller.id,
        createdAt: row.createdAt, updatedAt: row.updatedAt,
        imageUrls: row.images.map((image) => image.url),
        pricing: `¥${row.price.toString()}`,
        locationText: row.locationText,
      };
    }
    case "SERVICE": {
      const row = await prisma.serviceListing.findFirst({
        where: { id: listingId, deletedAt: null },
        select: {
          id: true, title: true, description: true, status: true, createdAt: true, updatedAt: true,
          campus: { select: { id: true, name: true } },
          provider: { select: { id: true, name: true } },
          price: true, pricingUnit: true, coverImageUrl: true, locationText: true,
        },
      });
      if (!row) return null;
      return {
        targetType, listingId: row.id, title: row.title, description: row.description,
        businessStatus: row.status, campusId: row.campus.id, campusName: row.campus.name,
        ownerDisplayName: row.provider.name, ownerId: row.provider.id,
        createdAt: row.createdAt, updatedAt: row.updatedAt,
        imageUrls: row.coverImageUrl ? [row.coverImageUrl] : [],
        pricing: `¥${row.price.toString()} / ${row.pricingUnit}`,
        locationText: row.locationText,
      };
    }
    case "ERRAND": {
      const row = await prisma.errandTask.findFirst({
        where: { id: listingId, deletedAt: null },
        select: {
          id: true, title: true, description: true, status: true, createdAt: true, updatedAt: true,
          campus: { select: { id: true, name: true } },
          publisher: { select: { id: true, name: true } },
          reward: true, pickupLocation: true, deliveryLocation: true,
        },
      });
      if (!row) return null;
      return {
        targetType, listingId: row.id, title: row.title, description: row.description,
        businessStatus: row.status, campusId: row.campus.id, campusName: row.campus.name,
        ownerDisplayName: row.publisher.name, ownerId: row.publisher.id,
        createdAt: row.createdAt, updatedAt: row.updatedAt,
        imageUrls: [],
        pricing: `¥${row.reward.toString()}`,
        locationText: `${row.pickupLocation} -> ${row.deliveryLocation}`,
      };
    }
    case "RENTAL": {
      const row = await prisma.rentalListing.findFirst({
        where: { id: listingId, deletedAt: null },
        select: {
          id: true, title: true, description: true, status: true, createdAt: true, updatedAt: true,
          campus: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true } },
          images: { orderBy: { sortOrder: "asc" }, select: { url: true } },
          price: true, pricingUnit: true, depositAmount: true,
          pickupLocation: true, returnLocation: true,
        },
      });
      if (!row) return null;
      return {
        targetType, listingId: row.id, title: row.title, description: row.description,
        businessStatus: row.status, campusId: row.campus.id, campusName: row.campus.name,
        ownerDisplayName: row.owner.name, ownerId: row.owner.id,
        createdAt: row.createdAt, updatedAt: row.updatedAt,
        imageUrls: row.images.map((image) => image.url),
        pricing: `¥${row.price.toString()} / ${row.pricingUnit}（押金 ¥${row.depositAmount.toString()}）`,
        locationText: `${row.pickupLocation}（取）/ ${row.returnLocation}（还）`,
      };
    }
  }
}


export type ModerationHistoryEntry = Awaited<ReturnType<typeof loadListingModerationHistory>>[number];
