import { beforeEach, describe, expect, it, vi } from "vitest";

const { campusFindMany, disputeFindMany, disputeFindUnique, userFindMany } = vi.hoisted(() => ({
  campusFindMany: vi.fn(),
  disputeFindMany: vi.fn(),
  disputeFindUnique: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campus: { findMany: campusFindMany },
    rentalDispute: { findMany: disputeFindMany, findUnique: disputeFindUnique },
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
 * WHERE/形状合同（真实 PG 行为在 tests/integration/phase7g 覆盖）。
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

function authCtx(): AuthorizationContext {
  return { userId: "viewer-1", accountActive: true, activeCampusIds: ["A"], grants: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  userFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id: string) => ({ id, name: `用户-${id}`, deletedAt: null, erasedAt: null })),
  );
});

describe("dispute cursor（FR03 canonical 纪律）", () => {
  it("encode → decode 往返相等", () => {
    const cursor = {
      dueAt: new Date("2026-09-21T00:00:00.000Z"),
      createdAt: new Date("2026-09-19T00:00:00.000Z"),
      id: "dispute-1",
    };
    const raw = encodeDisputeCursor(cursor);
    expect(decodeDisputeCursor(raw)).toEqual(cursor);
  });

  it("非 canonical 输入一律 null（raw 白名单/键集/ISO/re-encode）", () => {
    const cursor = {
      dueAt: new Date("2026-09-21T00:00:00.000Z"),
      createdAt: new Date("2026-09-19T00:00:00.000Z"),
      id: "dispute-1",
    };
    const raw = encodeDisputeCursor(cursor);
    // 标准 base64 字符（+ / =）不在 raw 白名单
    expect(decodeDisputeCursor(raw.replace(/-/g, "+").replace(/_/g, "/") + "=")).toBeNull();
    // 非 canonical ISO（毫秒缺失）
    const nonCanonical = Buffer.from(
      JSON.stringify({ dueAt: "2026-09-21T00:00:00Z", createdAt: cursor.createdAt.toISOString(), id: "d" }),
    ).toString("base64url");
    expect(decodeDisputeCursor(nonCanonical)).toBeNull();
    // 键集不 exact（多字段）
    const extraKeys = Buffer.from(
      JSON.stringify({
        dueAt: cursor.dueAt.toISOString(),
        createdAt: cursor.createdAt.toISOString(),
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
        id: "",
      }),
    ).toString("base64url");
    expect(decodeDisputeCursor(emptyId)).toBeNull();
    // 结构破坏
    expect(decodeDisputeCursor("not-base64url!")).toBeNull();
  });
});

describe("loadAuthorizedDisputeQueue（DB 内授权 + filter 收敛）", () => {
  it("fail-closed：零有效 scope 永远空页（零 DB 调用）", async () => {
    const page = await loadAuthorizedDisputeQueue({
      viewerId: "v1",
      access: { global: false, campusIds: [] },
      limit: 25,
    });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(disputeFindMany).not.toHaveBeenCalled();
  });

  it("GLOBAL → 全 Campus exact-pair 分支枚举；campus reviewer → 仅其校区", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }, { id: "B" }]);
    disputeFindMany.mockResolvedValue([]);
    await loadAuthorizedDisputeQueue({ viewerId: "v1", access: GLOBAL_ACCESS, limit: 25 });

    const globalCall = disputeFindMany.mock.calls.at(-1)![0];
    expect(globalCall.where.AND[0].OR).toEqual([
      { campusId: "A", scopeKey: "CAMPUS:A" },
      { campusId: "B", scopeKey: "CAMPUS:B" },
    ]);
    expect(globalCall.orderBy).toEqual([
      { dueAt: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ]);
    expect(globalCall.take).toBe(26);

    disputeFindMany.mockClear();
    disputeFindMany.mockResolvedValue([]);
    await loadAuthorizedDisputeQueue({ viewerId: "v1", access: CAMPUS_A_ACCESS, limit: 25 });
    const campusCall = disputeFindMany.mock.calls.at(-1)![0];
    expect(campusCall.where.AND[0].OR).toEqual([{ campusId: "A", scopeKey: "CAMPUS:A" }]);
  });

  it("filter 恒 AND 在 scope 之内（campus/status/assignment/overdue/cursor）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }, { id: "B" }]);
    disputeFindMany.mockResolvedValue([]);

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
        id: "d0",
      },
    });

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
  });

  it("queue DTO：assigned 行 identity 缺失 fallback（230/232 臂）", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    disputeFindMany.mockResolvedValue([
      disputeRow({ assignedToId: "reviewer-erased", initiatorId: "initiator-1" }),
    ]);
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
  });

  it("queue DTO 最小面：无 reason/evidence/adminNote；身份批量安全水合；hasMore → nextCursor", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    disputeFindMany.mockResolvedValue([
      disputeRow(),
      disputeRow({
        id: "dispute-2",
        assignedToId: "reviewer-9",
        initiatorId: "initiator-erased",
      }),
      disputeRow({ id: "dispute-3" }),
    ]);
    userFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id: string) =>
        id === "initiator-erased"
          ? { id, name: "x", deletedAt: new Date(), erasedAt: null }
          : { id, name: `用户-${id}`, deletedAt: null, erasedAt: null },
      ),
    );

    const page = await loadAuthorizedDisputeQueue({
      viewerId: "viewer-1",
      access: GLOBAL_ACCESS,
      limit: 2,
    });

    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      disputeId: "dispute-1",
      campusName: "甲校区",
      safeOrderLabel: "订单 RO-1 · 投影仪",
      initiatorName: "用户-initiator-1",
      assignedReviewer: null,
      overdue: false,
    });
    // 领用人/发起人统一 fallback（deleted → 已注销用户，互不可区分）
    expect(page.items[1]!.initiatorName).toBe("已注销用户");
    expect(page.items[1]!.assignedReviewer).toBe("用户-reviewer-9");
    expect(page.nextCursor).toBeTruthy();
    // 队列 select 结构性不含敏感字段
    const select = disputeFindMany.mock.calls.at(-1)![0].select;
    expect(JSON.stringify(select)).not.toContain("reason");
    expect(JSON.stringify(select)).not.toContain("evidencePhotos");
    expect(JSON.stringify(select)).not.toContain("adminNote");
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

describe("loadAuthorizedDisputeDetail（两阶段读，授权失败零敏感载荷）", () => {
  it("missing → { ok:false }（Stage A 之后零 Stage B 调用）", async () => {
    disputeFindUnique.mockResolvedValueOnce(null);
    const result = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "d1",
    });
    expect(result).toEqual({ ok: false });
    expect(disputeFindUnique).toHaveBeenCalledTimes(1);
  });

  it("malformed scope / 越权 → { ok:false }，且 Stage B 未被触发", async () => {
    disputeFindUnique.mockResolvedValueOnce({
      id: "d1",
      campusId: "A",
      scopeKey: "CAMPUS:B",
      status: "OPEN",
      orderId: "o1",
    });
    const malformed = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "d1",
    });
    expect(malformed).toEqual({ ok: false });

    disputeFindUnique.mockResolvedValueOnce({
      id: "d1",
      campusId: "B",
      scopeKey: "CAMPUS:B",
      status: "OPEN",
      orderId: "o1",
    });
    const crossCampus = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      disputeId: "d1",
    });
    expect(crossCampus).toEqual({ ok: false });
    expect(disputeFindUnique).toHaveBeenCalledTimes(2);
  });

  it("授权通过 → Stage B 敏感水合（reason/evidence/adminNote/身份/终局）", async () => {
    disputeFindUnique.mockResolvedValueOnce({
      id: "d1",
      campusId: "A",
      scopeKey: "CAMPUS:A",
      status: "OPEN",
      orderId: "o1",
    });
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
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detail.reason).toBe("物品损坏争议全文");
      expect(result.detail.evidenceRefs).toEqual(["asset:a1", "asset:a2"]);
      expect(result.detail.adminNote).toBe("内部备注");
      expect(result.detail.selfAssigned).toBe(true);
      expect(result.detail.scopeAuthorized).toBe(true);
      expect(result.detail.openedFromOrderStatus).toBe("IN_RENTAL");
      expect(result.detail.ownerName).toBe("用户-owner-1");
    }
  });

  it("Stage B 行消失（极端竞态）与兜底臂：campus 名缺失 / 未领用 / 零终局 / erased 身份 fallback", async () => {
    // Stage B 行消失 → ok:false
    disputeFindUnique.mockResolvedValueOnce({
      id: "d1",
      campusId: "A",
      scopeKey: "CAMPUS:A",
      status: "OPEN",
      orderId: "o1",
    });
    disputeFindUnique.mockResolvedValueOnce(null);
    const vanished = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      disputeId: "d1",
    });
    expect(vanished).toEqual({ ok: false });

    // 兜底臂：campus 行缺失、未领用、无终局、resolvedById 空、erased initiator
    disputeFindUnique.mockResolvedValueOnce({
      id: "d2",
      campusId: "A",
      scopeKey: "CAMPUS:A",
      status: "OPEN",
      orderId: "o1",
    });
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
    });
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.detail.campusName).toBe("未知校区");
      expect(detail.detail.assignedReviewer).toBeNull();
      expect(detail.detail.selfAssigned).toBe(false);
      expect(detail.detail.resolution.resolvedAt).toBeNull();
      expect(detail.detail.resolution.resolvedByName).toBeNull();
      expect(detail.detail.initiatorName).toBe("已注销用户");
      expect(detail.detail.canViewEvidence).toBe(false);
    }
  });

  it("detail：resolvedByName 有值 + assigned 有值臂（417/418 反向臂）", async () => {
    disputeFindUnique.mockResolvedValueOnce({
      id: "d3",
      campusId: "A",
      scopeKey: "CAMPUS:A",
      status: "RESOLVED",
      orderId: "o1",
    });
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
    disputeFindUnique.mockResolvedValueOnce({
      id: "d1",
      campusId: "A",
      scopeKey: "CAMPUS:A",
      status: "OPEN",
      orderId: "o1",
    });
    disputeFindUnique.mockResolvedValueOnce(
      disputeRow({ id: "d1", campusId: "B", scopeKey: "CAMPUS:B" }),
    );

    const result = await loadAuthorizedDisputeDetail({
      viewerId: "v1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      disputeId: "d1",
    });
    expect(result).toEqual({ ok: false });
  });
});
