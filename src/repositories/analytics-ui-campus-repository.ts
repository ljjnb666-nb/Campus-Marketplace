import { prisma } from "@/lib/prisma";
import type { AnalyticsReadAccess } from "@/lib/analytics/analytics-read-access";

/** Display-only metadata. Caller verifies membership scope BEFORE invocation. */
export async function listAnalyticsUiCampuses(access: AnalyticsReadAccess) {
  return prisma.campus.findMany({
    where: access.global ? {} : { id: { in: access.campusIds } },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 100,
  });
}

export async function findAnalyticsUiCampusById(campusId: string) {
  return prisma.campus.findUnique({
    where: { id: campusId },
    select: { id: true, name: true },
  });
}
