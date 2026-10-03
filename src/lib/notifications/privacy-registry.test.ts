import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  getFieldPrivacyPolicy,
  getModelPrivacyPolicy,
} from "@/lib/privacy/privacy-data-registry";

/**
 * Phase 9B（§70）：notification domain 新字段的 privacy registry 覆盖。
 *
 * 红线：
 * - NotificationDelivery.destination 是 CONTACT_INFO（收件邮箱）——
 *   必须分类为 DIRECT_IDENTITY（本注册表的 contact-info 等价类），
 *   绝不误标 machine-only / non-personal；绝不入结构化日志（logSafe=false）；
 * - Notification.kind/schemaVersion/payload 属 DERIVED_EPHEMERAL
 *   （payload 只允许 IDs + 机器状态，zod strict 写边界强制）；
 * - provider/providerMessageId/providerIdempotencyKey/suppressionCode
 *   是机器 provenance（STORAGE_METADATA），行保留。
 */

describe("Phase 9B privacy registry coverage（§70）", () => {
  it("NotificationDelivery.destination = DIRECT_IDENTITY contact info（logSafe=false、绝不误标 machine-only）", () => {
    const policy = getFieldPrivacyPolicy("NotificationDelivery", "destination");
    expect(policy).not.toBeNull();
    expect(policy!.classification).toBe("DIRECT_IDENTITY");
    expect(policy!.logSafe).toBe(false);
    expect(policy!.secondaryCopyAllowed).toBe(false);
    expect(policy!.erasure).toBe("REDACT");
  });

  it("Notification kind/schemaVersion/payload 已登记（DERIVED_EPHEMERAL，随行 DELETE）", () => {
    for (const field of ["kind", "schemaVersion", "payload"]) {
      const policy = getFieldPrivacyPolicy("Notification", field);
      expect(policy, `Notification.${field} 缺少 registry policy`).not.toBeNull();
      expect(policy!.classification).toBe("DERIVED_EPHEMERAL");
      expect(policy!.erasure).toBe("DELETE");
    }
    // kind/version 允许进入结构化日志（§80 观测白名单）；payload 不允许
    expect(getFieldPrivacyPolicy("Notification", "kind")!.logSafe).toBe(true);
    expect(getFieldPrivacyPolicy("Notification", "schemaVersion")!.logSafe).toBe(true);
    expect(getFieldPrivacyPolicy("Notification", "payload")!.logSafe).toBe(false);
  });

  it("NotificationDelivery 机器 provenance 字段已登记（STORAGE_METADATA，行保留）", () => {
    for (const field of ["provider", "providerMessageId", "providerIdempotencyKey", "suppressionCode"]) {
      const policy = getFieldPrivacyPolicy("NotificationDelivery", field);
      expect(policy, `NotificationDelivery.${field} 缺少 registry policy`).not.toBeNull();
      expect(policy!.classification).toBe("STORAGE_METADATA");
      expect(policy!.erasure).toBe("RETAIN_STRUCTURAL");
    }
  });

  it("Notification model 级 policy 保持 DERIVED_EPHEMERAL / DELETE（RB-23 不退化）", () => {
    const model = getModelPrivacyPolicy("Notification");
    expect(model).not.toBeNull();
    expect(model!.classification).toBe("DERIVED_EPHEMERAL");
    expect(model!.erasure).toBe("DELETE");
  });

  it("账号注销执行路径实际处理 NotificationDelivery（REGISTRY-05 同源合同）", () => {
    const erasureSource = readFileSync(
      path.join(process.cwd(), "src", "lib", "privacy", "account-erasure.ts"),
      "utf8",
    );
    expect(erasureSource).toContain("notificationDelivery.updateMany");
    expect(erasureSource).toContain("NOTIFICATION_DELIVERY_SUPPRESSION_RECIPIENT_ERASED");
    expect(erasureSource).toContain("REDACTED_EMAIL_DESTINATION");
  });
});
