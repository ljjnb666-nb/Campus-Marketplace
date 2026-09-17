import { describe, expect, it } from "vitest";

import {
  UNSCOPED_SCOPE_KEY,
  deriveReportScopeSnapshot,
  reportCampusScopeKey,
  reportReviewCampusBranch,
  reportReviewUnscopedBranch,
  resolveReportReviewScope,
} from "@/lib/reports/report-scope";

/**
 * Phase 7E：scope 快照 SSOT 合同（frozen fail-closed rule）。
 */

describe("deriveReportScopeSnapshot（快照派生唯一实现）", () => {
  it("四类 listing 目标 → CAMPUS:<campusId> exact pair", () => {
    for (const targetType of ["PRODUCT", "ERRAND_TASK", "SERVICE_LISTING", "RENTAL_LISTING"] as const) {
      expect(deriveReportScopeSnapshot(targetType, "campus-1")).toEqual({
        campusId: "campus-1",
        scopeKey: "CAMPUS:campus-1",
      });
    }
  });

  it("listing 目标 campus 不可解析 → fail-closed 落 UNSCOPED（不猜测）", () => {
    expect(deriveReportScopeSnapshot("PRODUCT", null)).toEqual({
      campusId: null,
      scopeKey: UNSCOPED_SCOPE_KEY,
    });
    expect(deriveReportScopeSnapshot("RENTAL_LISTING", null)).toEqual({
      campusId: null,
      scopeKey: UNSCOPED_SCOPE_KEY,
    });
  });

  it("USER / MESSAGE → 恒 UNSCOPED（禁止从 User.campusId 推断）", () => {
    for (const targetType of ["USER", "MESSAGE"] as const) {
      expect(deriveReportScopeSnapshot(targetType, "some-campus")).toEqual({
        campusId: null,
        scopeKey: UNSCOPED_SCOPE_KEY,
      });
      expect(deriveReportScopeSnapshot(targetType, null)).toEqual({
        campusId: null,
        scopeKey: UNSCOPED_SCOPE_KEY,
      });
    }
  });
});

describe("resolveReportReviewScope（malformed fail closed）", () => {
  it("canonical pair 解析为 CAMPUS scope", () => {
    expect(resolveReportReviewScope({ campusId: "A", scopeKey: "CAMPUS:A" })).toEqual({
      kind: "CAMPUS",
      campusId: "A",
    });
    expect(resolveReportReviewScope({ campusId: null, scopeKey: "UNSCOPED" })).toEqual({
      kind: "UNSCOPED",
    });
  });

  it("交叉/畸形对 → null（调用方一律拒绝）", () => {
    expect(resolveReportReviewScope({ campusId: "A", scopeKey: "UNSCOPED" })).toBeNull();
    expect(resolveReportReviewScope({ campusId: null, scopeKey: "CAMPUS:A" })).toBeNull();
    expect(resolveReportReviewScope({ campusId: "A", scopeKey: "CAMPUS:B" })).toBeNull();
    expect(resolveReportReviewScope({ campusId: "A", scopeKey: "GLOBAL" })).toBeNull();
  });
});

describe("队列分支构造器（exact pair，禁止叉积）", () => {
  it("campus 分支 campusId 与 scopeKey 同源派生", () => {
    expect(reportReviewCampusBranch("A")).toEqual({ campusId: "A", scopeKey: "CAMPUS:A" });
    expect(reportCampusScopeKey("A")).toBe("CAMPUS:A");
  });

  it("UNSCOPED 分支固定形状（campusId=null）", () => {
    expect(reportReviewUnscopedBranch()).toEqual({ campusId: null, scopeKey: "UNSCOPED" });
  });
});
