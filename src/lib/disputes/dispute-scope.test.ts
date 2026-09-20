import { describe, expect, it } from "vitest";

import {
  disputeCampusScopeKey,
  disputeReviewCampusBranch,
  resolveDisputeScope,
} from "@/lib/disputes/dispute-scope";

/**
 * Phase 7G：dispute canonical scope SSOT（fail-closed 形状合同）。
 */

describe("dispute-scope（exact-pair，fail closed）", () => {
  it("campusId + CAMPUS:<id> exact pair → CAMPUS scope", () => {
    expect(resolveDisputeScope({ campusId: "A", scopeKey: "CAMPUS:A" })).toEqual({
      kind: "CAMPUS",
      campusId: "A",
    });
  });

  it("malformed 交叉对 → null（campusId=A / scopeKey=CAMPUS:B）", () => {
    expect(resolveDisputeScope({ campusId: "A", scopeKey: "CAMPUS:B" })).toBeNull();
  });

  it("campusId null / scopeKey 非 CAMPUS 形 → null（dispute 无 UNSCOPED 分支）", () => {
    expect(resolveDisputeScope({ campusId: null, scopeKey: "CAMPUS:A" })).toBeNull();
    expect(resolveDisputeScope({ campusId: null, scopeKey: "UNSCOPED" })).toBeNull();
    expect(resolveDisputeScope({ campusId: "A", scopeKey: "GLOBAL" })).toBeNull();
  });

  it("分支构造器：campusId 与 scopeKey 同源派生（禁叉积合同）", () => {
    expect(disputeReviewCampusBranch("A")).toEqual({ campusId: "A", scopeKey: "CAMPUS:A" });
    expect(disputeCampusScopeKey("A")).toBe("CAMPUS:A");
  });
});
