import { describe, expect, it } from "vitest";

import {
  governanceCampusCreateSchema,
  governanceCampusUpdateSchema,
  governancePolicyDraftCreateSchema,
  governancePolicyDraftUpdateSchema,
} from "@/validators/governance-campus";

/**
 * Final Review Repair 1：FR02 district 归一化 + FR03 effectiveAt 绝对 ISO
 * 的 validator boundary 合同（fail closed）。
 */

describe("FR02 district 归一化（validator boundary）", () => {
  it("DISTRICT-01：create 空串 → null（success 路径，不再被 service 拒绝）", () => {
    const parsed = governanceCampusCreateSchema.safeParse({
      name: "主校区",
      slug: "main-campus",
      schoolName: "示例大学",
      district: "",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.district).toBeNull();
    }
  });

  it("DISTRICT-03：update 清空既有 district（空串）→ null（显式清空语义）", () => {
    const parsed = governanceCampusUpdateSchema.safeParse({
      campusId: "c1",
      district: "",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.district).toBeNull();
    }
  });

  it("DISTRICT-04：纯空白 → null", () => {
    const parsed = governanceCampusCreateSchema.safeParse({
      name: "主校区",
      slug: "main-campus",
      schoolName: "示例大学",
      district: "   ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.district).toBeNull();
    }
  });

  it("DISTRICT-05：trim 后 >80 字符 → 校验失败（max-length 保留）", () => {
    const parsed = governanceCampusCreateSchema.safeParse({
      name: "主校区",
      slug: "main-campus",
      schoolName: "示例大学",
      district: "区".repeat(81),
    });

    expect(parsed.success).toBe(false);
  });

  it("字段缺席（直接调用）→ undefined（不触碰该字段，update 零字段 refine 仍生效）", () => {
    const parsed = governanceCampusUpdateSchema.safeParse({ campusId: "c1" });

    expect(parsed.success).toBe(false); // 至少一项的 refine：district absent 不算提供

    const withDistrict = governanceCampusUpdateSchema.safeParse({
      campusId: "c1",
      district: "从化区",
    });
    expect(withDistrict.success).toBe(true);
  });
});

describe("FR03 effectiveAt 绝对 ISO（fail closed）", () => {
  const draftCreate = (effectiveAt?: string) =>
    governancePolicyDraftCreateSchema.safeParse({
      campusId: "c1",
      title: "规则",
      instructions: "说明",
      ...(effectiveAt !== undefined ? { effectiveAt } : {}),
    });

  it("TIME-01：timezone-less 输入被拒绝（datetime-local 原始形态 / 无 Z 秒级形态）", () => {
    expect(draftCreate("2026-09-22T09:00").success).toBe(false);
    expect(draftCreate("2026-09-22T09:00:00").success).toBe(false);
  });

  it("TIME-02：UTC ISO 被接受，parse 后为同一绝对 instant", () => {
    const parsed = draftCreate("2026-09-22T01:00:00.000Z");

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data.effectiveAt as Date).toISOString()).toBe("2026-09-22T01:00:00.000Z");
    }
  });

  it("TIME-03：offset ISO 合法并 canonicalize 为同一绝对 instant", () => {
    const parsed = draftCreate("2026-09-22T09:00:00.000+08:00");

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // +08:00 的 09:00 == UTC 01:00（同一绝对 instant）
      expect((parsed.data.effectiveAt as Date).toISOString()).toBe("2026-09-22T01:00:00.000Z");
    }
  });

  it("缺省 effectiveAt → undefined（服务器默认当前时刻）", () => {
    const parsed = draftCreate();

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.effectiveAt).toBeUndefined();
    }
  });

  it("update schema 同合同：timezone-less 拒绝、绝对 ISO 接受", () => {
    const rejected = governancePolicyDraftUpdateSchema.safeParse({
      campusId: "c1",
      policyId: "p1",
      effectiveAt: "2026-10-01T09:00",
    });
    expect(rejected.success).toBe(false);

    const accepted = governancePolicyDraftUpdateSchema.safeParse({
      campusId: "c1",
      policyId: "p1",
      effectiveAt: "2026-10-01T00:00:00.000Z",
    });
    expect(accepted.success).toBe(true);
    if (accepted.success) {
      expect((accepted.data.effectiveAt as Date).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    }
  });
});
