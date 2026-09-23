import { describe, expect, it } from "vitest";

import {
  parseVerificationEvidenceReference,
  isControlledVerificationEvidence,
  CONTROLLED_EVIDENCE,
  LEGACY_LOCAL_EVIDENCE,
  LEGACY_EXTERNAL_EVIDENCE,
  UNKNOWN_EVIDENCE,
  UNAVAILABLE_EVIDENCE,
} from "@/lib/asset-ref";

/**
 * RB-01 Repair 2：认证证据引用分类（runtime fail-closed 的单一判定点）。
 * 历史直链 / 外链 / 任意未知串必须可被统一识别并拒绝渲染为链接。
 */
describe("parseVerificationEvidenceReference", () => {
  it("CONTROLLED_ASSET：严格合法的 asset:<id>", () => {
    expect(parseVerificationEvidenceReference("asset:asset-1")).toBe(CONTROLLED_EVIDENCE);
    expect(parseVerificationEvidenceReference("asset:ckv0123456789abcdef")).toBe(
      CONTROLLED_EVIDENCE,
    );
    expect(isControlledVerificationEvidence("asset:asset-1")).toBe(true);
  });

  it("UNKNOWN：asset: 前缀但格式非法（伪造引用 fail closed）", () => {
    expect(parseVerificationEvidenceReference("asset:")).toBe(UNKNOWN_EVIDENCE);
    expect(parseVerificationEvidenceReference("asset:***")).toBe(UNKNOWN_EVIDENCE);
    expect(parseVerificationEvidenceReference("asset:../etc/passwd")).toBe(UNKNOWN_EVIDENCE);
    expect(isControlledVerificationEvidence("asset:***")).toBe(false);
  });

  it("LEGACY_LOCAL：历史 /uploads/ 直链", () => {
    expect(parseVerificationEvidenceReference("/uploads/student-card-old.jpg")).toBe(
      LEGACY_LOCAL_EVIDENCE,
    );
    expect(parseVerificationEvidenceReference("/uploads/avatar/x.png")).toBe(
      LEGACY_LOCAL_EVIDENCE,
    );
    expect(isControlledVerificationEvidence("/uploads/student-card-old.jpg")).toBe(false);
  });

  it("LEGACY_EXTERNAL：http(s) 外链", () => {
    expect(parseVerificationEvidenceReference("https://example.com/card.jpg")).toBe(
      LEGACY_EXTERNAL_EVIDENCE,
    );
    expect(parseVerificationEvidenceReference("http://example.com/card.jpg")).toBe(
      LEGACY_EXTERNAL_EVIDENCE,
    );
    expect(isControlledVerificationEvidence("https://example.com/card.jpg")).toBe(false);
  });

  it("UNKNOWN：任意其它字符串（含哨兵与恶意串）", () => {
    expect(parseVerificationEvidenceReference("legacy")).toBe(UNKNOWN_EVIDENCE);
    expect(parseVerificationEvidenceReference("erased")).toBe(UNKNOWN_EVIDENCE);
    expect(parseVerificationEvidenceReference("javascript:alert(1)")).toBe(UNKNOWN_EVIDENCE);
    expect(parseVerificationEvidenceReference("data:text/html;base64,xxx")).toBe(UNKNOWN_EVIDENCE);
    expect(isControlledVerificationEvidence("javascript:alert(1)")).toBe(false);
  });

  it("UNAVAILABLE：空值（迁移清空 / 未提交）", () => {
    expect(parseVerificationEvidenceReference("")).toBe(UNAVAILABLE_EVIDENCE);
    expect(parseVerificationEvidenceReference(null)).toBe(UNAVAILABLE_EVIDENCE);
    expect(parseVerificationEvidenceReference(undefined)).toBe(UNAVAILABLE_EVIDENCE);
  });
});
