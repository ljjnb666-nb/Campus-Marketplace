import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAdminLogFindMany, mockUserFindMany } = vi.hoisted(() => ({
  mockAdminLogFindMany: vi.fn(),
  mockUserFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    adminLog: {
      findMany: mockAdminLogFindMany,
    },
    user: {
      findMany: mockUserFindMany,
    },
  },
}));

import { loadAuthorizedAuditPage } from "@/lib/audit/audit-read-model";
import type { AuditReadAccess } from "@/lib/audit/audit-access";
import { UNAVAILABLE_USER_DISPLAY_NAME } from "@/lib/governance/safe-identity";

const GLOBAL_ACCESS: AuditReadAccess = { global: true, campusIds: [] };
const CAMPUS_A_ACCESS: AuditReadAccess = { global: false, campusIds: ["A"] };
const ZERO_ACCESS: AuditReadAccess = { global: false, campusIds: [] };

function adminLogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    adminId: "actor-1",
    action: "SUSPEND_USER",
    targetType: "USER",
    targetId: "target-1",
    result: "SUCCESS",
    createdAt: new Date("2026-09-15T08:00:00.000Z"),
    campusId: null,
    metadata: { reasonCode: "FRAUD_CONFIRMED", targetUserId: "pointer-should-drop" },
    campus: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockAdminLogFindMany.mockReset();
  mockUserFindMany.mockReset();
  mockUserFindMany.mockResolvedValue([]);
});

describe("loadAuthorizedAuditPage（授权在 DB 谓词内，§16 冻结）", () => {
  it("零有效 scope → fail-closed 空页，不触达 DB", async () => {
    const page = await loadAuthorizedAuditPage({ access: ZERO_ACCESS, limit: 25 });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(mockAdminLogFindMany).not.toHaveBeenCalled();
  });

  it("GLOBAL 读者：无 campus 谓词（null 行可见）；DTO 呈现 NO_CAMPUS_SCOPE_RECORDED", async () => {
    mockAdminLogFindMany.mockResolvedValue([
      adminLogRow({ campus: null }),
      adminLogRow({
        id: "log-2",
        campusId: "A",
        campus: { name: "主校区" },
        action: "ROLE_ASSIGNED",
        metadata: null,
      }),
    ]);

    const page = await loadAuthorizedAuditPage({ access: GLOBAL_ACCESS, limit: 25 });

    expect(mockAdminLogFindMany.mock.calls[0][0].where).toEqual({});
    expect(page.items).toHaveLength(2);
    expect(page.items[0].scope).toBe("NO_CAMPUS_SCOPE_RECORDED");
    expect(page.items[0].campusName).toBeNull();
    expect(page.items[1].scope).toBe("CAMPUS");
    expect(page.items[1].campusName).toBe("主校区");
  });

  it("campus 读者：where 恒含 campusId IN 有效校区（null 行被谓词排除）", async () => {
    mockAdminLogFindMany.mockResolvedValue([]);

    await loadAuthorizedAuditPage({ access: CAMPUS_A_ACCESS, limit: 25 });

    const where = mockAdminLogFindMany.mock.calls[0][0].where;
    expect(where).toEqual({ AND: [{ campusId: { in: ["A"] } }] });
  });

  it("过滤条件与 scope 恒 AND；cursor keyset 条件进 where", async () => {
    mockAdminLogFindMany.mockResolvedValue([]);

    await loadAuthorizedAuditPage({
      access: GLOBAL_ACCESS,
      limit: 25,
      cursor: { createdAt: new Date("2026-09-14T00:00:00.000Z"), id: "log-0" },
      filters: { targetType: "USER", action: "SUSPEND_USER", from: "2026-09-01", to: "2026-09-15" },
    });

    const where = mockAdminLogFindMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(4);
    expect(where.AND).toContainEqual({ targetType: "USER" });
    expect(where.AND).toContainEqual({ action: "SUSPEND_USER" });
    expect(where.AND).toContainEqual({
      createdAt: { gte: new Date("2026-09-01T00:00:00.000Z"), lte: new Date("2026-09-15T23:59:59.999Z") },
    });
    const keyset = where.AND.find(
      (condition: { OR?: unknown[] }) => Array.isArray(condition.OR),
    );
    expect(keyset.OR[0]).toEqual({ createdAt: { lt: new Date("2026-09-14T00:00:00.000Z") } });
  });

  it("take = limit+1；hasMore 截断；nextCursor 来自页内最后一条", async () => {
    // 显式 UTC 构造（时区无关断言）
    const rows = [0, 1, 2, 3].map((index) =>
      adminLogRow({ id: `log-${index}`, createdAt: new Date(`2026-09-15T08:00:0${index}.000Z`) }),
    );
    mockAdminLogFindMany.mockResolvedValue(rows);

    const page = await loadAuthorizedAuditPage({ access: GLOBAL_ACCESS, limit: 3 });

    expect(mockAdminLogFindMany.mock.calls[0][0].take).toBe(4);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBe(
      Buffer.from(
        JSON.stringify({ createdAt: "2026-09-15T08:00:02.000Z", id: "log-2" }),
      ).toString("base64url"),
    );
  });

  it("无更多页 → nextCursor=null", async () => {
    mockAdminLogFindMany.mockResolvedValue([adminLogRow()]);
    const page = await loadAuthorizedAuditPage({ access: GLOBAL_ACCESS, limit: 25 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("DTO 最小化：select 不含 detail；metadata 经投影（指针键丢弃）；actor 走安全水合", async () => {
    mockAdminLogFindMany.mockResolvedValue([adminLogRow()]);
    mockUserFindMany.mockResolvedValue([
      { id: "actor-1", name: "审计员甲", deletedAt: null, erasedAt: null },
    ]);

    const page = await loadAuthorizedAuditPage({ access: GLOBAL_ACCESS, limit: 25 });

    const select = mockAdminLogFindMany.mock.calls[0][0].select;
    expect(select).toHaveProperty("action");
    expect(select).not.toHaveProperty("detail");

    expect(page.items[0].actor).toEqual({ id: "actor-1", displayName: "审计员甲" });
    expect(page.items[0].metadata).toEqual([
      { key: "reasonCode", label: "原因码", value: "FRAUD_CONFIRMED" },
    ]);
    expect(page.items[0].createdAt).toBe("2026-09-15T08:00:00.000Z");
    expect(page.items[0]).not.toHaveProperty("detail");
  });

  it("actor 缺失/注销 → 统一隐私 fallback", async () => {
    mockAdminLogFindMany.mockResolvedValue([adminLogRow({ adminId: "ghost" })]);
    mockUserFindMany.mockResolvedValue([]);

    const page = await loadAuthorizedAuditPage({ access: GLOBAL_ACCESS, limit: 25 });
    expect(page.items[0].actor).toEqual({
      id: "ghost",
      displayName: UNAVAILABLE_USER_DISPLAY_NAME,
    });
  });
});
