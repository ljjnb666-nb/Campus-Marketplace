import { describe, expect, it } from "vitest";

import {
  UNSCOPED_SCOPE_KEY,
  UNSCOPED_SCOPE_LABEL,
  deriveReportScopeSnapshot,
  reportCampusScopeKey,
  reportReviewCampusBranch,
  reportReviewUnscopedBranch,
  reportScopeLabel,
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

/**
 * FR03（Final Review Repair 1）：scope 呈现标签唯一语义。
 * UNSCOPED = 无校区归属记录（绝不呈现"平台级"/"全局"/"GLOBAL"）；
 * CAMPUS = 校区：<name>。授权语义零改动。
 */
describe("reportScopeLabel（canonical 呈现标签）", () => {
  it("L01：CAMPUS 报告 → 校区：<name>", () => {
    expect(reportScopeLabel("A", "主校区")).toBe("校区：主校区");
  });

  it("L01b：campus 名水合缺失 → 校区：未知校区（归属语义不变）", () => {
    expect(reportScopeLabel("A", null)).toBe("校区：未知校区");
  });

  it("L02/L03：UNSCOPED（USER/MESSAGE）→ 无校区归属记录", () => {
    expect(reportScopeLabel(null, null)).toBe(UNSCOPED_SCOPE_LABEL);
    expect(reportScopeLabel(null, "任意名称不参与")).toBe(UNSCOPED_SCOPE_LABEL);
  });

  it("L05：任何输入组合都不产生 平台级/全局/GLOBAL 文案", () => {
    for (const [campusId, campusName] of [
      [null, null],
      [null, "主校区"],
      ["A", "主校区"],
      ["A", null],
    ] as const) {
      const label = reportScopeLabel(campusId, campusName);
      expect(label).not.toContain("平台级");
      expect(label).not.toContain("全局");
      expect(label).not.toContain("GLOBAL");
    }
  });
});
