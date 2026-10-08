import { prisma } from "@/lib/prisma";
import type { RuntimeConfigUiAccess } from "@/lib/runtime-config/runtime-config-ui-access";

/** Caller must authorize the scope BEFORE querying its display metadata. */
export async function findRuntimeConfigUiCampusById(campusId: string) {
  return prisma.campus.findUnique({ where: { id: campusId }, select: { id: true, name: true } });
}

export async function listRuntimeConfigUiCampuses(access: RuntimeConfigUiAccess) {
  return prisma.campus.findMany({
    where: access.global ? {} : { id: { in: access.campusIds } },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 100,
  });
}
