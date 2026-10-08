import { describe, expect, it } from "vitest";
import {
  deriveAnalyticsReadAccess, canReadAnalyticsCampus, hasAnyAnalyticsReadAccess,
} from "@/lib/analytics/analytics-read-access";
import type { AuthorizationContext } from "@/lib/rbac/service";

const context = (grants: AuthorizationContext["grants"], activeCampusIds: string[] = []): AuthorizationContext =>
  ({ userId: "operator", accountActive: true, grants, activeCampusIds });
const grant = (scope: "GLOBAL" | "CAMPUS", campusId: string | null, permissionKeys: string[]) =>
  ({ roleKey: "TEST", scope, campusId, permissionKeys });

describe("10J analytics.read capability isolation", () => {
  it("rejects absent/inactive users and unrelated permissions", () => {
    expect(hasAnyAnalyticsReadAccess(deriveAnalyticsReadAccess(null))).toBe(false);
    expect(deriveAnalyticsReadAccess({ ...context([grant("GLOBAL", null, ["analytics.read"])]), accountActive: false }))
      .toEqual({ global: false, campusIds: [] });
    expect(deriveAnalyticsReadAccess(context([grant("GLOBAL", null, ["operations.overview", "audit.read", "risk.read"])])))
      .toEqual({ global: false, campusIds: [] });
  });
  it("excludes inactive campus memberships and disallows cross-campus reads", () => {
    const access = deriveAnalyticsReadAccess(context([
      grant("CAMPUS", "B", ["analytics.read"]),
      grant("CAMPUS", "A", ["analytics.read"]),
      grant("CAMPUS", "A", ["analytics.read"]),
    ], ["A"]));
    expect(access).toEqual({ global: false, campusIds: ["A"] });
    expect(canReadAnalyticsCampus(access, "A")).toBe(true);
    expect(canReadAnalyticsCampus(access, "B")).toBe(false);
    expect(canReadAnalyticsCampus(access, "")).toBe(false);
  });
  it("GLOBAL analytics.read permits one specified campus but not a global aggregate", () => {
    const access = deriveAnalyticsReadAccess(context([grant("GLOBAL", null, ["analytics.read"])]));
    expect(canReadAnalyticsCampus(access, "A")).toBe(true);
    expect(canReadAnalyticsCampus(access, "")).toBe(false);
  });
});
