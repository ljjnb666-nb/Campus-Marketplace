import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  campusFindMany,
  ticketFindMany,
  ticketFindUnique,
  userFindMany,
} = vi.hoisted(() => ({
  campusFindMany: vi.fn(),
  ticketFindMany: vi.fn(),
  ticketFindUnique: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campus: { findMany: campusFindMany },
    supportTicket: { findMany: ticketFindMany, findUnique: ticketFindUnique },
    user: { findMany: userFindMany },
  },
}));

import {
  decodeSupportCursor,
  encodeSupportCursor,
  listSupportQueueCampuses,
  loadAuthorizedSupportDetail,
  loadAuthorizedSupportQueue,
  type SupportQueueFilters,
} from "@/lib/support/support-query";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7G：support 队列/详情读模型合同（DB 内授权；UNSCOPED 仅 GLOBAL；
 * queue DTO 无 description/internalNote/email）。
 */

const GLOBAL_ACCESS = { global: true, campusIds: [] as string[] };
const CAMPUS_A_ACCESS = { global: false, campusIds: ["A"] };

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    status: "OPEN",
    category: "ACCOUNT",
    campusId: null,
    campus: null,
    scopeKey: "UNSCOPED",
    requesterId: "requester-1",
    subject: "无法登录",
    dueAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    createdAt: new Date("2026-09-19T00:00:00.000Z"),
    assignedToId: null,
    ...overrides,
  };
}

function authCtx(): AuthorizationContext {
  return { userId: "agent-1", accountActive: true, activeCampusIds: ["A"], grants: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  userFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id: string) => ({ id, name: `用户-${id}`, deletedAt: null, erasedAt: null })),
  );
});

describe("support cursor（FR03 canonical 纪律）", () => {
  it("encode → decode 往返；非 canonical → null", () => {
    const cursor = {
      dueAt: new Date("2026-09-22T00:00:00.000Z"),
      createdAt: new Date("2026-09-19T00:00:00.000Z"),
      id: "t1",
    };
    const raw = encodeSupportCursor(cursor);
    expect(decodeSupportCursor(raw)).toEqual(cursor);
    expect(decodeSupportCursor("!!!")).toBeNull();
    const wrongKeys = Buffer.from(JSON.stringify({ dueAt: "x", id: "y" })).toString("base64url");
    expect(decodeSupportCursor(wrongKeys)).toBeNull();
  });
});

describe("loadAuthorizedSupportQueue", () => {
  it("fail-closed：零 scope 永远空页；GLOBAL 分支含 UNSCOPED + 全校区 exact-pair", async () => {
    expect(
      await loadAuthorizedSupportQueue({
        viewerId: "v1",
        access: { global: false, campusIds: [] },
        limit: 25,
      }),
    ).toEqual({ items: [], nextCursor: null });
    expect(ticketFindMany).not.toHaveBeenCalled();

    campusFindMany.mockResolvedValue([{ id: "A" }]);
    ticketFindMany.mockResolvedValue([]);
    await loadAuthorizedSupportQueue({ viewerId: "v1", access: GLOBAL_ACCESS, limit: 25 });

    expect(ticketFindMany.mock.calls.at(-1)![0].where.AND[0].OR).toEqual([
      { campusId: null, scopeKey: "UNSCOPED" },
      { campusId: "A", scopeKey: "CAMPUS:A" },
    ]);
  });

  it("campus agent 分支仅 exact-pair；UNSCOPED 行不可见", async () => {
    ticketFindMany.mockResolvedValue([]);
    await loadAuthorizedSupportQueue({ viewerId: "v1", access: CAMPUS_A_ACCESS, limit: 25 });

    expect(ticketFindMany.mock.calls.at(-1)![0].where.AND[0].OR).toEqual([
      { campusId: "A", scopeKey: "CAMPUS:A" },
    ]);
  });

  it("DTO 最小面（无 description/internalNote）+ 身份安全水合 + 下一页", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    ticketFindMany.mockResolvedValue([
      ticketRow(),
      ticketRow({ id: "t2", assignedToId: "agent-9", status: "IN_PROGRESS" }),
      ticketRow({ id: "t3" }),
    ]);

    const page = await loadAuthorizedSupportQueue({
      viewerId: "v1",
      access: GLOBAL_ACCESS,
      limit: 2,
    });

    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      ticketId: "t1",
      requesterName: "用户-requester-1",
      campusName: null,
      overdue: false,
    });
    expect(page.items[1]!.assignedAgent).toBe("用户-agent-9");
    expect(page.nextCursor).toBeTruthy();
    const select = JSON.stringify(ticketFindMany.mock.calls.at(-1)![0].select);
    expect(select).not.toContain("description");
    expect(select).not.toContain("internalNote");
  });
});

describe("loadAuthorizedSupportDetail（两阶段读）", () => {
  it("missing / 越权 → { ok:false } 且零 Stage B", async () => {
    ticketFindUnique.mockResolvedValueOnce(null);
    const missing = await loadAuthorizedSupportDetail({
      viewerId: "v1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      ticketId: "t1",
    });
    expect(missing).toEqual({ ok: false });

    ticketFindUnique.mockResolvedValueOnce(ticketRow());
    const denied = await loadAuthorizedSupportDetail({
      viewerId: "v1",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      ticketId: "t1",
    });
    expect(denied).toEqual({ ok: false });
    expect(ticketFindUnique).toHaveBeenCalledTimes(2);
  });

  it("Stage B 行消失（极端竞态）与兜底臂：campus null / 未领用 / erased requester", async () => {
    ticketFindUnique.mockResolvedValueOnce(ticketRow());
    ticketFindUnique.mockResolvedValueOnce(null);
    const vanished = await loadAuthorizedSupportDetail({
      viewerId: "v1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      ticketId: "t1",
    });
    expect(vanished).toEqual({ ok: false });

    ticketFindUnique.mockResolvedValueOnce(
      ticketRow({ campusId: "A", scopeKey: "CAMPUS:A", status: "IN_PROGRESS" }),
    );
    ticketFindUnique.mockResolvedValueOnce(
      ticketRow({
        campusId: "A",
        scopeKey: "CAMPUS:A",
        campus: null,
        status: "IN_PROGRESS",
        assignedToId: null,
        requesterId: "requester-erased",
        internalNote: null,
        resolvedAt: null,
        resolvedById: null,
      }),
    );
    userFindMany.mockResolvedValue([]);
    const detail = await loadAuthorizedSupportDetail({
      viewerId: "viewer-9",
      context: authCtx(),
      access: CAMPUS_A_ACCESS,
      ticketId: "t1",
    });
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.detail.campusName).toBeNull();
      expect(detail.detail.assignedAgent).toBeNull();
      expect(detail.detail.requesterName).toBe("已注销用户");
      expect(detail.detail.resolution.resolvedAt).toBeNull();
    }
  });

  it("授权通过 → Stage B（description/internalNote/requester 身份）", async () => {
    ticketFindUnique.mockResolvedValueOnce(ticketRow());
    ticketFindUnique.mockResolvedValueOnce(
      ticketRow({
        description: "登录一直失败全文",
        internalNote: "仅操作员",
        resolvedAt: null,
        resolvedById: null,
      }),
    );

    const result = await loadAuthorizedSupportDetail({
      viewerId: "agent-1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      ticketId: "t1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detail.description).toBe("登录一直失败全文");
      expect(result.detail.internalNote).toBe("仅操作员");
      expect(result.detail.scopeAuthorized).toBe(true);
      expect(result.detail.selfAssigned).toBe(false);
    }
  });

  it("Stage A↔B 竞态（scope 快照不一致）→ { ok:false }（反 oracle）", async () => {
    ticketFindUnique.mockResolvedValueOnce(ticketRow());
    ticketFindUnique.mockResolvedValueOnce(
      ticketRow({ campusId: "A", scopeKey: "CAMPUS:A" }),
    );

    const result = await loadAuthorizedSupportDetail({
      viewerId: "v1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      ticketId: "t1",
    });
    expect(result).toEqual({ ok: false });
  });

  it("终局工单详情 → resolution 水合 + selfAssigned 命中", async () => {
    ticketFindUnique.mockResolvedValueOnce(
      ticketRow({ status: "RESOLVED", assignedToId: "agent-1" }),
    );
    ticketFindUnique.mockResolvedValueOnce(
      ticketRow({
        status: "RESOLVED",
        assignedToId: "agent-1",
        resolutionCode: "ANSWERED",
        resolutionMessage: "已答复",
        resolvedAt: new Date("2026-09-19T12:00:00.000Z"),
        resolvedById: "agent-1",
      }),
    );

    const result = await loadAuthorizedSupportDetail({
      viewerId: "agent-1",
      context: authCtx(),
      access: GLOBAL_ACCESS,
      ticketId: "t1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detail.selfAssigned).toBe(true);
      expect(result.detail.resolution.code).toBe("ANSWERED");
      expect(result.detail.resolution.message).toBe("已答复");
      expect(result.detail.resolution.resolvedByName).toBe("用户-agent-1");
      expect(result.detail.overdue).toBe(false);
    }
  });
});

describe("listSupportQueueCampuses（由授权派生，绝不提供越权选项）", () => {
  it("GLOBAL → 全部 active；campus agent → 仅 scope 内 active；零 scope → 空 + 零查询", async () => {
    campusFindMany.mockResolvedValue([{ id: "A", name: "甲校区" }]);
    expect(await listSupportQueueCampuses(GLOBAL_ACCESS)).toEqual([{ id: "A", name: "甲校区" }]);
    expect(campusFindMany.mock.calls.at(-1)![0].where).toEqual({ isActive: true });

    campusFindMany.mockResolvedValue([]);
    await listSupportQueueCampuses(CAMPUS_A_ACCESS);
    expect(campusFindMany.mock.calls.at(-1)![0].where).toEqual({
      id: { in: ["A"] },
      isActive: true,
    });

    campusFindMany.mockClear();
    expect(await listSupportQueueCampuses({ global: false, campusIds: [] })).toEqual([]);
    expect(campusFindMany).not.toHaveBeenCalled();
  });
});

describe("loadAuthorizedSupportQueue filter 组合（恒 AND 在 scope 之内）", () => {
  it("campus/status/assignment/overdue/cursor 全部生效", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }, { id: "B" }]);
    ticketFindMany.mockResolvedValue([]);

    const filters: SupportQueueFilters = {
      campusId: "A",
      status: "IN_PROGRESS",
      assignment: "unassigned",
      overdueOnly: true,
    };
    await loadAuthorizedSupportQueue({
      viewerId: "viewer-1",
      access: GLOBAL_ACCESS,
      limit: 25,
      filters,
      cursor: {
        dueAt: new Date("2026-09-22T00:00:00.000Z"),
        createdAt: new Date("2026-09-19T00:00:00.000Z"),
        id: "t0",
      },
    });

    expect(ticketFindMany.mock.calls.at(-1)![0].where.AND).toEqual([
      expect.anything(),
      { campusId: "A", scopeKey: "CAMPUS:A" },
      { status: "IN_PROGRESS" },
      { assignedToId: null },
      { status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: expect.any(Date) } },
      {
        OR: [
          { dueAt: { gt: new Date("2026-09-22T00:00:00.000Z") } },
          {
            dueAt: { equals: new Date("2026-09-22T00:00:00.000Z") },
            createdAt: { gt: new Date("2026-09-19T00:00:00.000Z") },
          },
          {
            dueAt: { equals: new Date("2026-09-22T00:00:00.000Z") },
            createdAt: { equals: new Date("2026-09-19T00:00:00.000Z") },
            id: { gt: "t0" },
          },
        ],
      },
    ]);
  });

  it("assignment=mine 以 viewerId 过滤", async () => {
    ticketFindMany.mockResolvedValue([]);
    await loadAuthorizedSupportQueue({
      viewerId: "me-1",
      access: GLOBAL_ACCESS,
      limit: 25,
      filters: { assignment: "mine" },
    });
    expect(ticketFindMany.mock.calls.at(-1)![0].where.AND[1]).toEqual({
      assignedToId: "me-1",
    });
  });

  it("campus row 缺失名 → campusName null；CAMPUS 工单行渲染校区名", async () => {
    campusFindMany.mockResolvedValue([{ id: "A" }]);
    ticketFindMany.mockResolvedValue([
      ticketRow({ campusId: "A", campus: { name: "甲校区" }, status: "IN_PROGRESS" }),
    ]);

    const page = await loadAuthorizedSupportQueue({
      viewerId: "v1",
      access: CAMPUS_A_ACCESS,
      limit: 25,
    });
    expect(page.items[0]!.campusName).toBe("甲校区");
    expect(page.items[0]!.status).toBe("IN_PROGRESS");
  });
});
