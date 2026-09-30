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
 * Phase 7G 纠纷授权读模型；Phase 8C-02 起为 RentalDispute + OrderDispute
 * 统一运营队列/详情（operator surface 专用）。
 *
 * 授权在 DB 查询内完成（7A/7E 同款冻结）——绝不"取全量后内存过滤"：
 * - 分支集合由 deriveDisputeReviewAccess 的有效 scope 派生；两张表各自的
 *   查询都先带 authorized exact campus branches（filter 永远不能扩大授权范围）；
 * - GLOBAL 读者 = 权威 Campus 全表枚举的 exact pair；campus reviewer →
 *   仅其有效校区的 exact pair；
 * - 统一队列显式 discriminator：disputeKind ∈ {RENTAL, ORDER}。禁止通过
 *   ID 格式 / Order type 猜测 / 查表先后推断（两个独立 aggregate）；
 * - 统一排序 = dueAt ASC, createdAt ASC, disputeKind ASC, id ASC
 *   （kind 顺序冻结：ORDER < RENTAL——不依赖 JS object insertion order）；
 * - cursor = canonical base64url，keyset tuple = (dueAt, createdAt, kind, id)
 *   （kind 入 tuple 后两张表才构成可靠 global total order；旧三字段 cursor
 *   属 ephemeral operational position，decode 失败走既有安全失败页，不猜 kind）；
 * - DTO 最小化（queue privacy 冻结）：队列行绝不含 reason / evidencePhotos /
 *   adminNote / 私有 asset ref / email / phone / user-authored 内容；
 *   身份一律批量安全水合（missing/deleted/erased 统一 fallback）；详情仅在
 *   授权通过后进行 Stage B 敏感水合（两阶段读，授权失败路径绝不触碰敏感列）。
 */

export const DISPUTE_QUEUE_DEFAULT_PAGE_SIZE = 25;
export const DISPUTE_QUEUE_MAX_PAGE_SIZE = 50;

/** 统一运营面的显式 dispute discriminator（§5：禁止猜测）。 */
export type GovernanceDisputeKind = "RENTAL" | "ORDER";

/** 冻结 kind 全序：ORDER < RENTAL（统一排序与跨表 keyset 依赖此常量）。 */
const GOVERNANCE_DISPUTE_KIND_ORDER: Record<GovernanceDisputeKind, number> = {
  ORDER: 0,
  RENTAL: 1,
};

/** ORDER dispute 交易子类型的安全标签（不含 listing title / user 内容）。 */
const ORDER_TYPE_SAFE_LABELS: Record<string, string> = {
  PRODUCT: "二手商品",
  SERVICE: "技能服务",
  ERRAND: "跑腿任务",
};

/** 队列 type badge（§52：运营人员必须能快速识别 domain）。 */
const ORDER_TYPE_DISPUTE_BADGES: Record<string, string> = {
  PRODUCT: "商品订单纠纷",
  SERVICE: "服务订单纠纷",
  ERRAND: "跑腿订单纠纷",
};

function orderSafeLabel(orderType: string, orderNo: string): string {
  return `订单 ${orderNo} · ${ORDER_TYPE_SAFE_LABELS[orderType] ?? "普通订单"}`;
}

function orderTransactionKindLabel(orderType: string): string {
  return ORDER_TYPE_DISPUTE_BADGES[orderType] ?? "普通订单纠纷";
}

export type DisputeQueueItemDto = {
  disputeKind: GovernanceDisputeKind;
  disputeId: string;
  status: "OPEN" | "IN_REVIEW" | "RESOLVED" | "CLOSED";
  campusId: string;
  campusName: string;
  /** 安全订单摘要（无 PII / 无 user-authored 内容） */
  safeOrderLabel: string;
  /** 交易类型徽标（租赁纠纷 / 商品订单纠纷 / 服务订单纠纷 / 跑腿订单纠纷） */
  transactionKindLabel: string;
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
  status?: "OPEN" | "IN_REVIEW" | "RESOLVED" | "CLOSED";
  assignment?: "mine" | "unassigned" | "all";
  overdueOnly?: boolean;
  kind?: GovernanceDisputeKind;
};

export type DisputeCursor = {
  dueAt: Date;
  createdAt: Date;
  kind: GovernanceDisputeKind;
  id: string;
};

/** 由实际返回的最后一条生成下一页 cursor（base64url(JSON)）。 */
export function encodeDisputeCursor(cursor: DisputeCursor): string {
  return Buffer.from(
    JSON.stringify({
      dueAt: cursor.dueAt.toISOString(),
      createdAt: cursor.createdAt.toISOString(),
      kind: cursor.kind,
      id: cursor.id,
    }),
  ).toString("base64url");
}

/** 解码客户端回传 cursor（FR03 canonical 纪律，SSOT helper）；任何解析/校验
 * 失败返回 null（调用方安全失败态）。旧三字段 cursor 键集不等 → null →
 * 既有安全失败页（不猜 kind，§29）。 */
export function decodeDisputeCursor(raw: string): DisputeCursor | null {
  const payload = parseCanonicalCursorJson(raw, ["dueAt", "createdAt", "kind", "id"]);
  if (!payload) {
    return null;
  }
  const dueAt = parseCanonicalCursorDate(payload.dueAt);
  const createdAt = parseCanonicalCursorDate(payload.createdAt);
  if (!dueAt || !createdAt || payload.id.length === 0) {
    return null;
  }
  if (payload.kind !== "RENTAL" && payload.kind !== "ORDER") {
    return null;
  }
  const cursor: DisputeCursor = { dueAt, createdAt, kind: payload.kind, id: payload.id };
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

/**
 * 单表 keyset 条件（§31 table-specific；统一全序 (dueAt, createdAt, kind, id)）：
 * - 本表 kind == cursor.kind：标准三列 tuple（dueAt > ∨ =∧createdAt > ∨
 *   =∧=∧id >）；
 * - 本表 kind > cursor.kind：equal (dueAt, createdAt) 下本表整段都在 cursor
 *   之后 → dueAt >= 即可（createdAt / id 任意）；
 * - 本表 kind < cursor.kind：equal (dueAt, createdAt) 下本表整段都在 cursor
 *   之前 → 只能靠 dueAt / createdAt 前进（不得加 id 条件——否则跨表翻页漏/重）。
 * 禁止简单给两张表都 `id > cursor.id`（跨表 pagination 会漏项/重复）。
 */
function kindAwareKeysetCondition(
  cursor: DisputeCursor,
  tableKind: GovernanceDisputeKind,
) {
  if (tableKind === cursor.kind) {
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
  if (GOVERNANCE_DISPUTE_KIND_ORDER[tableKind] > GOVERNANCE_DISPUTE_KIND_ORDER[cursor.kind]) {
    return { dueAt: { gte: cursor.dueAt } };
  }
  return {
    OR: [
      { dueAt: { gt: cursor.dueAt } },
      { dueAt: { equals: cursor.dueAt }, createdAt: { gt: cursor.createdAt } },
    ],
  };
}

// 队列 select 结构性不含 reason / evidencePhotos / adminNote（queue privacy 冻结）
const queueRentalSelect = {
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

// OrderDispute 队列 select：仅 orderNo + type 安全摘要（不加 Product/Service/
// Errand title / reason——减少 operator queue 中 user-authored 内容）
const queueOrderSelect = {
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
      orderNo: true,
      type: true,
    },
  },
} satisfies Prisma.OrderDisputeSelect;

type QueueCandidate = DisputeQueueItemDto & {
  /** 排序用的 raw 时间戳（mapping 前的全局排序键） */
  _dueAt: Date;
  _createdAt: Date;
  _initiatorId: string;
  _assignedToId: string | null;
};

/** 冻结全序比较器：dueAt ASC → createdAt ASC → kind(ORDER<RENTAL) ASC → id ASC。 */
function compareQueueCandidates(a: QueueCandidate, b: QueueCandidate): number {
  if (a._dueAt.getTime() !== b._dueAt.getTime()) {
    return a._dueAt.getTime() < b._dueAt.getTime() ? -1 : 1;
  }
  if (a._createdAt.getTime() !== b._createdAt.getTime()) {
    return a._createdAt.getTime() < b._createdAt.getTime() ? -1 : 1;
  }
  const kindDiff =
    GOVERNANCE_DISPUTE_KIND_ORDER[a.disputeKind] - GOVERNANCE_DISPUTE_KIND_ORDER[b.disputeKind];
  if (kindDiff !== 0) {
    return kindDiff;
  }
  if (a.disputeId !== b.disputeId) {
    return a.disputeId < b.disputeId ? -1 : 1;
  }
  return 0;
}

/**
 * 统一交易纠纷队列（§30 merge pagination）：
 * 分别执行 authorized Rental / Order 查询（各自带 exact campus branches、
 * 同一 kind-aware cursor 裁剪，各取 limit + 1）→ map 到 common DTO →
 * deterministic global sort → take limit + 1 → first limit = page →
 * hasMore = 存在第 limit + 1 项（绝不用单表行数直接判定 global hasMore）→
 * last returned row → next cursor。不漏项、不重复、稳定跨页。
 */
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

  // requested filters 恒 AND 在 scope 谓词之内（不能扩大授权范围）；两表各自
  // 构建带自身 WhereInput 类型的条件（filter 数据源共享，语义恒一致）
  const rentalAND: Prisma.RentalDisputeWhereInput[] = [
    {
      OR: branches.map((branch) => ({
        campusId: branch.campusId,
        scopeKey: branch.scopeKey,
      })),
    },
  ];
  const orderAND: Prisma.OrderDisputeWhereInput[] = [
    {
      OR: branches.map((branch) => ({
        campusId: branch.campusId,
        scopeKey: branch.scopeKey,
      })),
    },
  ];

  if (filters.campusId) {
    const campusBranch = {
      campusId: filters.campusId,
      scopeKey: disputeReviewCampusBranch(filters.campusId).scopeKey,
    };
    rentalAND.push(campusBranch);
    orderAND.push(campusBranch);
  }
  if (filters.status) {
    rentalAND.push({ status: filters.status });
    orderAND.push({ status: filters.status });
  }
  if (filters.assignment === "mine") {
    rentalAND.push({ assignedToId: input.viewerId });
    orderAND.push({ assignedToId: input.viewerId });
  } else if (filters.assignment === "unassigned") {
    rentalAND.push({ assignedToId: null });
    orderAND.push({ assignedToId: null });
  }
  if (filters.overdueOnly) {
    // OVERDUE 只读判定 = active ∧ dueAt < now（DB 侧同语义前置过滤；零自动执法）
    rentalAND.push({ status: { in: ["OPEN", "IN_REVIEW"] }, dueAt: { lt: new Date() } });
    orderAND.push({ status: { in: ["OPEN", "IN_REVIEW"] }, dueAt: { lt: new Date() } });
  }
  if (input.cursor) {
    rentalAND.push(kindAwareKeysetCondition(input.cursor, "RENTAL"));
    orderAND.push(kindAwareKeysetCondition(input.cursor, "ORDER"));
  }

  const rentalFiltersApply = filters.kind === undefined || filters.kind === "RENTAL";
  const orderFiltersApply = filters.kind === undefined || filters.kind === "ORDER";

  const [rentalRows, orderRows] = await Promise.all([
    rentalFiltersApply
      ? prisma.rentalDispute.findMany({
          where: { AND: rentalAND },
          orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          take: input.limit + 1,
          select: queueRentalSelect,
        })
      : Promise.resolve([]),
    orderFiltersApply
      ? prisma.orderDispute.findMany({
          where: { AND: orderAND },
          orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          take: input.limit + 1,
          select: queueOrderSelect,
        })
      : Promise.resolve([]),
  ]);

  const rentalCandidates: QueueCandidate[] = rentalRows.map((row) => ({
    disputeKind: "RENTAL" as const,
    disputeId: row.id,
    status: row.status,
    campusId: row.campusId,
    campusName: row.campus?.name ?? "未知校区",
    safeOrderLabel: `订单 ${row.order.orderNumber} · ${row.order.rentalListing.title}`,
    transactionKindLabel: "租赁纠纷",
    initiatorName: "",
    assignedReviewer: null,
    createdAt: row.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    overdue: isDisputeOverdue({ status: row.status, dueAt: row.dueAt }),
    _dueAt: row.dueAt,
    _createdAt: row.createdAt,
    _initiatorId: row.initiatorId,
    _assignedToId: row.assignedToId,
  }));

  const orderCandidates: QueueCandidate[] = orderRows.map((row) => ({
    disputeKind: "ORDER" as const,
    disputeId: row.id,
    status: row.status,
    campusId: row.campusId,
    campusName: row.campus?.name ?? "未知校区",
    safeOrderLabel: orderSafeLabel(row.order.type, row.order.orderNo),
    transactionKindLabel: orderTransactionKindLabel(row.order.type),
    initiatorName: "",
    assignedReviewer: null,
    createdAt: row.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    overdue: isDisputeOverdue({ status: row.status, dueAt: row.dueAt }),
    _dueAt: row.dueAt,
    _createdAt: row.createdAt,
    _initiatorId: row.initiatorId,
    _assignedToId: row.assignedToId,
  }));

  // merge → deterministic global sort → limit + 1 判定 global hasMore
  const merged = [...rentalCandidates, ...orderCandidates].sort(compareQueueCandidates);
  const hasMore = merged.length > input.limit;
  const pageCandidates = hasMore ? merged.slice(0, input.limit) : merged;

  // 单次批量安全水合（§83：绝不每行一查）
  const identityIds = pageCandidates.flatMap((row) => {
    const ids = [row._initiatorId];
    if (row._assignedToId) {
      ids.push(row._assignedToId);
    }
    return ids;
  });
  const identities = await hydrateSafeIdentities(identityIds);

  const items: DisputeQueueItemDto[] = pageCandidates.map((row) => ({
    disputeKind: row.disputeKind,
    disputeId: row.disputeId,
    status: row.status,
    campusId: row.campusId,
    campusName: row.campusName,
    safeOrderLabel: row.safeOrderLabel,
    transactionKindLabel: row.transactionKindLabel,
    initiatorName: identities.get(row._initiatorId)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME,
    assignedReviewer:
      row._assignedToId !== null
        ? (identities.get(row._assignedToId)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME)
        : null,
    createdAt: row.createdAt,
    dueAt: row.dueAt,
    overdue: row.overdue,
  }));

  const last = pageCandidates[pageCandidates.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeDisputeCursor({
            dueAt: last._dueAt,
            createdAt: last._createdAt,
            kind: last.disputeKind,
            id: last.disputeId,
          })
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

/**
 * General OrderDispute 详情 DTO（Phase 8C-02）。当事人用 participants
 * 结构（label 按交易子类型），不强制 owner/renter 命名；evidence 恒不支持
 * （8C-02 未开放附件——绝不读 evidencePhotos token）。
 */
export type OrderDisputeDetailDto = {
  disputeId: string;
  status: "OPEN" | "IN_REVIEW" | "RESOLVED" | "CLOSED";
  campusId: string;
  campusName: string;
  orderId: string;
  orderType: string;
  safeOrderLabel: string;
  initiatorName: string;
  participants: Array<{ label: string; displayName: string }>;
  /** 纠纷描述全文（Stage B：授权通过后才查询） */
  reason: string;
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
  openedFromOrderStatus: string;
  openedFromErrandStatus: string | null;
  scopeAuthorized: boolean;
  evidenceSupported: false;
};

export type DisputeDetailResult =
  | { ok: true; kind: "RENTAL"; detail: DisputeDetailDto }
  | { ok: true; kind: "ORDER"; detail: OrderDisputeDetailDto }
  | { ok: false };

/**
 * 详情授权 dispatcher（§37：kind 显式路由，禁止跨表 fallback）：
 *   RENTAL → Rental detail loader（Phase 7G 原行为）
 *   ORDER  → OrderDispute detail loader（同构 Stage A → authorize → Stage B）
 * 每一类都保留 Stage A minimal authority anchor → authorization → Stage B
 * sensitive hydration；禁止"先 load reason 再授权"。
 * missing / wrong kind / malformed scope / 跨校区越权 全部同形 { ok:false }
 * （调用方映射 notFound()，anti-oracle：不告诉 operator"该 ID 是另一种纠纷"）。
 */
export async function loadAuthorizedDisputeDetail(input: {
  viewerId: string;
  context: AuthorizationContext;
  access: DisputeReviewAccess;
  disputeId: string;
  kind: GovernanceDisputeKind;
}): Promise<DisputeDetailResult> {
  if (input.kind === "ORDER") {
    const result = await loadAuthorizedOrderDisputeDetail(input);
    if (!result.ok) {
      return result;
    }
    return { ok: true, kind: "ORDER", detail: result.detail };
  }
  const result = await loadAuthorizedRentalDisputeDetail(input);
  if (!result.ok) {
    return result;
  }
  return { ok: true, kind: "RENTAL", detail: result.detail };
}

async function loadAuthorizedRentalDisputeDetail(input: {
  viewerId: string;
  context: AuthorizationContext;
  access: DisputeReviewAccess;
  disputeId: string;
}): Promise<{ ok: true; detail: DisputeDetailDto } | { ok: false }> {
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

/** General 当事人 label（§41：按交易子类型；buyer=第一当事人，seller=第二）。 */
function orderParticipantLabels(orderType: string): [string, string] {
  if (orderType === "SERVICE") {
    return ["预约方", "服务者"];
  }
  if (orderType === "ERRAND") {
    return ["发布者", "接单者"];
  }
  return ["买家", "卖家"];
}

/**
 * General OrderDispute 详情（两阶段读，与 Rental loader 同构同冻结顺序）：
 * Stage A 仅查 id/campusId/scopeKey/status/orderId（结构性零 reason/evidence/
 * adminNote）；resolveDisputeScope + canReviewDisputeCampus 通过后才 Stage B
 * 敏感水合。错误族（missing / malformed scope / 越权）统一 { ok:false }。
 */
async function loadAuthorizedOrderDisputeDetail(input: {
  viewerId: string;
  context: AuthorizationContext;
  access: DisputeReviewAccess;
  disputeId: string;
}): Promise<{ ok: true; detail: OrderDisputeDetailDto } | { ok: false }> {
  // ---- Stage A：最小 authority 锚点（零敏感载荷） ----
  const anchor = await prisma.orderDispute.findUnique({
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

  // ---- Stage B：授权通过后的敏感水合（不读 Order.note / meetingLocation /
  // cancelReason；不读 evidencePhotos——8C-02 不开放 token）----
  const row = await prisma.orderDispute.findUnique({
    where: { id: input.disputeId },
    select: {
      id: true,
      status: true,
      campusId: true,
      campus: { select: { name: true } },
      scopeKey: true,
      initiatorId: true,
      reason: true,
      adminNote: true,
      createdAt: true,
      dueAt: true,
      assignedToId: true,
      resolutionCode: true,
      resolutionAction: true,
      resolvedAt: true,
      resolvedById: true,
      openedFromOrderStatus: true,
      openedFromErrandStatus: true,
      order: {
        select: {
          id: true,
          orderNo: true,
          type: true,
          buyerId: true,
          sellerId: true,
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
    row.order.buyerId,
    row.order.sellerId,
    row.assignedToId,
    row.resolvedById,
  ].filter((id): id is string => id !== null);
  const identities = await hydrateSafeIdentities(identityIds);

  const fallbackName = (id: string) =>
    identities.get(id)?.displayName ?? UNAVAILABLE_USER_DISPLAY_NAME;

  const [firstLabel, secondLabel] = orderParticipantLabels(row.order.type);

  return {
    ok: true,
    detail: {
      disputeId: row.id,
      status: row.status,
      campusId: row.campusId,
      campusName: row.campus?.name ?? "未知校区",
      orderId: row.order.id,
      orderType: row.order.type,
      safeOrderLabel: orderSafeLabel(row.order.type, row.order.orderNo),
      initiatorName: fallbackName(row.initiatorId),
      participants: [
        { label: firstLabel, displayName: fallbackName(row.order.buyerId) },
        { label: secondLabel, displayName: fallbackName(row.order.sellerId) },
      ],
      reason: row.reason,
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
      openedFromErrandStatus: row.openedFromErrandStatus,
      scopeAuthorized: canReviewDisputeCampus(input.access, row.campusId),
      evidenceSupported: false,
    },
  };
}
