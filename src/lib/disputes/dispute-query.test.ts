import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  campusFindMany,
  disputeFindMany,
  disputeFindUnique,
  orderDisputeFindMany,
  orderDisputeFindUnique,
  userFindMany,
} = vi.hoisted(() => ({
  campusFindMany: vi.fn(),
  disputeFindMany: vi.fn(),
  disputeFindUnique: vi.fn(),
  orderDisputeFindMany: vi.fn(),
  orderDisputeFindUnique: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campus: { findMany: campusFindMany },
    rentalDispute: { findMany: disputeFindMany, findUnique: disputeFindUnique },
    orderDispute: { findMany: orderDisputeFindMany, findUnique: orderDisputeFindUnique },
    user: { findMany: userFindMany },
  },
}));

import {
  decodeDisputeCursor,
  encodeDisputeCursor,
  listDisputeQueueCampuses,
  loadAuthorizedDisputeDetail,
  loadAuthorizedDisputeQueue,
  type DisputeQueueFilters,
} from "@/lib/disputes/dispute-query";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7G：queue 授权谓词/过滤组合 + FR03 canonical cursor + 两阶段详情的
 * WHERE/形状合同；Phase 8C-02：RentalDispute + OrderDispute 统一队列
 * （kind discriminator / 全序 dueAt→createdAt→kind→id / kind-aware 跨表
 * keyset / queue privacy 不因 union 削弱）。真实 PG 行为在
 * tests/integration/phase8c-02-order-dispute-surfaces.test.ts 覆盖。
 */

const GLOBAL_ACCESS = { global: true, campusIds: [] as string[] };
const CAMPUS_A_ACCESS = { global: false, campusIds: ["A"] };

function disputeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dispute-1",
    status: "OPEN",
    campusId: "A",
    campus: { name: "甲校区" },
    scopeKey: "CAMPUS:A",
    initiatorId: "initiator-1",
    dueAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    createdAt: new Date("2026-09-19T00:00:00.000Z"),
    assignedToId: null,
    order: {
      orderNumber: "RO-1",
      rentalListing: { title: "投影仪" },
    },
    ...overrides,
  };
}

function orderDisputeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "od-1",
    status: "OPEN",
    campusId: "A",
    campus: { name: "甲校区" },
    scopeKey: "CAMPUS:A",
    initiatorId: "initiator-1",
    dueAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    createdAt: new Date("2026-09-19T00:00:00.000Z"),
    assignedToId: null,
    order: {
      orderNo: "PO-1",
      type: "PRODUCT",
    },
    ...overrides,
  };
}

function authCtx(): AuthorizationContext {
  return { userId: "viewer-1", accountActive: true, activeCampusIds: ["A"], grants: [] };
}

// ── 内存 where 求值器：对生成的 Prisma 条件形状做真实过滤（跨页翻页模拟）────
type Row = Record<string, unknown>;

/** 比较语义与 DB 一致：Date 按时刻，字符串按字典序。 */
function before(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() < b.getTime();
  return String(a) < String(b);
}

function afterOrEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() >= b.getTime();
  return String(a) >= String(b);
}

function evalCondition(row: Row, cond: Row): boolean {
  for (const [key, value] of Object.entries(cond)) {
    if (key === "OR") {
      if (!(value as Row[]).some((c) => evalCondition(row, c))) return false;
      continue;
    }
    if (key === "AND") {
      if (!(value as Row[]).every((c) => evalCondition(row, c))) return false;
      continue;
    }
    const field = row[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [op, operand] of Object.entries(value as Row)) {
        if (op === "gt" && !before(operand, field)) return false;
        if (op === "gte" && !afterOrEqual(field, operand)) return false;
        if (op === "lt" && !before(field, operand)) return false;
        // Date 的 equals 语义 = 时刻相等（DB timestamptz equality），非引用相等
        if (op === "equals") {
          const equal =
            field instanceof Date && operand instanceof Date
              ? field.getTime() === operand.getTime()
              : field === operand;
          if (!equal) return false;
        }
        if (op === "in" && !(operand as unknown[]).includes(field)) return false;
      }
      continue;
    }
    if (field !== value) return false;
  }
  return true;
}

/** 安装内存数据集 mock：按生成的 where/orderBy/take 真实过滤排序裁剪。 */
function installQueueDatasets(rentalRows: Row[], orderRows: Row[]) {
  const byGlobalOrder = (a: Row, b: Row) =>
    (a.dueAt as Date).getTime() - (b.dueAt as Date).getTime() ||
    (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime() ||
    ((a.id as string) < (b.id as string) ? -1 : 1);
  disputeFindMany.mockImplementation(async (args: { where: Row; orderBy: Row[]; take: number }) => {
    const rows = rentalRows.filter((r) => evalCondition(r, args.where));
    rows.sort(byGlobalOrder);
    return rows.slice(0, args.take);
  });
  orderDisputeFindMany.mockImplementation(async (args: { where: Row; orderBy: Row[]; take: number }) => {
    const rows = orderRows.filter((r) => evalCondition(r, args.where));
    rows.sort(byGlobalOrder);
    return rows.slice(0, args.take);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  disputeFindMany.mockResolvedValue([]);
  orderDisputeFindMany.mockResolvedValue([]);
  userFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id: string) => ({ id, name: `用户-${id}`, deletedAt: null, erasedAt: null })),
  );
});

describe("dispute cursor（FR03 canonical 纪律；Phase 8C-02 四元组含 kind）", () => {
  it("encode → decode 往返相等（dueAt/createdAt/kind/id）", () => {
    const cursor = {
      dueAt: new Date("2026-09-21T00:00:00.000Z"),
      createdAt: new Date("2026-09-19T00:00:00.000Z"),
      kind: "ORDER" as const,
      id: "dispute-1",
    };
    const raw = encodeDisputeCursor(cursor);
    expect(decodeDisputeCursor(raw)).toEqual(cursor);

    const rentalCursor = { ...cursor, kind: "RENTAL" as const };
    expect(decodeDisputeCursor(encodeDisputeCursor(rentalCursor))).toEqual(rentalCursor);
  });

  it("非 canonical 输入一律 null（raw 白名单/键集/ISO/re-encode）", () => {
    const cursor = {
      dueAt: new Date("2026-09-21T00:00:00.000Z"),
      createdAt: new Date("2026-09-19T00:00:00.000Z"),
      kind: "ORDER" as const,
      id: "dispute-1",
    };
    const raw = encodeDisputeCursor(cursor);
    // 标准 base64 字符（+ / =）不在 raw 白名单
    expect(decodeDisputeCursor(raw.replace(/-/g, "+").replace(/_/g, "/") + "=")).toBeNull();
    // 非 canonical ISO（毫秒缺失）
    const nonCanonical = Buffer.from(
      JSON.stringify({ dueAt: "2026-09-21T00:00:00Z", createdAt: cursor.createdAt.toISOString(), kind: "ORDER", id: "d" }),
    ).toString("base64url");
    expect(decodeDisputeCursor(nonCanonical)).toBeNull();
    // 键集不 exact（多字段）
    const extraKeys = Buffer.from(
      JSON.stringify({
        dueAt: cursor.dueAt.toISOString(),
        createdAt: cursor.createdAt.toISOString(),
        kind: "ORDER",
        id: "d",
        extra: "x",
      }),
    ).toString("base64url");
    expect(decodeDisputeCursor(extraKeys)).toBeNull();
    // 空 id
    const emptyId = Buffer.from(
      JSON.stringify({
        dueAt: cursor.dueAt.toISOString(),
        createdAt: cursor.createdAt.toISOString(),
        kind: "ORDER",
        id: "",
      }),
    ).toString("base64url");
    expect(decodeDisputeCursor(emptyId)).toBeNull();
    // 结构破坏
    expect(decodeDisputeCursor("not-base64url!")).toBeNull();
  });

  it("§58：旧三字段 cursor（无 kind）→ 键集不等 → null（安全失败页，不猜 kind）", () => {
    const legacy = Buffer.from(
      JSON.stringify({
        dueAt: "2026-09-21T00:00:00.000Z",
        createdAt: "2026-09-19T00:00:00.000Z",
        id: "dispute-1",
      }),
    ).toString("base64url");
    expect(decodeDisputeCursor(legacy)).toBeNull();
  });

  it("§58：unknown kind → null", () => {
    const badKind = Buffer.from(
      JSON.stringify({
        dueAt: "2026-09-21T00:00:00.000Z",
        createdAt: "2026-09-19T00:00:00.000Z",
        kind: "GENERAL",
        id: "dispute-1",
      }),
    ).toString("base64url");
    expect(decodeDisputeCursor(badKind)).toBeNull();
  });
});

describe("loadAuthorizedDisputeQueue（DB 内授权 + filter 收敛；两表统一）", () => {
  it("fail-closed：零有效 scope 永远空页（零 DB 调用）", async () => {
    const page = await loadAuthorizedDisputeQueue({
      viewerId: "v1",
      access: { global: false, campusIds: [] },
      limit: 25,
    });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(disputeFindMany).not.toHaveBeenCalled();
    expect(orderDisputeFindMany).not.toHaveBeenCalled();
  });

  it("GQ-08 前置：GLOBAL → 全 Campus exact-pair 分支枚举；campus reviewer → 仅其校区（两表同谓词）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }, { id: "B" }]);
    await loadAuthorizedDisputeQueue({ viewerId: "v1", access: GLOBAL_ACCESS, limit: 25 });

    const globalCall = disputeFindMany.mock.calls.at(-1)![0];
    expect(globalCall.where.AND[0].OR).toEqual([
      { campusId: "A", scopeKey: "CAMPUS:A" },
      { campusId: "B", scopeKey: "CAMPUS:B" },
    ]);
    const orderGlobalCall = orderDisputeFindMany.mock.calls.at(-1)![0];
    expect(orderGlobalCall.where.AND[0].OR).toEqual([
      { campusId: "A", scopeKey: "CAMPUS:A" },
      { campusId: "B", scopeKey: "CAMPUS:B" },
    ]);
    expect(globalCall.orderBy).toEqual([
      { dueAt: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ]);
    expect(globalCall.take).toBe(26);
    expect(orderGlobalCall.take).toBe(26);

    disputeFindMany.mockClear();
    orderDisputeFindMany.mockClear();
    await loadAuthorizedDisputeQueue({ viewerId: "v1", access: CAMPUS_A_ACCESS, limit: 25 });
    const campusCall = disputeFindMany.mock.calls.at(-1)![0];
    expect(campusCall.where.AND[0].OR).toEqual([{ campusId: "A", scopeKey: "CAMPUS:A" }]);
    const orderCampusCall = orderDisputeFindMany.mock.calls.at(-1)![0];
    expect(orderCampusCall.where.AND[0].OR).toEqual([{ campusId: "A", scopeKey: "CAMPUS:A" }]);
  });

  it("GQ-08：campus filter 恒 AND 在 scope 之内（不能扩大授权范围）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }, { id: "B" }]);
    // reviewer 仅 campus A，却提交 campus B 过滤 → campus B 条件必须与
    // scopeKey exact pair 合取（不在授权分支 → 命中为空）
    await loadAuthorizedDisputeQueue({
      viewerId: "v1",
      access: CAMPUS_A_ACCESS,
      limit: 25,
      filters: { campusId: "B" },
    });

    const whereAND = disputeFindMany.mock.calls.at(-1)![0].where.AND;
    expect(whereAND[0]).toEqual({ OR: [{ campusId: "A", scopeKey: "CAMPUS:A" }] });
    expect(whereAND[1]).toEqual({ campusId: "B", scopeKey: "CAMPUS:B" });
  });

  it("filter 恒 AND 在 scope 之内（campus/status/assignment/overdue/kind-aware cursor）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }, { id: "B" }]);

    const filters: DisputeQueueFilters = {
      campusId: "A",
      status: "OPEN",
      assignment: "mine",
      overdueOnly: true,
    };
    await loadAuthorizedDisputeQueue({
      viewerId: "viewer-1",
      access: GLOBAL_ACCESS,
      limit: 25,
      filters,
      cursor: {
        dueAt: new Date("2026-09-21T00:00:00.000Z"),
        createdAt: new Date("2026-09-19T00:00:00.000Z"),
        kind: "RENTAL",
        id: "d0",
      },
    });

    // Rental 表（tableKind == cursor.kind）→ 标准三列 tuple
    const whereAND = disputeFindMany.mock.calls.at(-1)![0].where.AND;
    expect(whereAND).toEqual([
      expect.anything(), // scope predicate
      { campusId: "A", scopeKey: "CAMPUS:A" },
      { status: "OPEN" },
      { assignedToId: "viewer-1" },
      { status: { in: ["OPEN", "IN_REVIEW"] }, dueAt: { lt: expect.any(Date) } },
      {
        OR: [
          { dueAt: { gt: new Date("2026-09-21T00:00:00.000Z") } },
          {
            dueAt: { equals: new Date("2026-09-21T00:00:00.000Z") },
            createdAt: { gt: new Date("2026-09-19T00:00:00.000Z") },
          },
          {
            dueAt: { equals: new Date("2026-09-21T00:00:00.000Z") },
            createdAt: { equals: new Date("2026-09-19T00:00:00.000Z") },
            id: { gt: "d0" },
          },
        ],
      },
    ]);

    // Order 表（tableKind ORDER < cursor.kind RENTAL）→ equal (dueAt,createdAt)
    // 整段在 cursor 之前：仅 dueAt/createdAt 前进，绝无 id 条件（§31）
    const orderWhereAND = orderDisputeFindMany.mock.calls.at(-1)![0].where.AND;
    expect(orderWhereAND.at(-1)).toEqual({
      OR: [
        { dueAt: { gt: new Date("2026-09-21T00:00:00.000Z") } },
        {
          dueAt: { equals: new Date("2026-09-21T00:00:00.000Z") },
          createdAt: { gt: new Date("2026-09-19T00:00:00.000Z") },
        },
      ],
    });

    // 反向：cursor.kind=ORDER → Rental 表（T > C）：equal (dueAt, createdAt)
    // 下本表整段在 cursor 后（k > K），但 (d == D, c < C) 必须排除——
    // 三支 OR tuple 展开，绝不允许 dueAt gte 捷径（review blocker）
    await loadAuthorizedDisputeQueue({
      viewerId: "viewer-1",
      access: GLOBAL_ACCESS,
      limit: 25,
      cursor: {
        dueAt: new Date("2026-09-21T00:00:00.000Z"),
        createdAt: new Date("2026-09-19T00:00:00.000Z"),
        kind: "ORDER",
        id: "od0",
      },
    });
    const rentalKindAfter = disputeFindMany.mock.calls.at(-1)![0].where.AND.at(-1);
    expect(rentalKindAfter).toEqual({
      OR: [
        { dueAt: { gt: new Date("2026-09-21T00:00:00.000Z") } },
        {
          dueAt: { equals: new Date("2026-09-21T00:00:00.000Z") },
          createdAt: { gt: new Date("2026-09-19T00:00:00.000Z") },
        },
        {
          dueAt: { equals: new Date("2026-09-21T00:00:00.000Z") },
          createdAt: { equals: new Date("2026-09-19T00:00:00.000Z") },
        },
      ],
    });
    // NO dueAt gte shortcut：gte 会错误包含 (d == D, c < C) 的已翻页行
    expect(JSON.stringify(rentalKindAfter)).not.toContain('"gte"');
    // Order 表（T == C）→ 标准 tuple（含 id 条件）
    const orderTuple = JSON.stringify(orderDisputeFindMany.mock.calls.at(-1)![0].where.AND.at(-1));
    expect(orderTuple).toContain('"gt"');
    expect(orderTuple).toContain('"id"');
  });

  it("GQ-06/GQ-07：kind filter → 仅执行对应表查询（另一表零调用）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);

    await loadAuthorizedDisputeQueue({
      viewerId: "v1",
      access: CAMPUS_A_ACCESS,
      limit: 25,
      filters: { kind: "RENTAL" },
    });
    expect(disputeFindMany).toHaveBeenCalledTimes(1);
    expect(orderDisputeFindMany).not.toHaveBeenCalled();

    disputeFindMany.mockClear();
    await loadAuthorizedDisputeQueue({
      viewerId: "v1",
      access: CAMPUS_A_ACCESS,
      limit: 25,
      filters: { kind: "ORDER" },
    });
    expect(disputeFindMany).not.toHaveBeenCalled();
    expect(orderDisputeFindMany).toHaveBeenCalledTimes(1);
  });

  it("GQ-01：Rental-only 数据 → 队列仅 Rental 行（kind/labels 正确）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    installQueueDatasets([disputeRow()], []);

    const page = await loadAuthorizedDisputeQueue({ viewerId: "v1", access: CAMPUS_A_ACCESS, limit: 25 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      disputeKind: "RENTAL",
      disputeId: "dispute-1",
      safeOrderLabel: "订单 RO-1 · 投影仪",
      transactionKindLabel: "租赁纠纷",
    });
    expect(page.nextCursor).toBeNull();
  });

  it("GQ-02：Order-only 数据 → 队列仅 Order 行（安全标签按交易子类型）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    const t = new Date("2026-09-21T00:00:00.000Z");
    const base = { dueAt: t, createdAt: t };
    installQueueDatasets([], [
      orderDisputeRow({ ...base, id: "od-p", order: { orderNo: "PO-1", type: "PRODUCT" } }),
      orderDisputeRow({ ...base, id: "od-s", order: { orderNo: "PO-2", type: "SERVICE" } }),
      orderDisputeRow({ ...base, id: "od-e", order: { orderNo: "PO-3", type: "ERRAND" } }),
    ]);

    const page = await loadAuthorizedDisputeQueue({ viewerId: "v1", access: CAMPUS_A_ACCESS, limit: 25 });

    // 同刻 tie-break：kind 相同 → id ASC
    expect(page.items.map((i) => i.disputeId)).toEqual(["od-e", "od-p", "od-s"]);
    const byId = new Map(page.items.map((i) => [i.disputeId, i]));
    expect(byId.get("od-e")).toMatchObject({
      disputeKind: "ORDER",
      safeOrderLabel: "订单 PO-3 · 跑腿任务",
      transactionKindLabel: "跑腿订单纠纷",
    });
    expect(byId.get("od-p")).toMatchObject({
      disputeKind: "ORDER",
      safeOrderLabel: "订单 PO-1 · 二手商品",
      transactionKindLabel: "商品订单纠纷",
    });
    expect(byId.get("od-s")!.safeOrderLabel).toBe("订单 PO-2 · 技能服务");
    expect(byId.get("od-s")!.transactionKindLabel).toBe("服务订单纠纷");
  });

  it("GQ-03：mixed 队列全局排序 dueAt → createdAt → kind(ORDER<RENTAL) → id", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    const base = { campusId: "A", campus: { name: "甲校区" }, scopeKey: "CAMPUS:A" };
    const t1 = new Date("2026-09-21T00:00:00.000Z");
    const t2 = new Date("2026-09-22T00:00:00.000Z");
    installQueueDatasets(
      [
        disputeRow({ ...base, id: "r-new", dueAt: t2, createdAt: t1 }),
        disputeRow({ ...base, id: "r-tie", dueAt: t1, createdAt: t1 }),
      ],
      [
        orderDisputeRow({ ...base, id: "o-new", dueAt: t2, createdAt: t1 }),
        orderDisputeRow({ ...base, id: "o-tie", dueAt: t1, createdAt: t1 }),
      ],
    );

    const page = await loadAuthorizedDisputeQueue({ viewerId: "v1", access: CAMPUS_A_ACCESS, limit: 25 });

    // dueAt ASC → 相同时刻 ORDER < RENTAL（冻结 kind 全序）
    expect(page.items.map((i) => `${i.disputeKind}:${i.disputeId}`)).toEqual([
      "ORDER:o-tie",
      "RENTAL:r-tie",
      "ORDER:o-new",
      "RENTAL:r-new",
    ]);
  });

  it("GQ-04：mixed 翻页 nextCursor 携带 kind（decode 回读一致）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    const base = { campusId: "A", campus: { name: "甲校区" }, scopeKey: "CAMPUS:A" };
    const t = new Date("2026-09-21T00:00:00.000Z");
    installQueueDatasets(
      [disputeRow({ ...base, id: "r-1", dueAt: t, createdAt: t })],
      [orderDisputeRow({ ...base, id: "o-1", dueAt: t, createdAt: t })],
    );

    const page1 = await loadAuthorizedDisputeQueue({ viewerId: "v1", access: CAMPUS_A_ACCESS, limit: 1 });
    expect(page1.items.map((i) => i.disputeId)).toEqual(["o-1"]);
    expect(page1.nextCursor).toBeTruthy();

    const decoded = decodeDisputeCursor(page1.nextCursor!);
    expect(decoded).toEqual({
      dueAt: t,
      createdAt: t,
      kind: "ORDER",
      id: "o-1",
    });
  });

  it("GQ-05/§58：mixed 跨页不重复不遗漏（同刻 ORDER/RENTAL id A/B 对抗场景）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    const base = { campusId: "A", campus: { name: "甲校区" }, scopeKey: "CAMPUS:A", initiatorId: "i-1" };
    const t = new Date("2026-09-21T00:00:00.000Z");
    // 同 dueAt+createdAt 下 ORDER id A/B + RENTAL id A/B（§58 对抗场景）
    installQueueDatasets(
      [
        disputeRow({ ...base, id: "r-A", dueAt: t, createdAt: t }),
        disputeRow({ ...base, id: "r-B", dueAt: t, createdAt: t }),
      ],
      [
        orderDisputeRow({ ...base, id: "o-A", dueAt: t, createdAt: t }),
        orderDisputeRow({ ...base, id: "o-B", dueAt: t, createdAt: t }),
      ],
    );

    const seen: string[] = [];
    let cursor: ReturnType<typeof decodeDisputeCursor> = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await loadAuthorizedDisputeQueue({
        viewerId: "v1",
        access: CAMPUS_A_ACCESS,
        limit: 1,
        cursor: cursor ?? undefined,
      });
      for (const item of result.items) {
        seen.push(`${item.disputeKind}:${item.disputeId}`);
      }
      if (!result.nextCursor) break;
      cursor = decodeDisputeCursor(result.nextCursor!);
      expect(cursor).not.toBeNull();
    }

    // 无重复 / 无遗漏 / 无循环 / 全序稳定
    expect(seen).toEqual(["ORDER:o-A", "ORDER:o-B", "RENTAL:r-A", "RENTAL:r-B"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("§8 对抗：cursor=ORDER@(D,C) → 同刻 RENTAL 收录、(D, c<C) RENTAL 绝不重现", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    const D = new Date("2030-05-01T00:00:00.000Z");
    const C = new Date("2030-05-01T12:00:00.000Z");
    const base = { campusId: "A", campus: { name: "甲校区" }, scopeKey: "CAMPUS:A", initiatorId: "i-1" };
    installQueueDatasets(
      [
        // (D, C-1s)：位于 cursor 之前（createdAt 优先于 kind），翻页后绝不可重现
        disputeRow({ ...base, id: "r-before", dueAt: D, createdAt: new Date(C.getTime() - 1000) }),
        disputeRow({ ...base, id: "r-same", dueAt: D, createdAt: C }),
        disputeRow({ ...base, id: "r-after", dueAt: D, createdAt: new Date(C.getTime() + 1000) }),
      ],
      [orderDisputeRow({ ...base, id: "o-cursor", dueAt: D, createdAt: C })],
    );

    // global truth: r-before → o-cursor → r-same → r-after；从 cursor=o-cursor 翻页
    const seen: string[] = [];
    let cursor: ReturnType<typeof decodeDisputeCursor> = {
      dueAt: D,
      createdAt: C,
      kind: "ORDER",
      id: "o-cursor",
    };
    for (let i = 0; i < 5; i += 1) {
      const result = await loadAuthorizedDisputeQueue({
        viewerId: "v1",
        access: CAMPUS_A_ACCESS,
        limit: 1,
        cursor: cursor ?? undefined,
      });
      if (result.items.length === 0) break;
      seen.push(...result.items.map((item) => item.disputeId));
      if (!result.nextCursor) break;
      cursor = decodeDisputeCursor(result.nextCursor);
      expect(cursor).not.toBeNull();
    }

    expect(seen).toEqual(["r-same", "r-after"]);
    expect(seen).not.toContain("r-before");
  });

  it("§9 cross-kind 矩阵：kind 仅在 dueAt+createdAt 相等时参与排序", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    const D = new Date("2030-06-01T00:00:00.000Z");
    const C = new Date("2030-06-01T08:00:00.000Z");
    const base = { campusId: "A", campus: { name: "甲校区" }, scopeKey: "CAMPUS:A", initiatorId: "i-1" };

    const cases: Array<{
      cursorKind: "ORDER" | "RENTAL";
      probeKind: "ORDER" | "RENTAL";
      probeCreatedAt: Date;
      included: boolean;
      label: string;
    }> = [
      { cursorKind: "ORDER", probeKind: "RENTAL", probeCreatedAt: new Date(C.getTime() - 60_000), included: false, label: "RENTAL same dueAt + earlier createdAt" },
      { cursorKind: "ORDER", probeKind: "RENTAL", probeCreatedAt: C, included: true, label: "RENTAL same dueAt + same createdAt" },
      { cursorKind: "ORDER", probeKind: "RENTAL", probeCreatedAt: new Date(C.getTime() + 60_000), included: true, label: "RENTAL same dueAt + later createdAt" },
      { cursorKind: "RENTAL", probeKind: "ORDER", probeCreatedAt: new Date(C.getTime() - 60_000), included: false, label: "ORDER same dueAt + earlier createdAt" },
      { cursorKind: "RENTAL", probeKind: "ORDER", probeCreatedAt: C, included: false, label: "ORDER same dueAt + same createdAt" },
      { cursorKind: "RENTAL", probeKind: "ORDER", probeCreatedAt: new Date(C.getTime() + 60_000), included: true, label: "ORDER same dueAt + later createdAt" },
    ];

    for (const c of cases) {
      const rentalRows: Row[] = [];
      const orderRows: Row[] = [];
      const cursorRow = { ...base, id: "cur", dueAt: D, createdAt: C };
      const probeRow = { ...base, id: "probe", dueAt: D, createdAt: c.probeCreatedAt };
      if (c.cursorKind === "RENTAL") rentalRows.push(disputeRow(cursorRow));
      else orderRows.push(orderDisputeRow(cursorRow));
      if (c.probeKind === "RENTAL") rentalRows.push(disputeRow(probeRow));
      else orderRows.push(orderDisputeRow(probeRow));
      installQueueDatasets(rentalRows, orderRows);

      const result = await loadAuthorizedDisputeQueue({
        viewerId: "v1",
        access: CAMPUS_A_ACCESS,
        limit: 10,
        cursor: { dueAt: D, createdAt: C, kind: c.cursorKind, id: "cur" },
      });

      expect(result.items.map((i) => i.disputeId), c.label).toEqual(
        c.included ? ["probe"] : [],
      );
    }

    // same kind：exact timestamp tie 由 id > cursor.id 决定
    installQueueDatasets(
      [
        disputeRow({ ...base, id: "id-asc", dueAt: D, createdAt: C }),
        disputeRow({ ...base, id: "id-desc", dueAt: D, createdAt: C }),
      ],
      [],
    );
    const sameKind = await loadAuthorizedDisputeQueue({
      viewerId: "v1",
      access: CAMPUS_A_ACCESS,
      limit: 10,
      cursor: { dueAt: D, createdAt: C, kind: "RENTAL", id: "id-asc" },
    });
    expect(sameKind.items.map((i) => i.disputeId)).toEqual(["id-desc"]);
  });

  it("§10 multi-page：same dueAt / mixed createdAt·kind·id 全序独立校验", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    const D = new Date("2030-07-01T00:00:00.000Z");
    const at = (hour: number, minute: number) =>
      new Date(Date.UTC(2030, 6, 1, hour, minute));
    const base = { campusId: "A", campus: { name: "甲校区" }, scopeKey: "CAMPUS:A", initiatorId: "i-1" };

    // createdAt 优先于 kind——不人工把所有 ORDER 排在 RENTAL 前
    installQueueDatasets(
      [
        disputeRow({ ...base, id: "r1", dueAt: D, createdAt: at(10, 0) }),
        disputeRow({ ...base, id: "r2", dueAt: D, createdAt: at(10, 30) }),
        disputeRow({ ...base, id: "r3", dueAt: D, createdAt: at(11, 0) }),
      ],
      [
        orderDisputeRow({ ...base, id: "o1", dueAt: D, createdAt: at(10, 0) }),
        orderDisputeRow({ ...base, id: "o2", dueAt: D, createdAt: at(11, 0) }),
        orderDisputeRow({ ...base, id: "o3", dueAt: D, createdAt: at(12, 0) }),
      ],
    );

    // §12：测试自建 tuple comparator 独立排序（不复用生产 comparator）
    const KIND_RANK = { ORDER: 0, RENTAL: 1 } as const;
    const dataset = [
      { kind: "ORDER", id: "o1", createdAt: at(10, 0) },
      { kind: "RENTAL", id: "r1", createdAt: at(10, 0) },
      { kind: "RENTAL", id: "r2", createdAt: at(10, 30) },
      { kind: "ORDER", id: "o2", createdAt: at(11, 0) },
      { kind: "RENTAL", id: "r3", createdAt: at(11, 0) },
      { kind: "ORDER", id: "o3", createdAt: at(12, 0) },
    ];
    const expected = dataset
      .slice()
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          KIND_RANK[a.kind as keyof typeof KIND_RANK] -
            KIND_RANK[b.kind as keyof typeof KIND_RANK] ||
          (a.id < b.id ? -1 : 1),
      )
      .map((r) => `${r.kind}:${r.id}`);

    const seen: string[] = [];
    let cursor: ReturnType<typeof decodeDisputeCursor> = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await loadAuthorizedDisputeQueue({
        viewerId: "v1",
        access: CAMPUS_A_ACCESS,
        limit: 1,
        cursor: cursor ?? undefined,
      });
      seen.push(...result.items.map((i) => `${i.disputeKind}:${i.disputeId}`));
      if (!result.nextCursor) break;
      cursor = decodeDisputeCursor(result.nextCursor);
      expect(cursor).not.toBeNull();
    }

    expect(seen.length).toBe(dataset.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expected);
  });

  it("GQ-09：assignment=mine → 两表各自 DB WHERE 内执行", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    await loadAuthorizedDisputeQueue({
      viewerId: "viewer-1",
      access: CAMPUS_A_ACCESS,
      limit: 25,
      filters: { assignment: "mine" },
    });
    expect(disputeFindMany.mock.calls.at(-1)![0].where.AND).toContainEqual({ assignedToId: "viewer-1" });
    expect(orderDisputeFindMany.mock.calls.at(-1)![0].where.AND).toContainEqual({ assignedToId: "viewer-1" });
  });

  it("GQ-10：overdue → 两表均 active ∧ dueAt < now（DB 侧前置过滤）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    await loadAuthorizedDisputeQueue({
      viewerId: "v1",
      access: CAMPUS_A_ACCESS,
      limit: 25,
      filters: { overdueOnly: true },
    });
    const expected = { status: { in: ["OPEN", "IN_REVIEW"] }, dueAt: { lt: expect.any(Date) } };
    expect(disputeFindMany.mock.calls.at(-1)![0].where.AND).toContainEqual(expected);
    expect(orderDisputeFindMany.mock.calls.at(-1)![0].where.AND).toContainEqual(expected);
  });

  it("GQ-11：queue DTO 最小面——无 reason/evidence/adminNote（select 结构性排除，union 不削弱 7G）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    installQueueDatasets([disputeRow()], [orderDisputeRow()]);

    const page = await loadAuthorizedDisputeQueue({ viewerId: "v1", access: CAMPUS_A_ACCESS, limit: 25 });

    for (const item of page.items) {
      expect(Object.keys(item)).not.toContain("reason");
      expect(Object.keys(item)).not.toContain("evidencePhotos");
      expect(Object.keys(item)).not.toContain("adminNote");
    }
    for (const call of disputeFindMany.mock.calls) {
      expect(JSON.stringify(call[0].select)).not.toContain("reason");
      expect(JSON.stringify(call[0].select)).not.toContain("evidencePhotos");
      expect(JSON.stringify(call[0].select)).not.toContain("adminNote");
    }
    for (const call of orderDisputeFindMany.mock.calls) {
      expect(JSON.stringify(call[0].select)).not.toContain("reason");
      expect(JSON.stringify(call[0].select)).not.toContain("evidencePhotos");
      expect(JSON.stringify(call[0].select)).not.toContain("adminNote");
      // Order 安全摘要仅 orderNo + type（无 title / note）
      expect(JSON.stringify(call[0].select)).not.toContain("title");
    }
  });

  it("queue DTO：assigned 行 identity 缺失 fallback（两表同 fallback）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    installQueueDatasets(
      [disputeRow({ assignedToId: "reviewer-erased", initiatorId: "initiator-1" })],
      [orderDisputeRow({ assignedToId: "reviewer-erased", initiatorId: "initiator-1" })],
    );
    userFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in
        .filter((id: string) => id !== "reviewer-erased")
        .map((id: string) => ({ id, name: `用户-${id}`, deletedAt: null, erasedAt: null })),
    );

    const page = await loadAuthorizedDisputeQueue({
      viewerId: "viewer-1",
      access: CAMPUS_A_ACCESS,
      limit: 25,
    });

    expect(page.items[0]!.assignedReviewer).toBe("已注销用户");
    expect(page.items[0]!.initiatorName).toBe("用户-initiator-1");
    expect(page.items[1]!.assignedReviewer).toBe("已注销用户");
  });

  it("GQ-11b/§83：身份单次批量水合（两表 page 行合并一次 user.findMany）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    installQueueDatasets(
      [disputeRow({ id: "r-1", initiatorId: "i-1" })],
      [orderDisputeRow({ id: "o-1", initiatorId: "i-2" })],
    );

    await loadAuthorizedDisputeQueue({ viewerId: "v1", access: CAMPUS_A_ACCESS, limit: 25 });

    expect(userFindMany).toHaveBeenCalledTimes(1);
    expect(userFindMany.mock.calls[0][0].where.id.in.sort()).toEqual(["i-1", "i-2"]);
  });
});

describe("listDisputeQueueCampuses（由授权派生，绝不提供越权选项）", () => {
  it("GLOBAL → 全部 active；campus reviewer → 仅 scope 内 active", async () => {
    campusFindMany.mockResolvedValue([{ id: "A", name: "甲校区" }]);
    expect(await listDisputeQueueCampuses(GLOBAL_ACCESS)).toEqual([{ id: "A", name: "甲校区" }]);
    expect(campusFindMany.mock.calls.at(-1)![0].where).toEqual({ isActive: true });

    campusFindMany.mockResolvedValue([]);
    await listDisputeQueueCampuses(CAMPUS_A_ACCESS);
    expect(campusFindMany.mock.calls.at(-1)![0].where).toEqual({
      id: { in: ["A"] },
      isActive: true,
    });

    campusFindMany.mockClear();
    expect(await listDisputeQueueCampuses({ global: false, campusIds: [] })).toEqual([]);
    expect(campusFindMany).not.toHaveBeenCalled();
  });
});

describe("loadAuthorizedDisputeDetail RENTAL（两阶段读，授权失败零敏感载荷）", () => {
  const stageAAnchor = {
    id: "d1",
    campusId: "A",
    scopeKey: "CAMPUS:A",
    status: "OPEN",
    orderId: "o1",
  };

  it("missing → { ok:false }（Stage A 之后零 Stage B 调用）", async () => {
    disputeFindUnique.mockResolvedValueOnce(null);
    const result = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "d1",
      kind: "RENTAL",
    });
    expect(result).toEqual({ ok: false });
    expect(disputeFindUnique).toHaveBeenCalledTimes(1);
    expect(orderDisputeFindUnique).not.toHaveBeenCalled();
  });

  it("GD-04：ORDER dispute ID + kind=RENTAL → notFound 同形 { ok:false }（wrong-kind 无 fallback）", async () => {
    disputeFindUnique.mockResolvedValueOnce(null);
    const result = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      disputeId: "order-dispute-id",
      kind: "RENTAL",
    });
    expect(result).toEqual({ ok: false });
    expect(orderDisputeFindUnique).not.toHaveBeenCalled();
  });

  it("malformed scope / 越权 → { ok:false }，且 Stage B 未被触发", async () => {
    disputeFindUnique.mockResolvedValueOnce({ ...stageAAnchor, scopeKey: "CAMPUS:B" });
    const malformed = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "d1",
      kind: "RENTAL",
    });
    expect(malformed).toEqual({ ok: false });

    disputeFindUnique.mockResolvedValueOnce({ ...stageAAnchor, campusId: "B", scopeKey: "CAMPUS:B" });
    const crossCampus = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "d1",
      kind: "RENTAL",
    });
    expect(crossCampus).toEqual({ ok: false });
    expect(disputeFindUnique).toHaveBeenCalledTimes(2);
  });

  it("授权通过 → Stage B 敏感水合（reason/evidence/adminNote/身份/终局）", async () => {
    disputeFindUnique.mockResolvedValueOnce(stageAAnchor);
    disputeFindUnique.mockResolvedValueOnce(
      disputeRow({
        id: "d1",
        reason: "物品损坏争议全文",
        evidencePhotos: ["asset:a1", "asset:a2"],
        adminNote: "内部备注",
        assignedToId: "viewer-1",
        resolvedAt: null,
        resolvedById: null,
        openedFromOrderStatus: "IN_RENTAL",
        resolutionCode: null,
        resolutionAction: null,
        order: {
          id: "o1",
          orderNumber: "RO-1",
          ownerId: "owner-1",
          renterId: "renter-1",
          rentalListing: { title: "投影仪" },
        },
      }),
    );

    const result = await loadAuthorizedDisputeDetail({
      viewerId: "viewer-1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "d1",
      kind: "RENTAL",
    });

    expect(result).toMatchObject({ ok: true, kind: "RENTAL" });
    if (result.ok) {
      const detail = result.detail as typeof result.detail & {
        evidenceRefs: string[];
        adminNote: string;
        ownerName: string;
      };
      expect(result.detail.reason).toBe("物品损坏争议全文");
      expect(detail.evidenceRefs).toEqual(["asset:a1", "asset:a2"]);
      expect(detail.adminNote).toBe("内部备注");
      expect(result.detail.selfAssigned).toBe(true);
      expect(result.detail.scopeAuthorized).toBe(true);
      expect(result.detail.openedFromOrderStatus).toBe("IN_RENTAL");
      expect(detail.ownerName).toBe("用户-owner-1");
    }
  });

  it("Stage B 行消失（极端竞态）与兜底臂：campus 名缺失 / 未领用 / 零终局 / erased 身份 fallback", async () => {
    // Stage B 行消失 → ok:false
    disputeFindUnique.mockResolvedValueOnce(stageAAnchor);
    disputeFindUnique.mockResolvedValueOnce(null);
    const vanished = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      disputeId: "d1",
      kind: "RENTAL",
    });
    expect(vanished).toEqual({ ok: false });

    // 兜底臂：campus 行缺失、未领用、无终局、resolvedById 空、erased initiator
    disputeFindUnique.mockResolvedValueOnce({ ...stageAAnchor, id: "d2" });
    disputeFindUnique.mockResolvedValueOnce(
      disputeRow({
        id: "d2",
        campus: null,
        initiatorId: "initiator-erased",
        assignedToId: null,
        resolutionCode: null,
        resolutionAction: null,
        resolvedAt: null,
        resolvedById: null,
        openedFromOrderStatus: null,
        evidencePhotos: [],
        adminNote: null,
      }),
    );
    userFindMany.mockResolvedValue([]);
    const detail = await loadAuthorizedDisputeDetail({
      viewerId: "viewer-9",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "d2",
      kind: "RENTAL",
    });
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      const rental = detail.detail as typeof detail.detail & { canViewEvidence: boolean };
      expect(detail.detail.campusName).toBe("未知校区");
      expect(detail.detail.assignedReviewer).toBeNull();
      expect(detail.detail.selfAssigned).toBe(false);
      expect(detail.detail.resolution.resolvedAt).toBeNull();
      expect(detail.detail.resolution.resolvedByName).toBeNull();
      expect(detail.detail.initiatorName).toBe("已注销用户");
      expect(rental.canViewEvidence).toBe(false);
    }
  });

  it("detail：resolvedByName 有值 + assigned 有值臂（417/418 反向臂）", async () => {
    disputeFindUnique.mockResolvedValueOnce({ ...stageAAnchor, status: "RESOLVED" });
    disputeFindUnique.mockResolvedValueOnce(
      disputeRow({
        id: "d3",
        status: "RESOLVED",
        assignedToId: "assignee-1",
        resolutionCode: "MUTUAL_AGREEMENT",
        resolutionAction: "RESTORE_PREVIOUS",
        resolvedAt: new Date("2026-09-19T12:00:00.000Z"),
        resolvedById: "resolver-1",
      }),
    );
    const detail = await loadAuthorizedDisputeDetail({
      viewerId: "viewer-9",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "d3",
      kind: "RENTAL",
    });
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.detail.assignedReviewer!.displayName).toBe("用户-assignee-1");
      expect(detail.detail.selfAssigned).toBe(false);
      expect(detail.detail.resolution.resolvedByName).toBe("用户-resolver-1");
      expect(detail.detail.resolution.code).toBe("MUTUAL_AGREEMENT");
      expect(detail.detail.resolution.resolvedAt).toBe("2026-09-19T12:00:00.000Z");
    }
  });

  it("Stage A↔B 竞态（campus 快照不一致）→ { ok:false }（反 oracle）", async () => {
    disputeFindUnique.mockResolvedValueOnce(stageAAnchor);
    disputeFindUnique.mockResolvedValueOnce(
      disputeRow({ id: "d1", campusId: "B", scopeKey: "CAMPUS:B" }),
    );

    const result = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      disputeId: "d1",
      kind: "RENTAL",
    });
    expect(result).toEqual({ ok: false });
  });
});

describe("loadAuthorizedDisputeDetail ORDER（Phase 8C-02：两阶段读 + anti-oracle）", () => {
  const stageAAnchor = {
    id: "od-1",
    campusId: "A",
    scopeKey: "CAMPUS:A",
    status: "OPEN",
    orderId: "o1",
  };

  const stageBRow = {
    id: "od-1",
    status: "OPEN",
    campusId: "A",
    campus: { name: "甲校区" },
    scopeKey: "CAMPUS:A",
    initiatorId: "initiator-1",
    reason: "商品与描述不符全文",
    adminNote: null,
    createdAt: new Date("2026-09-19T00:00:00.000Z"),
    dueAt: new Date("2026-09-21T00:00:00.000Z"),
    assignedToId: null,
    resolutionCode: null,
    resolutionAction: null,
    resolvedAt: null,
    resolvedById: null,
    openedFromOrderStatus: "ACCEPTED",
    openedFromErrandStatus: null,
    order: { id: "o1", orderNo: "PO-1", type: "PRODUCT", buyerId: "buyer-1", sellerId: "seller-1" },
  };

  it("GD-01：authorized ORDER detail → Stage A 通过后 Stage B（participants/reason/snapshot）", async () => {
    orderDisputeFindUnique.mockResolvedValueOnce(stageAAnchor);
    orderDisputeFindUnique.mockResolvedValueOnce(stageBRow);

    const result = await loadAuthorizedDisputeDetail({
      viewerId: "viewer-1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "od-1",
      kind: "ORDER",
    });

    expect(result).toMatchObject({ ok: true, kind: "ORDER" });
    if (result.ok && result.kind === "ORDER") {
      expect(result.detail.reason).toBe("商品与描述不符全文");
      expect(result.detail.safeOrderLabel).toBe("订单 PO-1 · 二手商品");
      expect(result.detail.orderType).toBe("PRODUCT");
      expect(result.detail.participants).toEqual([
        { label: "买家", displayName: "用户-buyer-1" },
        { label: "卖家", displayName: "用户-seller-1" },
      ]);
      expect(result.detail.openedFromOrderStatus).toBe("ACCEPTED");
      expect(result.detail.openedFromErrandStatus).toBeNull();
      expect(result.detail.evidenceSupported).toBe(false);
      // Stage B select 绝不含 evidencePhotos（8C-02 不开放 token）
      const stageBSelect = orderDisputeFindUnique.mock.calls[1][0].select;
      expect(JSON.stringify(stageBSelect)).not.toContain("evidencePhotos");
    }
  });

  it("SERVICE / ERRAND participants label（预约方/服务者、发布者/接单者）", async () => {
    orderDisputeFindUnique.mockResolvedValueOnce(stageAAnchor);
    orderDisputeFindUnique.mockResolvedValueOnce({
      ...stageBRow,
      order: { id: "o1", orderNo: "PO-1", type: "SERVICE", buyerId: "buyer-1", sellerId: "seller-1" },
    });
    const service = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "od-1",
      kind: "ORDER",
    });
    expect(
      service.ok && service.kind === "ORDER" && service.detail.participants.map((p) => p.label),
    ).toEqual(["预约方", "服务者"]);

    orderDisputeFindUnique.mockResolvedValueOnce(stageAAnchor);
    orderDisputeFindUnique.mockResolvedValueOnce({
      ...stageBRow,
      openedFromErrandStatus: "PENDING_CONFIRMATION",
      order: { id: "o1", orderNo: "PO-1", type: "ERRAND", buyerId: "buyer-1", sellerId: "seller-1" },
    });
    const errand = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "od-1",
      kind: "ORDER",
    });
    expect(
      errand.ok && errand.kind === "ORDER" && errand.detail.participants.map((p) => p.label),
    ).toEqual(["发布者", "接单者"]);
    if (errand.ok && errand.kind === "ORDER") {
      expect(errand.detail.openedFromErrandStatus).toBe("PENDING_CONFIRMATION");
      expect(errand.detail.safeOrderLabel).toBe("订单 PO-1 · 跑腿任务");
    }
  });

  it("GD-02：unauthorized campus → { ok:false }，且 Stage A select 零敏感列 + 零 Stage B 查询（§82）", async () => {
    orderDisputeFindUnique.mockResolvedValueOnce({
      ...stageAAnchor,
      campusId: "B",
      scopeKey: "CAMPUS:B",
    });

    const result = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "od-1",
      kind: "ORDER",
    });

    expect(result).toEqual({ ok: false });
    expect(orderDisputeFindUnique).toHaveBeenCalledTimes(1);
    const stageASelect = orderDisputeFindUnique.mock.calls[0][0].select;
    expect(Object.keys(stageASelect).sort()).toEqual([
      "campusId",
      "id",
      "orderId",
      "scopeKey",
      "status",
    ]);
    expect(JSON.stringify(stageASelect)).not.toContain("reason");
    expect(JSON.stringify(stageASelect)).not.toContain("adminNote");
    expect(JSON.stringify(stageASelect)).not.toContain("evidencePhotos");
  });

  it("GD-03：malformed scope → { ok:false }，零 Stage B", async () => {
    orderDisputeFindUnique.mockResolvedValueOnce({
      ...stageAAnchor,
      scopeKey: "CAMPUS:B",
    });

    const result = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      disputeId: "od-1",
      kind: "ORDER",
    });

    expect(result).toEqual({ ok: false });
    expect(orderDisputeFindUnique).toHaveBeenCalledTimes(1);
  });

  it("GD-05：RENTAL dispute ID + kind=ORDER → { ok:false }（wrong-kind 无 fallback）", async () => {
    orderDisputeFindUnique.mockResolvedValueOnce(null);

    const result = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      disputeId: "rental-dispute-id",
      kind: "ORDER",
    });

    expect(result).toEqual({ ok: false });
    expect(disputeFindUnique).not.toHaveBeenCalled();
  });

  it("GD-06：erased/deleted identity → 统一 fallback displayName", async () => {
    orderDisputeFindUnique.mockResolvedValueOnce(stageAAnchor);
    orderDisputeFindUnique.mockResolvedValueOnce(stageBRow);
    userFindMany.mockResolvedValue([]);

    const result = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "od-1",
      kind: "ORDER",
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "ORDER") {
      expect(result.detail.initiatorName).toBe("已注销用户");
      expect(result.detail.participants.every((p) => p.displayName === "已注销用户")).toBe(true);
    }
  });

  it("missing → { ok:false }（零 rental 表调用；dispatch 不跨表）", async () => {
    orderDisputeFindUnique.mockResolvedValueOnce(null);
    const result = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "od-missing",
      kind: "ORDER",
    });
    expect(result).toEqual({ ok: false });
    expect(disputeFindUnique).not.toHaveBeenCalled();
  });

  it("§84：同 id 两类记录 → kind + id 唯一定位（无跨表 ID 全局唯一假设）", async () => {
    // 同一 id "dup-1" 在两表都存在；kind=ORDER → 只查 orderDispute
    orderDisputeFindUnique.mockResolvedValueOnce({ ...stageAAnchor, id: "dup-1" });
    orderDisputeFindUnique.mockResolvedValueOnce({ ...stageBRow, id: "dup-1" });

    const order = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "dup-1",
      kind: "ORDER",
    });
    expect(order).toMatchObject({ ok: true, kind: "ORDER" });
    expect(disputeFindUnique).not.toHaveBeenCalled();

    // 同 id，kind=RENTAL → 只查 rentalDispute
    disputeFindUnique.mockResolvedValueOnce({ ...stageAAnchor, id: "dup-1" });
    disputeFindUnique.mockResolvedValueOnce(
      disputeRow({
        id: "dup-1",
        order: { id: "o1", orderNumber: "RO-1", ownerId: "owner-1", renterId: "renter-1", rentalListing: { title: "投影仪" } },
      }),
    );
    const rental = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "dup-1",
      kind: "RENTAL",
    });
    expect(rental).toMatchObject({ ok: true, kind: "RENTAL" });
    expect(orderDisputeFindUnique).toHaveBeenCalledTimes(2);
  });
});
