import { prisma } from "@/lib/prisma";

/**
 * Phase 10K-R2a TTL owner. Runs as part of existing storage-cleanup cadence.
 * No search text, identity, campus or device data is retained in either table.
 * Bounded batches, fresh expiry predicates and retry-safe deletion.
 */
export async function cleanupExpiredSearchTelemetry(options: {
  now?: Date; dryRun?: boolean; batchLimit?: number;
} = {}): Promise<{ dryRun: boolean; deletedClaims: number; deletedHours: number }> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const batchLimit = options.batchLimit ?? 500;
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 2000) {
    throw new Error("SEARCH_TELEMETRY_CLEANUP_LIMIT_INVALID");
  }
  const where = { expiresAt: { lte: now } };
  if (dryRun) {
    const [deletedClaims, deletedHours] = await Promise.all([
      prisma.searchTelemetryClaim.count({ where }),
      prisma.searchTelemetryHour.count({ where }),
    ]);
    return { dryRun, deletedClaims, deletedHours };
  }
  const [claims, hours] = await Promise.all([
    prisma.searchTelemetryClaim.findMany({
      where, select: { digest: true },
      orderBy: { expiresAt: "asc" }, take: batchLimit,
    }),
    prisma.searchTelemetryHour.findMany({
      where, select: { hourStart: true },
      orderBy: { expiresAt: "asc" }, take: batchLimit,
    }),
  ]);
  const [claimsDeleted, hoursDeleted] = await Promise.all([
    claims.length
      ? prisma.searchTelemetryClaim.deleteMany({
          where: { digest: { in: claims.map(c => c.digest) }, ...where },
        })
      : Promise.resolve({ count: 0 }),
    hours.length
      ? prisma.searchTelemetryHour.deleteMany({
          where: { hourStart: { in: hours.map(h => h.hourStart) }, ...where },
        })
      : Promise.resolve({ count: 0 }),
  ]);
  return {
    dryRun,
    deletedClaims: claimsDeleted.count,
    deletedHours: hoursDeleted.count,
  };
}
