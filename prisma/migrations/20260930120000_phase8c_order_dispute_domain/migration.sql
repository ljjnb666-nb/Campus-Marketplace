-- Phase 8C-01：General OrderDispute domain foundation（PRODUCT / SERVICE /
-- ERRAND 交易纠纷域）。
--
-- 语义（冻结）：
--   OrderStatus + IN_DISPUTE（订单暂时冻结在纠纷治理中；dispute 域是唯一出口）
--                + CLOSED（经纠纷治理终局关闭；不复用 CANCELLED 伪装用户取消）
--   ErrandTaskStatus + CLOSED（与 Order.CLOSED 成 canonical terminal pair；
--                DISPUTED 保持 active obligation 语义不变）
--   OrderDisputeStatus = OPEN | IN_REVIEW | RESOLVED | CLOSED（与
--                RentalDisputeStatus 语义一致但独立 enum，不跨域复用）
--   campus scope immutable snapshot：campusId 非空 + scopeKey = CAMPUS:<campusId>
--                （DB CHECK 冻结；禁止 UNSCOPED）
--   active dispute 唯一性：同一 Order 至多一个 OPEN/IN_REVIEW dispute
--                （partial unique index DB 强制；应用层检查仅前置优化）
--
-- 安全性（冻结）：
--   - PostgreSQL enum 只追加（IN_DISPUTE / CLOSED），不 drop/recreate/reorder
--     既有值。
--   - 新表无历史数据：NO historical dispute backfill；Report / SupportTicket /
--     RentalDispute 不得迁移成 OrderDispute。
--   - 既有 normal lifecycle 不受影响：新 OrderStatus 值不在任何 transition
--     allowlist 中（普通路径自然拒绝，只有 dispute domain 能离开 IN_DISPUTE）。
--   - DataHold / privacy 由应用层（privacy-data-registry + account-erasure）
--     覆盖，本 migration 无数据回填。

-- ============================================================
-- 1) Enum 追加（只追加，不改历史值）
-- ============================================================
ALTER TYPE "OrderStatus" ADD VALUE 'IN_DISPUTE';
ALTER TYPE "OrderStatus" ADD VALUE 'CLOSED';
ALTER TYPE "ErrandTaskStatus" ADD VALUE 'CLOSED';

CREATE TYPE "OrderDisputeStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED');

-- ============================================================
-- 2) OrderDispute 表
-- ============================================================
CREATE TABLE "OrderDispute" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidencePhotos" TEXT[] NOT NULL,
    "status" "OrderDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "campusId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "openedFromOrderStatus" "OrderStatus" NOT NULL,
    "openedFromErrandStatus" "ErrandTaskStatus",
    "assignedToId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "resolutionCode" "DisputeResolutionCode",
    "resolutionAction" "DisputeResolutionAction",
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderDispute_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- 3) Foreign keys
-- ============================================================
CREATE INDEX "OrderDispute_orderId_idx" ON "OrderDispute"("orderId");
CREATE INDEX "OrderDispute_status_createdAt_idx" ON "OrderDispute"("status", "createdAt");
CREATE INDEX "OrderDispute_dueAt_createdAt_id_idx" ON "OrderDispute"("dueAt", "createdAt", "id");
CREATE INDEX "OrderDispute_campusId_scopeKey_idx" ON "OrderDispute"("campusId", "scopeKey");
CREATE INDEX "OrderDispute_assignedToId_idx" ON "OrderDispute"("assignedToId");

-- order：dispute 行随 order 硬删除级联（RentalDispute 同款；应用内 Order
-- 无硬删除路径，测试 cleanup 依赖级联）
ALTER TABLE "OrderDispute" ADD CONSTRAINT "OrderDispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- initiator：Restrict（governance provenance 不随账户硬删除丢失）
ALTER TABLE "OrderDispute" ADD CONSTRAINT "OrderDispute_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- campus scope：Restrict（scope 快照 provenance）
ALTER TABLE "OrderDispute" ADD CONSTRAINT "OrderDispute_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 运营领用：SetNull（领用人引用消失时 dispute 仍在；RentalDispute 同款默认）
ALTER TABLE "OrderDispute" ADD CONSTRAINT "OrderDispute_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 4) Active dispute partial unique（DB invariant：同一 Order 至多一个
--    OPEN / IN_REVIEW dispute；应用层检查不是本 invariant 的替代）
-- ============================================================
CREATE UNIQUE INDEX "OrderDispute_order_active_key" ON "OrderDispute"("orderId")
WHERE "status" IN ('OPEN', 'IN_REVIEW');

-- ============================================================
-- 5) Scope pair CHECK（campusId 恒非空 + scopeKey 精确派生；禁止 UNSCOPED）
-- ============================================================
ALTER TABLE "OrderDispute" ADD CONSTRAINT "OrderDispute_scope_pair_check" CHECK (
  "scopeKey" = 'CAMPUS:' || "campusId"
);
