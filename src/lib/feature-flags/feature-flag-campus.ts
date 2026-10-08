import type { Prisma } from "@prisma/client";

import { NewActivityDisabledError } from "@/lib/feature-flags/feature-flag-guard";

/**
 * Resolve new-conversation/message campus from the canonical linked resource.
 *
 * Never trust form data, sender's current campus, or a stale page snapshot:
 * Order and RentalOrder have no authoritative campusId of their own. The
 * listing/errand that created their obligation remains the provenance.
 */
export type ConversationCampusRefs = {
  productId?: string | null;
  errandTaskId?: string | null;
  serviceListingId?: string | null;
  rentalListingId?: string | null;
  orderId?: string | null;
  rentalOrderId?: string | null;
};

const LINK_KEYS: readonly (keyof ConversationCampusRefs)[] = [
  "productId", "errandTaskId", "serviceListingId",
  "rentalListingId", "orderId", "rentalOrderId",
];

export async function resolveConversationCampusIdTx(
  tx: Prisma.TransactionClient,
  refs: ConversationCampusRefs,
): Promise<string> {
  const selected = LINK_KEYS.filter((key) => typeof refs[key] === "string" && !!refs[key]);
  if (selected.length !== 1) throw new NewActivityDisabledError();

  const key = selected[0]!;
  const id = refs[key]!;
  let campusId: string | null = null;

  switch (key) {
    case "productId":
      campusId = (await tx.product.findUnique({
        where: { id }, select: { campusId: true },
      }))?.campusId ?? null;
      break;
    case "errandTaskId":
      campusId = (await tx.errandTask.findUnique({
        where: { id }, select: { campusId: true },
      }))?.campusId ?? null;
      break;
    case "serviceListingId":
      campusId = (await tx.serviceListing.findUnique({
        where: { id }, select: { campusId: true },
      }))?.campusId ?? null;
      break;
    case "rentalListingId":
      campusId = (await tx.rentalListing.findUnique({
        where: { id }, select: { campusId: true },
      }))?.campusId ?? null;
      break;
    case "orderId": {
      const order = await tx.order.findUnique({
        where: { id },
        select: {
          product: { select: { campusId: true } },
          errandTask: { select: { campusId: true } },
          serviceListing: { select: { campusId: true } },
        },
      });
      const campuses = [
        order?.product?.campusId,
        order?.errandTask?.campusId,
        order?.serviceListing?.campusId,
      ].filter((v): v is string => typeof v === "string" && !!v);
      if (campuses.length === 1) campusId = campuses[0]!;
      break;
    }
    case "rentalOrderId":
      campusId = (await tx.rentalOrder.findUnique({
        where: { id },
        select: { rentalListing: { select: { campusId: true } } },
      }))?.rentalListing?.campusId ?? null;
      break;
  }

  if (!campusId) throw new NewActivityDisabledError();
  return campusId;
}
