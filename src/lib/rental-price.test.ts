import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  calculateRentalAmount,
  calculateRentalDuration,
  createRentalOrderNo,
} from "@/lib/rental-price";

describe("rental-price", () => {
  it("counts session rentals as one unit", () => {
    const start = new Date("2026-07-01T10:00:00Z");
    const end = new Date("2026-07-01T18:00:00Z");
    expect(calculateRentalDuration("PER_SESSION", start, end)).toBe(1);
  });

  it("ceils partial day and hour spans", () => {
    const start = new Date("2026-07-01T00:00:00Z");
    const almostTwoDays = new Date("2026-07-02T12:00:00Z");
    expect(calculateRentalDuration("PER_DAY", start, almostTwoDays)).toBe(2);

    const ninetyMinutes = new Date("2026-07-01T01:30:00Z");
    expect(calculateRentalDuration("PER_HOUR", start, ninetyMinutes)).toBe(2);
  });

  it("multiplies unit price by duration", () => {
    const start = new Date("2026-07-01T00:00:00Z");
    const end = new Date("2026-07-03T00:00:00Z");
    const amount = calculateRentalAmount(new Prisma.Decimal("12.5"), "PER_DAY", start, end);
    expect(amount.toString()).toBe("25");
  });

  it("multiplies unit price by duration and authoritative quantity", () => {
    const start = new Date("2026-07-01T00:00:00Z");
    const end = new Date("2026-07-03T00:00:00Z");
    const amount = calculateRentalAmount(
      new Prisma.Decimal("12.5"),
      "PER_DAY",
      start,
      end,
      3,
    );
    expect(amount.toString()).toBe("75");
  });

  it("rejects invalid quantity instead of silently under/over-booking value", () => {
    const start = new Date("2026-07-01T00:00:00Z");
    const end = new Date("2026-07-02T00:00:00Z");
    expect(() =>
      calculateRentalAmount(new Prisma.Decimal("12.5"), "PER_DAY", start, end, 0),
    ).toThrow("RENTAL_QUANTITY_INVALID");
    expect(() =>
      calculateRentalAmount(new Prisma.Decimal("12.5"), "PER_DAY", start, end, 1.5),
    ).toThrow("RENTAL_QUANTITY_INVALID");
  });

  it("creates rental order numbers with RT date prefix and opaque entropy", () => {
    expect(createRentalOrderNo()).toMatch(/^RT\d{8}[a-f0-9]{20}$/);
  });

  it("R06: same-millisecond and 1,000,000ms-apart requests avoid periodic collisions", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-17T04:00:00Z"));
      const sameMillisecond = Array.from({ length: 256 }, () => createRentalOrderNo());
      expect(new Set(sameMillisecond).size).toBe(sameMillisecond.length);
      vi.setSystemTime(new Date("2026-10-17T04:16:40Z"));
      const afterPeriod = Array.from({ length: 256 }, () => createRentalOrderNo());
      expect(new Set([...sameMillisecond, ...afterPeriod]).size).toBe(512);
      expect(afterPeriod[0]).toMatch(/^RT\d{8}[a-f0-9]{20}$/);
    } finally {
      vi.useRealTimers();
    }
  });
});
