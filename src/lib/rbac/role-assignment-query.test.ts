import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  campus: { findMany: vi.fn(), findFirst: vi.fn() },
  userRoleAssignment: { findMany: vi.fn(), findUnique: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  assignedByDisplayName,
  loadManageableRoleCampuses,
  loadManagedRoleAssignments,
  resolveGrantEligibleCampus,
  resolveRevocableAssignment,
} from "@/lib/rbac/role-assignment-query";
import { decodeGovernanceRoleCursor } from "@/validators/governance-role";

/**
 * Phase 7B 冻结矩阵 U10 + prisma 路径分支：fail-closed 早退 / canManage 拒绝 /
 * keyset + nextCursor 编码 / resolver 全拒绝臂（真实实现 + mock prisma seam）。
 */

const globalAccess = { global: true, campusIds: [] };
const campusAccess = { global: false, campusIds: ["campus-a"] };
const emptyAccess = { global: false, campusIds: [] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assignedByDisplayName（U10）", () => {
  it("assignedById == null → 系统", () => {
    expect(assignedByDisplayName(null, new Map())).toBe("系统");
  });

  it("assignedById 非空但无法解析 → 未知", () => {
    expect(assignedByDisplayName("ghost-id", new Map())).toBe("未知");
  });

  it("解析命中 → user.name", () => {
    expect(assignedByDisplayName("u1", new Map([["u1", "张管理员"]]))).toBe("张管理员");
  });
});

describe("loadManageableRoleCampuses prisma 路径", () => {
  it("零有效 scope → fail-closed 空数组（零 DB 调用）", async () => {
    expect(await loadManageableRoleCampuses(emptyAccess)).toEqual([]);
    expect(prismaMock.campus.findMany).not.toHaveBeenCalled();
  });

  it("GLOBAL → where 仅 isActive；campus actor → id IN ∩ isActive；select 最小面", async () => {
    prismaMock.campus.findMany.mockResolvedValue([{ id: "c1", name: "C1" }]);

    await loadManageableRoleCampuses(globalAccess);
    expect(prismaMock.campus.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );

    await loadManageableRoleCampuses(campusAccess);
    const call = prismaMock.campus.findMany.mock.calls.at(-1)![0];
    expect(call.where).toEqual({ id: { in: ["campus-a"] }, isActive: true });
    expect(call.select).toEqual({ id: true, name: true });
  });
});

describe("resolveGrantEligibleCampus prisma 路径", () => {
  it("canManageCampus=false → null（User/Campus 查询均零调用）", async () => {
    expect(
      await resolveGrantEligibleCampus({ access: campusAccess, campusId: "campus-b" }),
    ).toBeNull();
    expect(prismaMock.campus.findFirst).not.toHaveBeenCalled();
  });

  it("manage 授权通过 → Campus { id, isActive: true } 精确查询，select 仅 { id }", async () => {
    prismaMock.campus.findFirst.mockResolvedValue({ id: "campus-a" });

    expect(
      await resolveGrantEligibleCampus({ access: campusAccess, campusId: "campus-a" }),
    ).toEqual({ id: "campus-a" });
    const call = prismaMock.campus.findFirst.mock.calls.at(-1)![0];
    expect(call.where).toEqual({ id: "campus-a", isActive: true });
    expect(call.select).toEqual({ id: true });
  });
});

describe("loadManagedRoleAssignments prisma 路径", () => {
  it("零有效 scope → fail-closed 空页（零 DB 调用）", async () => {
    expect(await loadManagedRoleAssignments({ access: emptyAccess, limit: 25 })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(prismaMock.userRoleAssignment.findMany).not.toHaveBeenCalled();
  });

  it("hasMore → nextCursor 编码（codec 往返）；assignedBy 批量 map 三态", async () => {
    const at = new Date("2026-09-12T08:00:00.000Z");
    const rows = [
      {
        id: "a1",
        assignedAt: at,
        assignedById: null,
        role: { key: "CAMPUS_APPEAL_REVIEWER" },
        user: { name: "用户甲" },
        campus: { name: "主校区" },
      },
      {
        id: "a2",
        assignedAt: at,
        assignedById: "u1",
        role: { key: "CAMPUS_APPEAL_REVIEWER" },
        user: { name: "用户乙" },
        campus: { name: "主校区" },
      },
      {
        id: "a3",
        assignedAt: at,
        assignedById: "ghost",
        role: { key: "CAMPUS_APPEAL_REVIEWER" },
        user: { name: "用户丙" },
        campus: { name: "主校区" },
      },
      {
        id: "a4",
        assignedAt: at,
        assignedById: null,
        role: { key: "CAMPUS_APPEAL_REVIEWER" },
        user: { name: "用户丁" },
        campus: { name: "主校区" },
      },
    ];
    // limit=3 + 4 行 → hasMore=true（页内恰含 null/命中/未知三态）
    prismaMock.userRoleAssignment.findMany.mockResolvedValue(rows);
    prismaMock.user.findMany.mockResolvedValue([{ id: "u1", name: "张管理员" }]);

    const page = await loadManagedRoleAssignments({ access: globalAccess, limit: 3 });

    expect(page.items.map((item) => item.assignedByDisplayName)).toEqual([
      "系统",
      "张管理员",
      "未知",
    ]);
    expect(page.nextCursor).not.toBeNull();
    const decoded = decodeGovernanceRoleCursor(page.nextCursor!);
    expect(decoded).toEqual({ assignedAt: at, id: "a3" });
    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["u1", "ghost"] } } }),
    );
  });

  it("cursor 进入 keyset 条件；campus actor 附加单列 campusId IN；allowlist role 过滤", async () => {
    prismaMock.userRoleAssignment.findMany.mockResolvedValue([]);

    const cursor = { assignedAt: new Date("2026-09-12T08:00:00.000Z"), id: "a1" };
    await loadManagedRoleAssignments({ access: campusAccess, cursor, limit: 25 });

    const call = prismaMock.userRoleAssignment.findMany.mock.calls.at(-1)![0];
    expect(call.where.role).toEqual({
      key: { in: ["CAMPUS_APPEAL_REVIEWER"] },
    });
    expect(call.where.campusId).toEqual({ in: ["campus-a"] });
    expect(call.where.OR).toBeDefined();
    expect(call.orderBy).toEqual([
      { assignedAt: "desc" },
      { id: "desc" },
    ]);
    expect(call.take).toBe(26);
  });
});

describe("resolveRevocableAssignment 拒绝臂（fail closed）", () => {
  it("行不存在 → null", async () => {
    prismaMock.userRoleAssignment.findUnique.mockResolvedValue(null);
    expect(
      await resolveRevocableAssignment({ access: globalAccess, assignmentId: "nope" }),
    ).toBeNull();
  });

  it.each([
    {
      name: "allowlist 外角色",
      row: {
        id: "a1",
        userId: "u1",
        campusId: "c1",
        scopeKey: "CAMPUS:c1",
        role: { key: "FUTURE_ROLE", scope: "CAMPUS" },
      },
    },
    {
      name: "GLOBAL scope 角色",
      row: {
        id: "a1",
        userId: "u1",
        campusId: null,
        scopeKey: "GLOBAL",
        role: { key: "PLATFORM_ADMIN", scope: "GLOBAL" },
      },
    },
    {
      name: "campusId 为 null",
      row: {
        id: "a1",
        userId: "u1",
        campusId: null,
        scopeKey: "CAMPUS:c1",
        role: { key: "CAMPUS_APPEAL_REVIEWER", scope: "CAMPUS" },
      },
    },
    {
      name: "scopeKey 与 campusId 不构成 exact pair",
      row: {
        id: "a1",
        userId: "u1",
        campusId: "c1",
        scopeKey: "CAMPUS:other",
        role: { key: "CAMPUS_APPEAL_REVIEWER", scope: "CAMPUS" },
      },
    },
  ])("$name → null", async ({ row }) => {
    prismaMock.userRoleAssignment.findUnique.mockResolvedValue(row);
    expect(
      await resolveRevocableAssignment({ access: globalAccess, assignmentId: "a1" }),
    ).toBeNull();
  });

  it("campus actor 无该校区的 manage 授权 → null；命中则回传服务器解析字段", async () => {
    const row = {
      id: "a1",
      userId: "u1",
      campusId: "c1",
      scopeKey: "CAMPUS:c1",
      role: { key: "CAMPUS_APPEAL_REVIEWER", scope: "CAMPUS" },
    };
    prismaMock.userRoleAssignment.findUnique.mockResolvedValue(row);

    expect(
      await resolveRevocableAssignment({ access: campusAccess, assignmentId: "a1" }),
    ).toBeNull();

    expect(
      await resolveRevocableAssignment({ access: globalAccess, assignmentId: "a1" }),
    ).toEqual({ id: "a1", userId: "u1", campusId: "c1", roleKey: "CAMPUS_APPEAL_REVIEWER" });
  });
});
