import { describe, expect, it } from "vitest";

import {
  ACTIVE_SERVICE_ORDER_STATUSES,
  ERRAND_PUBLIC_EXPOSURE_STATUS,
  ERRAND_WIND_DOWN_MESSAGES,
  PRODUCT_ALLOWED_STATUSES,
  PRODUCT_PUBLIC_EXPOSURE_STATUS,
  PRODUCT_WIND_DOWN_MESSAGES,
  RENTAL_ALLOWED_STATUSES,
  RENTAL_LEGACY_STATUSES,
  RENTAL_PUBLIC_EXPOSURE_STATUS,
  RENTAL_STATUS_TARGETS,
  RENTAL_TERMINAL_ORDER_STATUSES,
  RENTAL_WIND_DOWN_MESSAGES,
  SELLER_PRODUCT_STATUS_TARGETS,
  SERVICE_ALLOWED_STATUSES,
  SERVICE_PUBLIC_EXPOSURE_STATUS,
  SERVICE_STATUS_TARGETS,
  SERVICE_WIND_DOWN_MESSAGES,
  isErrandPubliclyExposed,
  isProductPubliclyExposed,
  isRentalPubliclyExposed,
  isServicePubliclyExposed,
} from "./listing-lifecycle";

// Phase 8F：Lifecycle Contract SSOT 纯策略单元测试（§86 冻结矩阵的策略侧）。

describe("Phase 8F listing lifecycle policy SSOT", () => {
  it("PUBLIC_EXPOSURE 唯一口径：Product ACTIVE / Service ACTIVE / Errand OPEN / Rental AVAILABLE", () => {
    expect(PRODUCT_PUBLIC_EXPOSURE_STATUS).toBe("ACTIVE");
    expect(SERVICE_PUBLIC_EXPOSURE_STATUS).toBe("ACTIVE");
    expect(ERRAND_PUBLIC_EXPOSURE_STATUS).toBe("OPEN");
    expect(RENTAL_PUBLIC_EXPOSURE_STATUS).toBe("AVAILABLE");
  });

  it("Product exposure 判定：仅 ACTIVE 公开，RESERVED/SOLD/OFFLINE/PAUSED 一律隐藏", () => {
    expect(isProductPubliclyExposed("ACTIVE")).toBe(true);
    expect(isProductPubliclyExposed("RESERVED")).toBe(false);
    expect(isProductPubliclyExposed("SOLD")).toBe(false);
    expect(isProductPubliclyExposed("OFFLINE")).toBe(false);
    expect(isProductPubliclyExposed("PAUSED")).toBe(false);
  });

  it("Service exposure 判定：仅 ACTIVE 公开，PAUSED/OFFLINE 隐藏", () => {
    expect(isServicePubliclyExposed("ACTIVE")).toBe(true);
    expect(isServicePubliclyExposed("PAUSED")).toBe(false);
    expect(isServicePubliclyExposed("OFFLINE")).toBe(false);
    expect(isServicePubliclyExposed("RESERVED")).toBe(false);
    expect(isServicePubliclyExposed("SOLD")).toBe(false);
  });

  it("Errand exposure 判定：OPEN + deadline > now 公开，全部非 OPEN workflow 态隐藏", () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    const future = new Date("2026-10-05T12:00:00.000Z");
    const past = new Date("2026-10-03T12:00:00.000Z");
    expect(isErrandPubliclyExposed("OPEN", future, now)).toBe(true);
    expect(isErrandPubliclyExposed("CLAIMED", future, now)).toBe(false);
    expect(isErrandPubliclyExposed("IN_PROGRESS", future, now)).toBe(false);
    expect(isErrandPubliclyExposed("PENDING_CONFIRMATION", future, now)).toBe(false);
    expect(isErrandPubliclyExposed("COMPLETED", future, now)).toBe(false);
    expect(isErrandPubliclyExposed("CANCELLED", future, now)).toBe(false);
    expect(isErrandPubliclyExposed("DISPUTED", future, now)).toBe(false);
    expect(isErrandPubliclyExposed("CLOSED", future, now)).toBe(false);
  });

  it("Phase 9C-02 Errand deadline SSOT：deadline <= now 即不公开（fail closed），边界与缺失同样隐藏", () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    // 严格大于：deadline == now 属过期（PUBLIC_EXPOSED 要求 deadline > now）
    expect(isErrandPubliclyExposed("OPEN", new Date("2026-10-04T12:00:00.000Z"), now)).toBe(false);
    expect(isErrandPubliclyExposed("OPEN", new Date("2026-10-04T11:59:59.999Z"), now)).toBe(false);
    expect(isErrandPubliclyExposed("OPEN", new Date("2026-10-04T12:00:00.001Z"), now)).toBe(true);
    // ISO 字符串与 Date 等价接受
    expect(isErrandPubliclyExposed("OPEN", "2026-10-04T12:00:00.001Z", now)).toBe(true);
    // deadline 缺失（不可能的 corrupt 行）→ fail closed
    expect(isErrandPubliclyExposed("OPEN", null, now)).toBe(false);
    expect(isErrandPubliclyExposed("OPEN", undefined, now)).toBe(false);
  });

  it("Rental exposure 判定：仅 AVAILABLE 公开，legacy 值一律隐藏", () => {
    expect(isRentalPubliclyExposed("AVAILABLE")).toBe(true);
    expect(isRentalPubliclyExposed("PAUSED")).toBe(false);
    expect(isRentalPubliclyExposed("OFFLINE")).toBe(false);
    for (const legacy of RENTAL_LEGACY_STATUSES) {
      expect(isRentalPubliclyExposed(legacy)).toBe(false);
    }
  });

  it("canonical 状态集合冻结（与 DB CHECK 同源口径）", () => {
    expect(PRODUCT_ALLOWED_STATUSES).toEqual(["ACTIVE", "RESERVED", "SOLD", "OFFLINE"]);
    expect(SERVICE_ALLOWED_STATUSES).toEqual(["ACTIVE", "PAUSED", "OFFLINE"]);
    expect(RENTAL_ALLOWED_STATUSES).toEqual(["AVAILABLE", "PAUSED", "OFFLINE"]);
    expect(RENTAL_LEGACY_STATUSES).toEqual(["FULLY_BOOKED", "PENDING_REVIEW", "BANNED"]);
  });

  it("运行时目标白名单：Product 无 PAUSED/RESERVED/SOLD；Service/Rental 与 canonical 集合一致", () => {
    expect([...SELLER_PRODUCT_STATUS_TARGETS].sort()).toEqual(["ACTIVE", "OFFLINE"]);
    expect([...SERVICE_STATUS_TARGETS].sort()).toEqual(["ACTIVE", "OFFLINE", "PAUSED"]);
    expect([...RENTAL_STATUS_TARGETS].sort()).toEqual(["AVAILABLE", "OFFLINE", "PAUSED"]);
  });

  it("active obligation central helpers：Service 含 IN_DISPUTE；Rental terminal 恰四值", () => {
    expect(ACTIVE_SERVICE_ORDER_STATUSES).toEqual(["PENDING", "ACCEPTED", "IN_PROGRESS", "IN_DISPUTE"]);
    expect(RENTAL_TERMINAL_ORDER_STATUSES).toEqual(["COMPLETED", "CANCELLED", "REJECTED", "CLOSED"]);
  });

  it("wind-down 中文文案：无 raw enum 泄漏（§41/§45）", () => {
    for (const messages of [
      PRODUCT_WIND_DOWN_MESSAGES,
      SERVICE_WIND_DOWN_MESSAGES,
      RENTAL_WIND_DOWN_MESSAGES,
      ERRAND_WIND_DOWN_MESSAGES,
    ]) {
      for (const message of Object.values(messages)) {
        if (message) {
          expect(/[\u4e00-\u9fa5]/.test(message)).toBe(true);
        }
      }
    }
    expect(PRODUCT_WIND_DOWN_MESSAGES.RESERVED).toContain("预订");
    expect(SERVICE_WIND_DOWN_MESSAGES.PAUSED).toContain("暂停");
    expect(RENTAL_WIND_DOWN_MESSAGES.PAUSED).toContain("暂停");
    expect(ERRAND_WIND_DOWN_MESSAGES.CLAIMED).toContain("履约");
  });
});
