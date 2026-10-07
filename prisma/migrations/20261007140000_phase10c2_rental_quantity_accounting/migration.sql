-- Phase 10C-2 — repair legacy multi-quantity rental accounting.
--
-- Before this release RentalOrder.quantity participated in inventory capacity
-- but rentalAmount/extension additionalFee were calculated as single-unit value.
-- The UI did not expose quantity, but the server action accepted it, so forged
-- or future clients could create quantity > 1 rows with under-recorded value.
--
-- Every row existing before this migration uses the legacy pricing algorithm.
-- Repair once:
--   correct rentalAmount = legacy per-unit accumulated rentalAmount * quantity
--   correct finalAmount  = legacy finalAmount + legacy rentalAmount * (quantity-1)
-- Deposit principal is intentionally NOT multiplied: its per-order/per-unit
-- semantics are not frozen here and it is excluded from CTV.
--
-- Fail closed on impossible/overflowing history instead of silently truncating.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "RentalOrder"
    WHERE quantity < 1
  ) THEN
    RAISE EXCEPTION 'PHASE10C2_INVALID_RENTAL_QUANTITY_HISTORY';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "RentalOrder"
    WHERE quantity > 1
      AND (
        "rentalAmount" * quantity > 99999999.99
        OR "finalAmount" + ("rentalAmount" * (quantity - 1)) > 99999999.99
      )
  ) THEN
    RAISE EXCEPTION 'PHASE10C2_RENTAL_VALUE_REPAIR_OVERFLOW';
  END IF;
END
$$;

UPDATE "RentalOrder"
SET
  "finalAmount" = "finalAmount" + ("rentalAmount" * (quantity - 1)),
  "rentalAmount" = "rentalAmount" * quantity
WHERE quantity > 1;

ALTER TABLE "RentalOrder"
ADD CONSTRAINT "RentalOrder_quantity_positive_chk"
CHECK (quantity >= 1);
