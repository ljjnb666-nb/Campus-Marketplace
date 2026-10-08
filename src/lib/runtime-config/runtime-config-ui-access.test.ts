import { describe, expect, it } from "vitest";
import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  canManageRuntimeConfigScope, deriveRuntimeConfigUiAccess, hasAnyRuntimeConfigUiAccess,
} from "@/lib/runtime-config/runtime-config-ui-access";

const grant = (scope: "GLOBAL" | "CAMPUS", campusId: string | null, permissions: string[]) =>
  ({ roleKey: "TEST", scope, campusId, permissionKeys: permissions });
const context = (grants: AuthorizationContext["grants"], activeCampusIds: string[] = []): AuthorizationContext =>
  ({ userId: "op", accountActive: true, activeCampusIds, grants });

describe("10H scoped UI discovery (never server authority)", () => {
  it("denies inactive users, unrelated rights and an absent context", () => {
    expect(hasAnyRuntimeConfigUiAccess(deriveRuntimeConfigUiAccess(null))).toBe(false);
    expect(deriveRuntimeConfigUiAccess({ ...context([grant("GLOBAL", null, ["runtime.config.manage"])]), accountActive: false }))
      .toEqual({ global: false, campusIds: [] });
    expect(deriveRuntimeConfigUiAccess(context([grant("GLOBAL", null, ["feature.flags.manage"])])))
      .toEqual({ global: false, campusIds: [] });
  });

  it("campus-only manager cannot read GLOBAL or other campus, stale membership is excluded", () => {
    const access = deriveRuntimeConfigUiAccess(context([
      grant("CAMPUS", "B", ["runtime.config.manage"]),
      grant("CAMPUS", "A", ["runtime.config.manage"]),
      grant("CAMPUS", "C", ["runtime.config.manage"]),
      grant("CAMPUS", "A", ["runtime.config.manage"]),
    ], ["A", "B"]));
    expect(access).toEqual({ global: false, campusIds: ["A", "B"] });
    expect(canManageRuntimeConfigScope(access, null)).toBe(false);
    expect(canManageRuntimeConfigScope(access, "A")).toBe(true);
    expect(canManageRuntimeConfigScope(access, "C")).toBe(false);
  });

  it("GLOBAL manager can select GLOBAL or one campus without membership", () => {
    const access = deriveRuntimeConfigUiAccess(context([grant("GLOBAL", null, ["runtime.config.manage"])]));
    expect(hasAnyRuntimeConfigUiAccess(access)).toBe(true);
    expect(canManageRuntimeConfigScope(access, null)).toBe(true);
    expect(canManageRuntimeConfigScope(access, "other")).toBe(true);
  });
});
