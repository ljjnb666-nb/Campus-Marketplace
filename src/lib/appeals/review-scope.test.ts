import { describe, expect, it } from "vitest";
import type { EnforcementActionType } from "@prisma/client";

import {
  APPEAL_REVIEW_CAMPUS_TYPES,
  APPEAL_REVIEW_GLOBAL_TYPES,
  appealReviewCampusBranch,
  appealReviewCampusScopeKey,
  appealReviewGlobalBranch,
  resolveAppealReviewScope,
} from "@/lib/appeals/review-scope";

/**
 * Phase 7A SCOPE_SSOT_01..03（Planning Repair 2 冻结）：
 * canonical review scope 解析的唯一事实源——域 mutation 与 7A 读面共用本模块，
 * 任何形状结论不允许出现第二套实现。
 */

function shape(type: EnforcementActionType, campusId: string | null, scopeKey: string) {
  return { type, campusId, scopeKey };
}

describe("SCOPE_SSOT_01：有效 GLOBAL/CAMPUS punitive 形状精确解析", () => {
  it("ACCOUNT_SUSPEND @GLOBAL → GLOBAL", () => {
    expect(resolveAppealReviewScope(shape("ACCOUNT_SUSPEND", null, "GLOBAL"))).toEqual({
      kind: "GLOBAL",
    });
  });

  it("MEMBERSHIP_SUSPEND @CAMPUS:A → CAMPUS(A)", () => {
    const scope = resolveAppealReviewScope(shape("MEMBERSHIP_SUSPEND", "A", "CAMPUS:A"));
    expect(scope).toEqual({ kind: "CAMPUS", campusId: "A" });
  });

  it("MARKETPLACE_RESTRICT @GLOBAL → GLOBAL", () => {
    expect(resolveAppealReviewScope(shape("MARKETPLACE_RESTRICT", null, "GLOBAL"))).toEqual({
      kind: "GLOBAL",
    });
  });

  it("MARKETPLACE_RESTRICT @CAMPUS:A → CAMPUS(A)", () => {
    expect(resolveAppealReviewScope(shape("MARKETPLACE_RESTRICT", "A", "CAMPUS:A"))).toEqual({
      kind: "CAMPUS",
      campusId: "A",
    });
  });
});

describe("SCOPE_SSOT_02：malformed 一律 fail closed（null）", () => {
  it.each([
    // Repair 1 Blocker 1 的核心反例：交叉对
    ["交叉对 campusId=A / scopeKey=CAMPUS:B", shape("MEMBERSHIP_SUSPEND", "A", "CAMPUS:B")],
    ["交叉对 MARKETPLACE_RESTRICT 同型", shape("MARKETPLACE_RESTRICT", "A", "CAMPUS:B")],
    ["campusId=null / scopeKey=CAMPUS:A", shape("MEMBERSHIP_SUSPEND", null, "CAMPUS:A")],
    ["campusId=A / scopeKey=GLOBAL", shape("MEMBERSHIP_SUSPEND", "A", "GLOBAL")],
    ["ACCOUNT_SUSPEND 带 campusId", shape("ACCOUNT_SUSPEND", "A", "CAMPUS:A")],
    ["ACCOUNT_SUSPEND scopeKey 错误", shape("ACCOUNT_SUSPEND", null, "CAMPUS:A")],
    ["MARKETPLACE_RESTRICT GLOBAL 形带 campusId", shape("MARKETPLACE_RESTRICT", "A", "GLOBAL")],
    ["MEMBERSHIP_SUSPEND 用 GLOBAL scopeKey", shape("MEMBERSHIP_SUSPEND", null, "GLOBAL")],
  ] as [string, { type: EnforcementActionType; campusId: string | null; scopeKey: string }][])(
    "%s → null",
    (_name, action) => {
      expect(resolveAppealReviewScope(action)).toBeNull();
    },
  );
});

describe("SCOPE_SSOT_03：restorative 类型永不可审核/发现", () => {
  it.each([
    ["ACCOUNT_REINSTATE", shape("ACCOUNT_REINSTATE", null, "GLOBAL")],
    ["ACCOUNT_REINSTATE campus 形", shape("ACCOUNT_REINSTATE", "A", "CAMPUS:A")],
    ["MEMBERSHIP_REINSTATE", shape("MEMBERSHIP_REINSTATE", "A", "CAMPUS:A")],
    ["MARKETPLACE_RESTORE", shape("MARKETPLACE_RESTORE", null, "GLOBAL")],
    ["MARKETPLACE_RESTORE campus 形", shape("MARKETPLACE_RESTORE", "A", "CAMPUS:A")],
  ] as [EnforcementActionType, { type: EnforcementActionType; campusId: string | null; scopeKey: string }][])(
    "%s → null",
    (_type, action) => {
      expect(resolveAppealReviewScope(action)).toBeNull();
    },
  );
});

describe("队列 exact-pair 分支构造器（Repair 1 冻结：campusId 与 scopeKey 同源派生）", () => {
  it("GLOBAL 分支为精确三元合取", () => {
    expect(appealReviewGlobalBranch()).toEqual({
      type: { in: ["ACCOUNT_SUSPEND", "MARKETPLACE_RESTRICT"] },
      campusId: null,
      scopeKey: "GLOBAL",
    });
  });

  it("campus 分支对同一 campusId 派生 scopeKey，绝不交叉", () => {
    expect(appealReviewCampusBranch("A")).toEqual({
      type: { in: ["MEMBERSHIP_SUSPEND", "MARKETPLACE_RESTRICT"] },
      campusId: "A",
      scopeKey: "CAMPUS:A",
    });
    expect(appealReviewCampusScopeKey("A")).toBe("CAMPUS:A");
  });

  it("形状常量与 resolver 的类型集合一致（单一定义所有者）", () => {
    // ACCOUNT_SUSPEND 仅允许出现在 GLOBAL 集合；MEMBERSHIP_SUSPEND 仅在 CAMPUS 集合；
    // MARKETPLACE_RESTRICT 双集合合法（canonical 双形状）。
    expect(APPEAL_REVIEW_GLOBAL_TYPES).toEqual(["ACCOUNT_SUSPEND", "MARKETPLACE_RESTRICT"]);
    expect(APPEAL_REVIEW_CAMPUS_TYPES).toEqual(["MEMBERSHIP_SUSPEND", "MARKETPLACE_RESTRICT"]);
  });
});
