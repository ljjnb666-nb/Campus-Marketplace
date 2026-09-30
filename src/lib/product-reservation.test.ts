import { describe, expect, it } from "vitest";

import {
  computeProductReservationExpiresAt,
  isProductReservationExpired,
  PRODUCT_RESERVATION_EXPIRED_CANCEL_REASON,
  PRODUCT_RESERVATION_TTL_MS,
} from "@/lib/product-reservation";

/**
 * Phase 8B-01：PRODUCT reservation deadline 中央时间原语单元合同。
 *
 * 冻结不变量：
 *   TTL = 24 HOURS（常量唯一定义点）
 *   expiresAt = captured now + TTL（同事务单一 now，禁止漂移）
 *   时间边界：now >= expiresAt → expired（exact deadline instant = EXPIRED）；
 *   accept / cancel / expire 全部共享同一判定，禁止 `>` / `>=` 漂移。
 */

describe("PRODUCT_RESERVATION_TTL_MS", () => {
  it("冻结为 24 小时", () => {
    expect(PRODUCT_RESERVATION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("computeProductReservationExpiresAt", () => {
  it("由捕获的单一 now 精确加 24h（RES-CREATE-01 冻结钟：12:00 → 次日 12:00）", () => {
    const now = new Date("2026-09-29T12:00:00.000Z");

    expect(computeProductReservationExpiresAt(now).toISOString()).toBe(
      "2026-09-30T12:00:00.000Z",
    );
  });

  it("不修改入参（纯函数）", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    computeProductReservationExpiresAt(now);

    expect(now.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("毫秒精度无损", () => {
    const now = new Date("2026-09-29T12:00:00.999Z");

    expect(computeProductReservationExpiresAt(now).getTime()).toBe(
      now.getTime() + PRODUCT_RESERVATION_TTL_MS,
    );
  });
});

describe("isProductReservationExpired（冻结边界）", () => {
  const expiresAt = new Date("2026-09-30T12:00:00.000Z");

  it("now < expiresAt → 未过期", () => {
    expect(
      isProductReservationExpired(expiresAt, new Date("2026-09-30T11:59:59.999Z")),
    ).toBe(false);
  });

  it("now == expiresAt → 已过期（exact deadline instant = EXPIRED）", () => {
    expect(isProductReservationExpired(expiresAt, new Date("2026-09-30T12:00:00.000Z"))).toBe(
      true,
    );
  });

  it("now > expiresAt → 已过期", () => {
    expect(
      isProductReservationExpired(expiresAt, new Date("2026-09-30T12:00:00.001Z")),
    ).toBe(true);
  });
});

describe("PRODUCT_RESERVATION_EXPIRED_CANCEL_REASON", () => {
  it("system copy：不含任何 user-authored 插值槽位", () => {
    expect(PRODUCT_RESERVATION_EXPIRED_CANCEL_REASON).toBe("商品预留超时自动释放");
  });
});
