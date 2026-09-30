-- Phase 8B-01：PRODUCT PENDING reservation deadline & synchronous expiry。
--
-- 语义（冻结）：
--   productReservationExpiresAt  = seller 确认截止（createdAt + 24h TTL；
--                                  仅新创建 PRODUCT PENDING 写入）。
--   (productReservationResolvedAt, productReservationResolution)
--                                = 关闭二元组（成对写入/成对 NULL）：
--                                  ACCEPTED / CANCELLED（期限内用户取消）/
--                                  EXPIRED（超时系统关闭，Order → CANCELLED）。
--   resolution ≠ Order status：EXPIRED 描述「为什么 PENDING reservation 被
--   关闭」，业务结果仍是 Order CANCELLED——禁止新增 OrderStatus.EXPIRED。
--
-- 历史（禁止伪造业务事实）：
--   仅 PRODUCT + PENDING + 无 deadline 的行 backfill createdAt + 24h；
--   历史 ACCEPTED/CANCELLED/COMPLETED 的 resolution/resolvedAt 保持 NULL
--   （legacy pre-8B），禁止用 updatedAt 伪造 acceptance/cancel 时间。
--   backfill 不执行 expiry、不改 Order/Product status——历史过期预留由
--   同步 expire operation 或 Phase 9 scheduler materialize。

-- CreateTable enum
CREATE TYPE "ProductReservationResolution" AS ENUM ('ACCEPTED', 'CANCELLED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "productReservationExpiresAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN     "productReservationResolvedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN     "productReservationResolution" "ProductReservationResolution";

-- Backfill（仅 PRODUCT PENDING 且无 deadline 的行；先于约束与索引）
UPDATE "Order"
SET "productReservationExpiresAt" = "createdAt" + INTERVAL '24 hours'
WHERE "type" = 'PRODUCT'::"OrderType"
  AND "status" = 'PENDING'::"OrderStatus"
  AND "productReservationExpiresAt" IS NULL;

-- CreateIndex（Phase 9 scheduler 发现 PRODUCT PENDING expiresAt <= now）
CREATE INDEX "Order_type_status_productReservationExpiresAt_idx" ON "Order"("type", "status", "productReservationExpiresAt");

-- 数据库安全约束（Prisma datamodel 不可表达 CHECK，diff 引擎忽略之，
-- 与 migration history 重放一致，无 drift）：

-- 1) Pair consistency：resolvedAt 与 resolution 必须成对（NULL IFF NULL）
ALTER TABLE "Order" ADD CONSTRAINT "Order_reservation_pair_consistency_check" CHECK (
  (
    "productReservationResolvedAt" IS NULL
    AND "productReservationResolution" IS NULL
  )
  OR (
    "productReservationResolvedAt" IS NOT NULL
    AND "productReservationResolution" IS NOT NULL
  )
);

-- 2) Non-product isolation：type != PRODUCT → 三字段全部 NULL
--    （蕴含式：type = PRODUCT 恒真放行；非 PRODUCT 行必须全 NULL）
ALTER TABLE "Order" ADD CONSTRAINT "Order_non_product_reservation_isolation_check" CHECK (
  "type" = 'PRODUCT'::"OrderType"
  OR (
    "productReservationExpiresAt" IS NULL
    AND "productReservationResolvedAt" IS NULL
    AND "productReservationResolution" IS NULL
  )
);

-- 3) Pending Product deadline：PRODUCT PENDING 必须有 deadline
ALTER TABLE "Order" ADD CONSTRAINT "Order_product_pending_deadline_check" CHECK (
  NOT (
    "type" = 'PRODUCT'::"OrderType"
    AND "status" = 'PENDING'::"OrderStatus"
  )
  OR "productReservationExpiresAt" IS NOT NULL
);
