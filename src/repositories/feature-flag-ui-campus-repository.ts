import { prisma } from "@/lib/prisma";
import type { FeatureFlagUiAccess } from "@/lib/feature-flags/feature-flag-ui-access";

/** Display metadata only. Callers MUST authorize the target scope first. */
export async function findFlagUiCampusById(campusId: string) {
  return prisma.campus.findUnique({
    where: { id: campusId },
    select: { id: true, name: true },
  });
}

/** Bounded campus picker. No cross-campus records for scoped operators. */
export async function listFlagUiCampuses(access: FeatureFlagUiAccess) {
  return prisma.campus.findMany({
    where: access.global ? {} : { id: { in: access.campusIds } },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 100,
  });
}
