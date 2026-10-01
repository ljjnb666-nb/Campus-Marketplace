-- Phase 8E：Review Integrity——双盲评价发布模型（Review + RentalReview）。
--
-- 语义（冻结，canonical visibility 见 src/lib/reviews/review-integrity.ts）：
--   blindUntil  = 本订单统一 reviewDeadline（completedAt + REVIEW_WINDOW 7d）；
--                 提交资格 now < blindUntil；单方评价到期后 query-time 自动可见
--                 （无 scheduler 前提）。
--   publishedAt = 双方均提交时的提前公开时间（NULL = 尚未提前公开）。
--   publication 条件：publishedAt != null OR blindUntil <= now；
--   完整公开条件另需 Order/RentalOrder COMPLETED + 无 active dispute
--   （查询层 policy，不在 DB 强制）。
--
-- 历史数据（冻结）：既有评价必须保持迁移前可见性——backfill
--   blindUntil = publishedAt = createdAt（立即可见），禁止历史评价因迁移消失。
--   迁移步骤：nullable add → backfill → assert no null → NOT NULL → CHECK。
--
-- CHECK（§30）：rating/overallRating ∈ [1,5]；authorId <> targetUserId；
--   RentalReview 全部 optional 维度 IS NULL OR ∈ [1,5]。加约束前先断言
--   历史数据零违反（发现违反 → migration 失败并报告，禁止偷偷改写历史）。

-- ============================================================
-- 1) Review：nullable add + backfill + NOT NULL
-- ============================================================
ALTER TABLE "Review" ADD COLUMN "blindUntil" TIMESTAMP(3);
ALTER TABLE "Review" ADD COLUMN "publishedAt" TIMESTAMP(3);

-- 历史评价 = 迁移前口径（提交即公开）：publishedAt = createdAt 保证立即可见；
-- blindUntil = createdAt 仅是发布 metadata 的历史占位（永不作为提交窗口使用）
UPDATE "Review" SET "blindUntil" = "createdAt", "publishedAt" = "createdAt";

DO $$
DECLARE violations int;
BEGIN
  SELECT count(*) INTO violations FROM "Review" WHERE "blindUntil" IS NULL;
  IF violations > 0 THEN
    RAISE EXCEPTION 'phase8e backfill check failed: % "Review" rows still have NULL blindUntil', violations;
  END IF;
END $$;

ALTER TABLE "Review" ALTER COLUMN "blindUntil" SET NOT NULL;

-- ============================================================
-- 2) RentalReview：nullable add + backfill + NOT NULL
-- ============================================================
ALTER TABLE "RentalReview" ADD COLUMN "blindUntil" TIMESTAMP(3);
ALTER TABLE "RentalReview" ADD COLUMN "publishedAt" TIMESTAMP(3);

UPDATE "RentalReview" SET "blindUntil" = "createdAt", "publishedAt" = "createdAt";

DO $$
DECLARE violations int;
BEGIN
  SELECT count(*) INTO violations FROM "RentalReview" WHERE "blindUntil" IS NULL;
  IF violations > 0 THEN
    RAISE EXCEPTION 'phase8e backfill check failed: % "RentalReview" rows still have NULL blindUntil', violations;
  END IF;
END $$;

ALTER TABLE "RentalReview" ALTER COLUMN "blindUntil" SET NOT NULL;

-- ============================================================
-- 3) Integrity CHECK（历史数据断言 → 约束；违反即失败报告，不改写历史）
-- ============================================================
DO $$
DECLARE review_violations int;
BEGIN
  SELECT count(*) INTO review_violations
  FROM "Review"
  WHERE rating < 1 OR rating > 5 OR "authorId" = "targetUserId";
  IF review_violations > 0 THEN
    RAISE EXCEPTION 'phase8e integrity pre-check failed: % "Review" rows violate rating range / self-review constraint', review_violations;
  END IF;
END $$;

DO $$
DECLARE rental_review_violations int;
BEGIN
  SELECT count(*) INTO rental_review_violations
  FROM "RentalReview"
  WHERE "overallRating" < 1 OR "overallRating" > 5 OR "authorId" = "targetUserId"
     OR ("itemMatchDesc"       IS NOT NULL AND ("itemMatchDesc"       < 1 OR "itemMatchDesc"       > 5))
     OR ("itemWorksWell"       IS NOT NULL AND ("itemWorksWell"       < 1 OR "itemWorksWell"       > 5))
     OR ("ownerResponsive"     IS NOT NULL AND ("ownerResponsive"     < 1 OR "ownerResponsive"     > 5))
     OR ("pickupEasy"          IS NOT NULL AND ("pickupEasy"          < 1 OR "pickupEasy"          > 5))
     OR ("attitudeFriendly"    IS NOT NULL AND ("attitudeFriendly"    < 1 OR "attitudeFriendly"    > 5))
     OR ("returnedOnTime"      IS NOT NULL AND ("returnedOnTime"      < 1 OR "returnedOnTime"      > 5))
     OR ("itemWellKept"        IS NOT NULL AND ("itemWellKept"        < 1 OR "itemWellKept"        > 5))
     OR ("accessoriesComplete" IS NOT NULL AND ("accessoriesComplete" < 1 OR "accessoriesComplete" > 5))
     OR ("goodCommunication"   IS NOT NULL AND ("goodCommunication"   < 1 OR "goodCommunication"   > 5))
     OR ("reliable"            IS NOT NULL AND ("reliable"            < 1 OR "reliable"            > 5));
  IF rental_review_violations > 0 THEN
    RAISE EXCEPTION 'phase8e integrity pre-check failed: % "RentalReview" rows violate rating range / self-review constraint', rental_review_violations;
  END IF;
END $$;

ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range_check" CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE "Review" ADD CONSTRAINT "Review_no_self_review_check" CHECK ("authorId" <> "targetUserId");

ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_overall_rating_range_check" CHECK ("overallRating" BETWEEN 1 AND 5);
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_no_self_review_check" CHECK ("authorId" <> "targetUserId");
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_itemMatchDesc_range_check" CHECK ("itemMatchDesc" IS NULL OR "itemMatchDesc" BETWEEN 1 AND 5);
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_itemWorksWell_range_check" CHECK ("itemWorksWell" IS NULL OR "itemWorksWell" BETWEEN 1 AND 5);
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_ownerResponsive_range_check" CHECK ("ownerResponsive" IS NULL OR "ownerResponsive" BETWEEN 1 AND 5);
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_pickupEasy_range_check" CHECK ("pickupEasy" IS NULL OR "pickupEasy" BETWEEN 1 AND 5);
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_attitudeFriendly_range_check" CHECK ("attitudeFriendly" IS NULL OR "attitudeFriendly" BETWEEN 1 AND 5);
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_returnedOnTime_range_check" CHECK ("returnedOnTime" IS NULL OR "returnedOnTime" BETWEEN 1 AND 5);
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_itemWellKept_range_check" CHECK ("itemWellKept" IS NULL OR "itemWellKept" BETWEEN 1 AND 5);
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_accessoriesComplete_range_check" CHECK ("accessoriesComplete" IS NULL OR "accessoriesComplete" BETWEEN 1 AND 5);
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_goodCommunication_range_check" CHECK ("goodCommunication" IS NULL OR "goodCommunication" BETWEEN 1 AND 5);
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_reliable_range_check" CHECK ("reliable" IS NULL OR "reliable" BETWEEN 1 AND 5);
