import { Prisma } from "@prisma/client";

const UNIT_MS: Record<string, number> = {
  PER_HOUR: 60 * 60 * 1000,
  PER_DAY: 24 * 60 * 60 * 1000,
  PER_WEEK: 7 * 24 * 60 * 60 * 1000,
  PER_MONTH: 30 * 24 * 60 * 60 * 1000,
  PER_SESSION: 0,
};

export function calculateRentalDuration(unit: string, startTime: Date, endTime: Date): number {
  if (unit === "PER_SESSION") return 1;
  const ms = endTime.getTime() - startTime.getTime();
  const unitMs = UNIT_MS[unit] ?? UNIT_MS.PER_DAY;
  return Math.max(1, Math.ceil(ms / unitMs));
}

export function calculateRentalAmount(
  unitPrice: Prisma.Decimal,
  unit: string,
  startTime: Date,
  endTime: Date,
): Prisma.Decimal {
  const duration = calculateRentalDuration(unit, startTime, endTime);
  return unitPrice.mul(duration);
}

export function createRentalOrderNo(): string {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const suffix = String(Date.now()).slice(-6);
  return `RT${date}${suffix}`;
}
