import { listingModerationPublicFilter } from "@/lib/moderation/listing-moderation-query";
import { prisma } from "@/lib/prisma";

export type ActiveSupplySnapshot = {
  campusId: string;
  capturedAt: Date;
  authority: "DOMAIN_CURRENT_STATE";
  productListings: number;
  serviceListings: number;
  rentalListings: number;
  totalListings: number;
};

/**
 * Phase 10C-1 point-in-time supply snapshot。
 *
 * "active supply" = 当前 PUBLIC exposure 且未软删/未治理隐藏的供给 listing：
 * PRODUCT ACTIVE、SERVICE ACTIVE、RENTAL AVAILABLE(+availableQuantity>0)。
 * ERRAND 是需求域，不混进 supply denominator。
 */
export async function getActiveSupplySnapshot(
  campusId: string,
  options?: { now?: Date },
): Promise<ActiveSupplySnapshot> {
  if (!campusId) {
    throw new Error("LIQUIDITY_CAMPUS_ID_REQUIRED");
  }

  const moderation = listingModerationPublicFilter();
  const [productListings, serviceListings, rentalListings] = await Promise.all([
    prisma.product.count({
      where: {
        campusId,
        deletedAt: null,
        status: "ACTIVE",
        ...moderation,
      },
    }),
    prisma.serviceListing.count({
      where: {
        campusId,
        deletedAt: null,
        status: "ACTIVE",
        ...moderation,
      },
    }),
    prisma.rentalListing.count({
      where: {
        campusId,
        deletedAt: null,
        status: "AVAILABLE",
        availableQuantity: { gt: 0 },
        ...moderation,
      },
    }),
  ]);

  return {
    campusId,
    capturedAt: options?.now ?? new Date(),
    authority: "DOMAIN_CURRENT_STATE",
    productListings,
    serviceListings,
    rentalListings,
    totalListings: productListings + serviceListings + rentalListings,
  };
}
