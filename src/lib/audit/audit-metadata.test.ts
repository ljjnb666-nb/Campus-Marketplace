import { describe, expect, it } from "vitest";

import {
  AUDIT_METADATA_MAX_VALUE_LENGTH,
  AUDIT_INTERNAL_POINTER_KEYS,
  projectAuditMetadata,
} from "@/lib/audit/audit-metadata";

describe("projectAuditMetadata（读侧披露策略，R3 冻结）", () => {
  it("R3-03: DISPLAY_SAFE key 以专用 label + 归一值展示", () => {
    const entries = projectAuditMetadata({
      roleKey: "CAMPUS_APPEAL_REVIEWER",
      reasonCode: "FRAUD_CONFIRMED",
      policyVersion: 3,
      selfReview: true,
      listingType: "RENTAL",
    });

    expect(entries).toEqual([
      { key: "roleKey", label: "角色", value: "CAMPUS_APPEAL_REVIEWER" },
      { key: "reasonCode", label: "原因码", value: "FRAUD_CONFIRMED" },
      { key: "policyVersion", label: "策略版本", value: "3" },
      { key: "selfReview", label: "自查", value: "是" },
      { key: "listingType", label: "列表类型", value: "RENTAL" },
    ]);
  });

  it("R3-02: persist-safe 但 read-disallowed 的指针 key 一律丢弃", () => {
    const metadata: Record<string, unknown> = {};
    for (const key of AUDIT_INTERNAL_POINTER_KEYS) {
      metadata[key] = "cuid-pointer-should-never-render";
    }
    // 写侧合法、读侧内部指针：全部不产出
    expect(projectAuditMetadata(metadata)).toEqual([]);
  });

  it("R3-01: 未知 key 丢弃（fail closed）", () => {
    expect(projectAuditMetadata({ totallyUnknown: "x", another: 1 })).toEqual([]);
  });

  it("R3-04: 返回结构化条目数组，raw metadata object 永不透传", () => {
    const entries = projectAuditMetadata({ riskState: "RESTRICTED" });
    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["key", "label", "value"]);
      expect(typeof entry.value).toBe("string");
    }
  });

  it("null/undefined/嵌套对象值不产出条目；false 归一为 否", () => {
    expect(
      projectAuditMetadata({
        decision: null,
        grantedBy: undefined,
        scopeKey: "GLOBAL",
        selfReview: false,
      }),
    ).toEqual([
      { key: "scopeKey", label: "范围", value: "GLOBAL" },
      { key: "selfReview", label: "自查", value: "否" },
    ]);
  });

  it("超长值有界截断（不无上限渲染任意 primitive）", () => {
    const long = "x".repeat(AUDIT_METADATA_MAX_VALUE_LENGTH + 50);
    const entries = projectAuditMetadata({ resultState: long });
    expect(entries).toHaveLength(1);
    expect(entries[0].value.length).toBe(AUDIT_METADATA_MAX_VALUE_LENGTH + 1);
    expect(entries[0].value.endsWith("…")).toBe(true);
  });

  it("非对象 metadata（null/数组/标量）→ 空数组", () => {
    expect(projectAuditMetadata(null)).toEqual([]);
    expect(projectAuditMetadata(undefined)).toEqual([]);
    expect(projectAuditMetadata([1, 2])).toEqual([]);
    expect(projectAuditMetadata("GLOBAL")).toEqual([]);
  });
});
