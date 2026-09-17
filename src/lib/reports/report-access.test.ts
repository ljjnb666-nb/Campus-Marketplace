import { describe, expect, it } from "vitest";

import { deriveReportReviewAccess, hasAnyReportReviewAccess, canReviewReportScope } from "@/lib/reports/report-access";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7E：report.review access 派生合同（DEFAULT_DENY，与 hasPermission 同构）。
 */

function context(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    userId: "user-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [],
    ...overrides,
  };
}

describe("deriveReportReviewAccess", () => {
  it("GLOBAL report.review → global=true（不要求 membership）", () => {
    const access = deriveReportReviewAccess(
      context({
        grants: [
          { roleKey: "PLATFORM_ADMIN", scope: "GLOBAL", campusId: null, permissionKeys: ["report.review"] },
        ],
      }),
    );
    expect(access).toEqual({ global: true, campusIds: [] });
    expect(hasAnyReportReviewAccess(access)).toBe(true);
  });

  it("CAMPUS report.review@A → 仅 membership ACTIVE 时纳入 campusIds", () => {
    const access = deriveReportReviewAccess(
      context({
        activeCampusIds: ["A"],
        grants: [
          { roleKey: "CAMPUS_REPORT_REVIEWER", scope: "CAMPUS", campusId: "A", permissionKeys: ["report.review"] },
        ],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: ["A"] });
  });

  it("membership 缺失/非激活的 CAMPUS grant 不产生 scope（grant ∧ membership 求交）", () => {
    const access = deriveReportReviewAccess(
      context({
        activeCampusIds: [],
        grants: [
          { roleKey: "CAMPUS_REPORT_REVIEWER", scope: "CAMPUS", campusId: "A", permissionKeys: ["report.review"] },
        ],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
    expect(hasAnyReportReviewAccess(access)).toBe(false);
  });

  it("非激活账号 / null context → 空 access（DEFAULT_DENY）", () => {
    const inactive = deriveReportReviewAccess(
      context({
        accountActive: false,
        grants: [
          { roleKey: "PLATFORM_ADMIN", scope: "GLOBAL", campusId: null, permissionKeys: ["report.review"] },
        ],
      }),
    );
    expect(inactive).toEqual({ global: false, campusIds: [] });
    expect(deriveReportReviewAccess(null)).toEqual({ global: false, campusIds: [] });
  });

  it("其他 permission 的 grant 不产生 report access（零扩权）", () => {
    const access = deriveReportReviewAccess(
      context({
        grants: [
          { roleKey: "R1", scope: "GLOBAL", campusId: null, permissionKeys: ["appeal.review", "listing.moderate"] },
          { roleKey: "R2", scope: "CAMPUS", campusId: "A", permissionKeys: ["appeal.review"] },
        ],
        activeCampusIds: ["A"],
      }),
    );
    expect(access).toEqual({ global: false, campusIds: [] });
  });
});

describe("canReviewReportScope（UNSCOPED 仅 GLOBAL）", () => {
  const globalAccess = { global: true, campusIds: [] as string[] };
  const campusA = { global: false, campusIds: ["A"] };

  it("UNSCOPED：GLOBAL 放行，campus reviewer 拒绝", () => {
    expect(canReviewReportScope(globalAccess, { kind: "UNSCOPED" })).toBe(true);
    expect(canReviewReportScope(campusA, { kind: "UNSCOPED" })).toBe(false);
  });

  it("CAMPUS：exact campus 放行；其他校区/GLOBAL-only 拒绝", () => {
    expect(canReviewReportScope(campusA, { kind: "CAMPUS", campusId: "A" })).toBe(true);
    expect(canReviewReportScope(campusA, { kind: "CAMPUS", campusId: "B" })).toBe(false);
    expect(canReviewReportScope(globalAccess, { kind: "CAMPUS", campusId: "B" })).toBe(true);
  });
});
