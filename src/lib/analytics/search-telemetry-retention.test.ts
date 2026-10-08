import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { claims, hours } = vi.hoisted(() => ({
  claims: { count: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  hours: { count: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { searchTelemetryClaim: claims, searchTelemetryHour: hours },
}));
import { cleanupExpiredSearchTelemetry } from "@/lib/analytics/search-telemetry-retention";
const now = new Date("2026-10-09T00:00:00.000Z");
beforeEach(() => {
  for (const delegate of [claims, hours]) for (const fn of Object.values(delegate)) fn.mockReset();
});
afterEach(() => vi.restoreAllMocks());
describe("10K-R2a bounded privacy retention", () => {
  it("dry-run is read-only and reports exact expired rows", async () => {
    claims.count.mockResolvedValue(6); hours.count.mockResolvedValue(2);
    expect(await cleanupExpiredSearchTelemetry({ now, dryRun: true }))
      .toEqual({ dryRun: true, deletedClaims: 6, deletedHours: 2 });
    expect(claims.deleteMany).not.toHaveBeenCalled();
    expect(hours.deleteMany).not.toHaveBeenCalled();
  });
  it("deletes only fresh expired predicates with bounded candidate IDs", async () => {
    claims.findMany.mockResolvedValue([{ digest: "a".repeat(64) }]);
    hours.findMany.mockResolvedValue([{ hourStart: new Date("2026-09-01") }]);
    claims.deleteMany.mockResolvedValue({ count: 1 });
    hours.deleteMany.mockResolvedValue({ count: 1 });
    expect(await cleanupExpiredSearchTelemetry({ now, batchLimit: 100 }))
      .toEqual({ dryRun: false, deletedClaims: 1, deletedHours: 1 });
    expect(claims.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    expect(claims.deleteMany).toHaveBeenCalledWith({
      where: { digest: { in: ["a".repeat(64)] }, expiresAt: { lte: now } },
    });
    expect(hours.deleteMany).toHaveBeenCalledWith({
      where: { hourStart: { in: [new Date("2026-09-01")] }, expiresAt: { lte: now } },
    });
  });
  it("bounds batch size and does not delete with empty candidate sets", async () => {
    await expect(cleanupExpiredSearchTelemetry({ batchLimit: 9999 }))
      .rejects.toThrow("SEARCH_TELEMETRY_CLEANUP_LIMIT_INVALID");
    claims.findMany.mockResolvedValue([]); hours.findMany.mockResolvedValue([]);
    expect(await cleanupExpiredSearchTelemetry({ now }))
      .toEqual({ dryRun: false, deletedClaims: 0, deletedHours: 0 });
    expect(claims.deleteMany).not.toHaveBeenCalled();
  });
});
