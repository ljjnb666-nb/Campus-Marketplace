import { describe, expect, it } from "vitest";

import {
  deriveRiskReadAccess,
  hasAnyRiskReadAccess,
} from "@/lib/risk/risk-read-access";
import type { AuthorizationContext } from "@/lib/rbac/service";

function context(
  overrides: Partial<AuthorizationContext> = {},
): AuthorizationContext {
  return {
    userId: "reader-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [],
    ...overrides,
  };
}

describe("Phase 10D risk.read authorization", () => {
  it("GLOBAL risk.read grants global intelligence access", () => {
    expect(
      deriveRiskReadAccess(
        context({
          grants: [
            {
              roleKey: "RISK_GLOBAL",
              scope: "GLOBAL",
              campusId: null,
              permissionKeys: ["risk.read"],
            },
          ],
        }),
      ),
    ).toEqual({ global: true, campusIds: [] });
  });

  it("CAMPUS risk.read requires matching ACTIVE membership", () => {
    expect(
      deriveRiskReadAccess(
        context({
          activeCampusIds: ["A"],
          grants: [
            {
              roleKey: "RISK_CAMPUS",
              scope: "CAMPUS",
              campusId: "A",
              permissionKeys: ["risk.read"],
            },
            {
              roleKey: "STALE",
              scope: "CAMPUS",
              campusId: "B",
              permissionKeys: ["risk.read"],
            },
          ],
        }),
      ),
    ).toEqual({ global: false, campusIds: ["A"] });
  });

  it("enforcement.read/audit.read/mutation keys never imply risk.read", () => {
    expect(
      deriveRiskReadAccess(
        context({
          activeCampusIds: ["A"],
          grants: [
            {
              roleKey: "OTHER",
              scope: "GLOBAL",
              campusId: null,
              permissionKeys: [
                "enforcement.read",
                "audit.read",
                "user.suspend",
                "campus.manage",
              ],
            },
          ],
        }),
      ),
    ).toEqual({ global: false, campusIds: [] });
  });

  it("inactive/null contexts default deny", () => {
    expect(deriveRiskReadAccess(null)).toEqual({ global: false, campusIds: [] });
    expect(
      deriveRiskReadAccess(context({ accountActive: false })),
    ).toEqual({ global: false, campusIds: [] });
    expect(hasAnyRiskReadAccess({ global: false, campusIds: [] })).toBe(false);
    expect(hasAnyRiskReadAccess({ global: true, campusIds: [] })).toBe(true);
  });
});
