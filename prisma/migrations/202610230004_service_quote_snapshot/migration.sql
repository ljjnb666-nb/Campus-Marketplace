-- Historical units cannot be inferred from a mutable current listing.
ALTER TABLE "Order" ADD COLUMN "servicePricingUnitSnapshot" "ServicePricingUnit";
