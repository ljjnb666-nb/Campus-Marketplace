import { describe, expect, it } from "vitest";

import { assignedByDisplayName } from "@/lib/rbac/role-assignment-query";

/**
 * Phase 7B 冻结矩阵 U10：assignedBy 三态映射（Repair 6 冻结）。
 * 批量查询/零 N+1 由实现结构保证（单次 findMany），映射纯函数在此锁定。
 */
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
