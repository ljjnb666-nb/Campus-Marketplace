import { describe, expect, it } from "vitest";

import {
  DATA_CLASSIFICATION_REGISTRY,
  canIncludeInExport,
  getRetentionDecision,
  isSensitiveDataCategory,
} from "@/lib/governance/data-classification";

describe("数据分类 registry（DATA_CLASSIFICATION_TEST）", () => {
  it("covers every required data category", () => {
    const requiredCategories = [
      "PUBLIC_PROFILE",
      "LOGIN_IDENTIFIER_EMAIL",
      "PASSWORD_HASH",
      "CAMPUS_VERIFICATION_DATA",
      "PRIVATE_VERIFICATION_ASSET",
      "PRIVATE_MESSAGES",
      "ORDER_DETAILS",
      "REPORTS",
      "DISPUTE_EVIDENCE",
      "ADMIN_SECURITY_LOGS",
      "REQUEST_IDS",
      "UPLOADED_ASSET_METADATA",
      "POLICY_ACCEPTANCE_EVIDENCE",
      "PRIVACY_REQUESTS",
      "FUTURE_PAYMENT_DATA",
    ];

    for (const category of requiredCategories) {
      expect(DATA_CLASSIFICATION_REGISTRY[category], `缺少类别 ${category}`).toBeTruthy();
    }
  });

  it("keeps credentials and verification materials out of exports and logs", () => {
    expect(canIncludeInExport("PASSWORD_HASH")).toBe(false);
    expect(canIncludeInExport("CAMPUS_VERIFICATION_DATA")).toBe(false);
    expect(canIncludeInExport("DISPUTE_EVIDENCE")).toBe(false);
    expect(canIncludeInExport("FUTURE_PAYMENT_DATA")).toBe(false);

    // 允许导出的类别有明确定义
    expect(canIncludeInExport("POLICY_ACCEPTANCE_EVIDENCE")).toBe(true);
    expect(canIncludeInExport("PRIVATE_MESSAGES")).toBe(true);

    expect(isSensitiveDataCategory("PASSWORD_HASH")).toBe(true);
    expect(isSensitiveDataCategory("PUBLIC_PROFILE")).toBe(false);
  });

  it("never invents statutory retention durations without flagging legal review", () => {
    for (const definition of Object.values(DATA_CLASSIFICATION_REGISTRY)) {
      const duration = definition.retentionDuration;

      if (duration.kind === "PENDING_LEGAL_REVIEW") {
        // 需要法律判断的条目必须显式标记，而不是猜一个数字
        expect(definition.legalReviewRequired).toBe(true);
        expect(definition.disposition === "REVIEW_REQUIRED" || definition.reason.length > 0).toBe(true);
      }

      if (definition.legalReviewRequired) {
        expect(duration.kind).toBe("PENDING_LEGAL_REVIEW");
      }
    }

    // 固定天数只允许来自仓库既有真实规则（认证材料 30 天，Phase 1 语义）
    expect(DATA_CLASSIFICATION_REGISTRY.CAMPUS_VERIFICATION_DATA.retentionDuration).toEqual({
      kind: "FIXED_DAYS",
      days: 30,
    });
  });
});

describe("getRetentionDecision（RETENTION_DECISION_TEST）", () => {
  it("returns HOLD_BLOCKS for destructive categories", () => {
    const decision = getRetentionDecision("ORDER_DETAILS");

    expect(decision.disposition).toBe("KEEP");
    expect(decision.holdBlocks).toBe(true);
    expect(decision.legalReviewRequired).toBe(true);
  });

  it("fails closed for unknown categories (never auto-cleanup)", () => {
    const decision = getRetentionDecision("NOT_A_REAL_CATEGORY");

    expect(decision.disposition).toBe("REVIEW_REQUIRED");
    expect(decision.holdBlocks).toBe(true);
    expect(decision.legalReviewRequired).toBe(true);
  });
});
