-- A separate migration commits the new enum value before it is used.
-- No offline order has a gateway receipt: normalize misleading legacy refund
-- labels, preserving all original monetary values and agreement records.
UPDATE "RentalOrder"
SET "depositStatus" = CASE WHEN "depositAmount" > 0
    THEN 'OFFLINE_UNVERIFIED'::"DepositStatus"
    ELSE 'NOT_REQUIRED'::"DepositStatus" END
WHERE "paymentStatus" IN ('OFFLINE_PENDING', 'UNPAID');
