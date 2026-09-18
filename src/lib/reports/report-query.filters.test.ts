import { beforeEach, describe, expect, it, vi } from "vitest";

const { campusFindMany, caseFindMany, userFindMany } = vi.hoisted(() => ({
  campusFindMany: vi.fn(),
  caseFindMany: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campus: { findMany: campusFindMany },
    moderationCase: { findMany: caseFindMany },
    report: { findUnique: vi.fn() },
    user: { findMany: userFindMany },
  },
}));

import {
  decodeReportCursor,
  encodeReportCursor,
  listReportQueueCampuses,
  loadAuthorizedReportQueue,
  type ReportQueueFilters,
} from "@/lib/reports/report-query";

/**
 * Phase 7E：queue 授权谓词/过滤组合的 WHERE 形状合同（DB 内授权；
 * 真实 PG 行为由 tests/integration/phase7e 覆盖，此处锁定谓词构造）。
 */

const GLOBAL_ACCESS = { global: true, campusIds: [] as string[] };
const CAMPUS_A_ACCESS = { global: false, campusIds: ["A"] };

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-1",
    campusId: "A",
    scopeKey: "CAMPUS:A",
    // 远期 dueAt：夹具不得随墙钟越过 SLA 而翻转 overdue
    dueAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    closedAt: null,
    assignedToId: null,
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
    report: {
      id: "report-1",
      reason: "SCAM_RISK",
      status: "OPEN",
      targetType: "RENTAL_LISTING",
      createdAt: new Date("2026-09-16T00:00:00.000Z"),
      campusId: "A",
      campus: { name: "校区A" },
      product: null,
      errandTask: null,
      serviceListing: null,
      rentalListing: { title: "租赁物" },
      targetUserId: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  campusFindMany.mockResolvedValue([{ id: "A", name: "校区A" }]);
  caseFindMany.mockResolvedValue([]);
  userFindMany.mockResolvedValue([]);
});

describe("loadAuthorizedReportQueue（授权谓词 + filter AND 形状）", () => {
  it("GLOBAL：分支 = UNSCOPED + 权威 Campus 全表 exact pair；take=limit+1", async () => {
    caseFindMany.mockResolvedValue([caseRow()]);
    const page = await loadAuthorizedReportQueue({
      viewerId: "v1",
      access: GLOBAL_ACCESS,
      limit: 25,
    });

    const where = caseFindMany.mock.calls[0][0].where;
    expect(where.AND[0].OR).toEqual([
      { campusId: null, scopeKey: "UNSCOPED" },
      { campusId: "A", scopeKey: "CAMPUS:A" },
    ]);
    expect(caseFindMany.mock.calls[0][0].take).toBe(26);
    expect(caseFindMany.mock.calls[0][0].orderBy).toEqual([
      { dueAt: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ]);
    expect(page.items[0]).toMatchObject({
      reportId: "report-1",
      caseId: "case-1",
      safeTargetLabel: "租赁：租赁物",
      scopeLabel: "校区：校区A",
      overdue: false,
    });
  });

  it("campus reviewer：分支 = 仅其有效校区 exact pair（无 UNSCOPED）", async () => {
    await loadAuthorizedReportQueue({ viewerId: "v1", access: CAMPUS_A_ACCESS, limit: 25 });

    const where = caseFindMany.mock.calls[0][0].where;
    expect(where.AND[0].OR).toEqual([{ campusId: "A", scopeKey: "CAMPUS:A" }]);
  });

  it("零有效 scope → 永远空页（fail closed，不查询）", async () => {
    const page = await loadAuthorizedReportQueue({
      viewerId: "v1",
      access: { global: false, campusIds: [] },
      limit: 25,
    });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(caseFindMany).not.toHaveBeenCalled();
  });

  it("全部 filter 恒 AND 在 scope 谓词之内", async () => {
    const filters: ReportQueueFilters = {
      campusId: "A",
      status: "OPEN",
      targetType: "PRODUCT",
      reason: "FAKE_INFO",
      assignment: "unassigned",
      overdueOnly: true,
    };
    await loadAuthorizedReportQueue({ viewerId: "v1", access: GLOBAL_ACCESS, limit: 25, filters });

    const where = caseFindMany.mock.calls[0][0].where;
    expect(where.AND[0].OR).toEqual([
      { campusId: null, scopeKey: "UNSCOPED" },
      { campusId: "A", scopeKey: "CAMPUS:A" },
    ]);
    expect(where.AND).toContainEqual({
      campusId: "A",
      scopeKey: "CAMPUS:A",
    });
    expect(where.AND).toContainEqual({ report: { status: "OPEN" } });
    expect(where.AND).toContainEqual({ report: { targetType: "PRODUCT" } });
    expect(where.AND).toContainEqual({ report: { reason: "FAKE_INFO" } });
    expect(where.AND).toContainEqual({ assignedToId: null });
    expect(where.AND).toContainEqual({ closedAt: null, dueAt: { lt: expect.any(Date) } });
  });

  it("assignment=mine 绑定 viewerId", async () => {
    await loadAuthorizedReportQueue({
      viewerId: "v1",
      access: GLOBAL_ACCESS,
      limit: 25,
      filters: { assignment: "mine" },
    });
    expect(caseFindMany.mock.calls[0][0].where.AND).toContainEqual({ assignedToId: "v1" });
  });

  it("cursor 进入 keyset 条件（全 tuple ASC tie-break）", async () => {
    const cursor = decodeReportCursor(
      encodeReportCursor({
        dueAt: new Date("2026-09-18T00:00:00.000Z"),
        createdAt: new Date("2026-09-16T00:00:00.000Z"),
        id: "case-0",
      }),
    )!;
    await loadAuthorizedReportQueue({ viewerId: "v1", access: GLOBAL_ACCESS, limit: 25, cursor });

    const where = caseFindMany.mock.calls[0][0].where;
    expect(where.AND[where.AND.length - 1].OR).toEqual([
      { dueAt: { gt: cursor.dueAt } },
      { dueAt: { equals: cursor.dueAt }, createdAt: { gt: cursor.createdAt } },
      {
        dueAt: { equals: cursor.dueAt },
        createdAt: { equals: cursor.createdAt },
        id: { gt: cursor.id },
      },
    ]);
  });

  it("hasMore → nextCursor 由最后一行生成", async () => {
    caseFindMany.mockResolvedValue([
      caseRow({ id: "case-1" }),
      caseRow({ id: "case-2" }),
    ]);
    const page = await loadAuthorizedReportQueue({ viewerId: "v1", access: GLOBAL_ACCESS, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });

  it("L04：UNSCOPED 队列行 scopeLabel = 无校区归属记录（与 detail 同一 reportScopeLabel 语义）", async () => {
    caseFindMany.mockResolvedValue([
      caseRow(),
      caseRow({
        id: "case-u",
        campusId: null,
        scopeKey: "UNSCOPED",
        report: {
          id: "report-u",
          reason: "HARASSMENT",
          status: "OPEN",
          targetType: "MESSAGE",
          createdAt: new Date("2026-09-16T00:00:00.000Z"),
          campusId: null,
          campus: null,
          product: null,
          errandTask: null,
          serviceListing: null,
          rentalListing: null,
          targetUserId: "target-1",
        },
      }),
    ]);
    const page = await loadAuthorizedReportQueue({ viewerId: "v1", access: GLOBAL_ACCESS, limit: 25 });

    expect(page.items.find((i) => i.reportId === "report-1")!.scopeLabel).toBe("校区：校区A");
    const unscoped = page.items.find((i) => i.reportId === "report-u")!;
    expect(unscoped.scopeLabel).toBe("无校区归属记录");
    // L05：queue 全量 DTO 不出现 平台级/全局/GLOBAL 文案
    expect(JSON.stringify(page.items)).not.toContain("平台级");
    expect(JSON.stringify(page.items)).not.toContain("全局");
    expect(JSON.stringify(page.items)).not.toContain("GLOBAL");
  });

  it("DTO 最小化：message 内容 / handledNote / detail 结构性不在 select", async () => {
    caseFindMany.mockResolvedValue([caseRow()]);
    await loadAuthorizedReportQueue({ viewerId: "v1", access: GLOBAL_ACCESS, limit: 25 });

    const selectReport = caseFindMany.mock.calls[0][0].select.report.select;
    expect(selectReport).not.toHaveProperty("detail");
    expect(selectReport).not.toHaveProperty("handledNote");
    expect(selectReport).not.toHaveProperty("message");
    expect(selectReport).not.toHaveProperty("messageId");
  });
});

describe("listReportQueueCampuses（选项由授权派生）", () => {
  it("GLOBAL → 全部 active 校区", async () => {
    await listReportQueueCampuses(GLOBAL_ACCESS);
    expect(campusFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });

  it("campus reviewer → 仅其有效 scope 校区", async () => {
    await listReportQueueCampuses(CAMPUS_A_ACCESS);
    expect(campusFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["A"] }, isActive: true } }),
    );
  });

  it("零有效 scope → 空选项（fail closed，不查询）", async () => {
    const options = await listReportQueueCampuses({ global: false, campusIds: [] });
    expect(options).toEqual([]);
    expect(campusFindMany).not.toHaveBeenCalled();
  });
});
