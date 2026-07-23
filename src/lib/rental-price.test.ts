import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
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

  it("creates rental order numbers with RT prefix", () => {
    expect(createRentalOrderNo()).toMatch(/^RT\d{8}\d{6}$/);
  });
});
