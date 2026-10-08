import { describe, expect, it } from "vitest";

import { canManageFeatureFlagScope, deriveFeatureFlagUiAccess, hasAnyFeatureFlagUiAccess } from "@/lib/feature-flags/feature-flag-ui-access";
import type { AuthorizationContext } from "@/lib/rbac/service";

function actor(input: {
  active?: boolean;
  memberships?: string[];
  grants?: AuthorizationContext["grants"];
}): AuthorizationContext {
  return {
    userId: "admin-a",
    accountActive: input.active ?? true,
    activeCampusIds: input.memberships ?? [],
    grants: input.grants ?? [],
  };
}

describe("Phase 10G flag governance scope derivation", () => {
  it("G01: GLOBAL permission works without campus membership", () => {
    const scope = deriveFeatureFlagUiAccess(actor({ grants: [
      { roleKey: "P", scope: "GLOBAL", campusId: null, permissionKeys: ["feature.flags.manage"] },
    ] }));
    expect(scope).toEqual({ global: true, campusIds: [] });
    expect(canManageFeatureFlagScope(scope, null)).toBe(true);
    expect(canManageFeatureFlagScope(scope, "A")).toBe(true);
  });

  it("G02: campus grant requires the same ACTIVE campus membership", () => {
    const scope = deriveFeatureFlagUiAccess(actor({
      memberships: ["A"],
      grants: [
        { roleKey: "C", scope: "CAMPUS", campusId: "A", permissionKeys: ["feature.flags.manage"] },
        { roleKey: "C", scope: "CAMPUS", campusId: "B", permissionKeys: ["feature.flags.manage"] },
        { roleKey: "C", scope: "CAMPUS", campusId: "A", permissionKeys: ["feature.flags.manage"] },
      ],
    }));
    expect(scope).toEqual({ global: false, campusIds: ["A"] });
    expect(canManageFeatureFlagScope(scope, null)).toBe(false);
    expect(canManageFeatureFlagScope(scope, "B")).toBe(false);
    expect(canManageFeatureFlagScope(scope, "A")).toBe(true);
  });

  it("G03: unrelated capabilities, inactive account and absent context never grant entry", () => {
    const unrelated = deriveFeatureFlagUiAccess(actor({
      grants: [{ roleKey: "X", scope: "GLOBAL", campusId: null, permissionKeys: ["runtime.config.manage"] }],
    }));
    expect(hasAnyFeatureFlagUiAccess(unrelated)).toBe(false);
    const inactive = deriveFeatureFlagUiAccess(actor({
      active: false,
      grants: [{ roleKey: "X", scope: "GLOBAL", campusId: null, permissionKeys: ["feature.flags.manage"] }],
    }));
    expect(hasAnyFeatureFlagUiAccess(inactive)).toBe(false);
    expect(hasAnyFeatureFlagUiAccess(deriveFeatureFlagUiAccess(null))).toBe(false);
  });
});
