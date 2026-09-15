import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findMany: mockFindMany,
    },
  },
}));

import { hydrateSafeIdentities, UNAVAILABLE_USER_DISPLAY_NAME } from "@/lib/governance/safe-identity";

function row(overrides: Partial<{ id: string; name: string; deletedAt: Date | null; erasedAt: Date | null }> = {}) {
  return {
    id: "u1",
    name: "真实昵称",
    deletedAt: null,
    erasedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockFindMany.mockReset();
});

describe("hydrateSafeIdentities（R4 / DECISION_12A 冻结）", () => {
  it("R4-01: active 用户 → 真实 displayName", async () => {
    mockFindMany.mockResolvedValue([row()]);
    const map = await hydrateSafeIdentities(["u1"]);
    expect(map.get("u1")).toEqual({ id: "u1", displayName: "真实昵称" });
  });

  it("R4-02: deletedAt != null → 统一 fallback", async () => {
    mockFindMany.mockResolvedValue([row({ deletedAt: new Date() })]);
    const map = await hydrateSafeIdentities(["u1"]);
    expect(map.get("u1")!.displayName).toBe(UNAVAILABLE_USER_DISPLAY_NAME);
  });

  it("R4-03: erasedAt != null → 同一 fallback（不依赖 name 副作用）", async () => {
    mockFindMany.mockResolvedValue([row({ erasedAt: new Date(), name: "任意保留名" })]);
    const map = await hydrateSafeIdentities(["u1"]);
    expect(map.get("u1")!.displayName).toBe(UNAVAILABLE_USER_DISPLAY_NAME);
  });

  it("R4-04: 缺失行 → 同一 fallback（Map 覆盖全部入参，调用方无需判空）", async () => {
    mockFindMany.mockResolvedValue([]);
    const map = await hydrateSafeIdentities(["ghost"]);
    expect(map.get("ghost")).toEqual({ id: "ghost", displayName: UNAVAILABLE_USER_DISPLAY_NAME });
  });

  it("批量单查询去重（无 N+1）；select 仅含 {id,name,deletedAt,erasedAt}", async () => {
    mockFindMany.mockResolvedValue([row(), row({ id: "u2", name: "乙" })]);
    const map = await hydrateSafeIdentities(["u1", "u2", "u1"]);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany.mock.calls[0][0].where).toEqual({ id: { in: ["u1", "u2"] } });
    expect(mockFindMany.mock.calls[0][0].select).toEqual({
      id: true,
      name: true,
      deletedAt: true,
      erasedAt: true,
    });
    expect(map.size).toBe(2);
  });

  it("空入参不触达数据库", async () => {
    const map = await hydrateSafeIdentities([]);
    expect(map.size).toBe(0);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
