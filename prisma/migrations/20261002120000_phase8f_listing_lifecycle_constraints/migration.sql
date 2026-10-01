-- Phase 8F（LISTING LIFECYCLE NORMALIZATION）：DB structural constraints。
--
-- 冻结合同（directive §35/§36）——四类 listing 的 canonical 可持久化状态：
--   Product        ∈ (ACTIVE, RESERVED, SOLD, OFFLINE)        禁止 PAUSED
--   ServiceListing ∈ (ACTIVE, PAUSED, OFFLINE)                禁止 RESERVED / SOLD
--   RentalListing  ∈ (AVAILABLE, PAUSED, OFFLINE)             禁止 legacy：
--                  FULLY_BOOKED / PENDING_REVIEW / BANNED（enum 值保留，生产写路径
--                  NEVER WRITE；FULLY_BOOKED 不是 canonical availability authority）
--   ErrandTask     不加 status CHECK（workflow 状态机权威在 errand-lifecycle.ts，
--                  8F 不重写 Errand state machine）
--
-- deletedAt 单调性结构约束（§36）：
--   Product / ServiceListing / RentalListing：deletedAt IS NULL OR status = 'OFFLINE'
--   ErrandTask：deletedAt IS NULL OR status = 'CANCELLED'
--   （幂等于既有 canonical delete 写法：软删除 = status OFFLINE/CANCELLED + deletedAt；
--     与账号注销 privileged path 兼容——erasure 只写 status 不写 deletedAt，
--     OFFLINE/CANCELLED 两个目标值天然满足本约束。）
--
-- Prisma enum 本体不做任何修改（drift=NONE 不变量）。

-- ── §37 dirty-data preflight：显式 precondition assertion，命中即整体失败 ──
-- 禁止静默 normalize 历史；除非能从现有 immutable authority 100% 确定恢复值，
-- 否则不自动重写。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Product"
    WHERE status::text NOT IN ('ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE')
  ) THEN
    RAISE EXCEPTION 'PHASE_8F_DIRTY_DATA: Product rows with status outside canonical set (ACTIVE/RESERVED/SOLD/OFFLINE), e.g. PAUSED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ServiceListing"
    WHERE status::text NOT IN ('ACTIVE', 'PAUSED', 'OFFLINE')
  ) THEN
    RAISE EXCEPTION 'PHASE_8F_DIRTY_DATA: ServiceListing rows with Product-only statuses (RESERVED/SOLD) or other non-canonical values';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "RentalListing"
    WHERE status::text IN ('FULLY_BOOKED', 'PENDING_REVIEW', 'BANNED')
  ) THEN
    RAISE EXCEPTION 'PHASE_8F_DIRTY_DATA: RentalListing rows in legacy statuses (FULLY_BOOKED/PENDING_REVIEW/BANNED)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Product"
    WHERE "deletedAt" IS NOT NULL AND status::text <> 'OFFLINE'
  ) THEN
    RAISE EXCEPTION 'PHASE_8F_DIRTY_DATA: soft-deleted Product rows whose status is not OFFLINE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ServiceListing"
    WHERE "deletedAt" IS NOT NULL AND status::text <> 'OFFLINE'
  ) THEN
    RAISE EXCEPTION 'PHASE_8F_DIRTY_DATA: soft-deleted ServiceListing rows whose status is not OFFLINE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "RentalListing"
    WHERE "deletedAt" IS NOT NULL AND status::text <> 'OFFLINE'
  ) THEN
    RAISE EXCEPTION 'PHASE_8F_DIRTY_DATA: soft-deleted RentalListing rows whose status is not OFFLINE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ErrandTask"
    WHERE "deletedAt" IS NOT NULL AND status::text <> 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'PHASE_8F_DIRTY_DATA: soft-deleted ErrandTask rows whose status is not CANCELLED';
  END IF;
END
$$;

-- ── status domain CHECKs ──
ALTER TABLE "Product"
  ADD CONSTRAINT "product_lifecycle_status_domain_chk"
  CHECK (status::text IN ('ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE'));

ALTER TABLE "ServiceListing"
  ADD CONSTRAINT "service_lifecycle_status_domain_chk"
  CHECK (status::text IN ('ACTIVE', 'PAUSED', 'OFFLINE'));

ALTER TABLE "RentalListing"
  ADD CONSTRAINT "rental_lifecycle_status_domain_chk"
  CHECK (status::text IN ('AVAILABLE', 'PAUSED', 'OFFLINE'));

-- ── deletedAt monotonicity CHECKs ──
ALTER TABLE "Product"
  ADD CONSTRAINT "product_deleted_status_consistency_chk"
  CHECK ("deletedAt" IS NULL OR status::text = 'OFFLINE');

ALTER TABLE "ServiceListing"
  ADD CONSTRAINT "service_deleted_status_consistency_chk"
  CHECK ("deletedAt" IS NULL OR status::text = 'OFFLINE');

ALTER TABLE "RentalListing"
  ADD CONSTRAINT "rental_deleted_status_consistency_chk"
  CHECK ("deletedAt" IS NULL OR status::text = 'OFFLINE');

ALTER TABLE "ErrandTask"
  ADD CONSTRAINT "errand_deleted_status_consistency_chk"
  CHECK ("deletedAt" IS NULL OR status::text = 'CANCELLED');
