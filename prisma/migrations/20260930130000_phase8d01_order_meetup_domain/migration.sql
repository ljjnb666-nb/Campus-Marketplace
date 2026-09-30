-- Phase 8D-01：General Order Meetup / MeetupPoint / No-show domain foundation
-- 语义冻结（与 Phase 8B/8C 同基调）：
--   * 纯新增 enum / 表 / 索引 / CHECK；不改写任何既有行；零回填。
--   * OrderMeetup = General Order（PRODUCT / SERVICE）线下见面的正式约定
--     authority；Order.meetingLocation 自此只是下单时初始偏好快照。
--   * 一个 Order 同时至多一个 active meetup（partial unique 兜底；只有
--     CANCELLED 允许重新发起；COMPLETED / NO_SHOW_REPORTED 终局不可重开）。
--   * NO_SHOW_REPORTED = 一方报告对方未到场（allegation / dispute trigger），
--     不是平台判责；canonical service 保证其与 OrderDispute OPEN +
--     Order IN_DISPUTE 同事务原子提交。
--   * MeetupPoint 是 campus catalog 参考数据；改名 / 停用（isActive=false）
--     不改写历史 OrderMeetup.locationTextSnapshot（transaction snapshot
--     authority）；行删除走 SET NULL，快照保留。
--   * partial unique / CHECK 不在 Prisma schema 表达（显式 SQL，重放保持
--     无 drift）。

-- CreateEnum
CREATE TYPE "OrderMeetupStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW_REPORTED');

-- CreateTable
CREATE TABLE "MeetupPoint" (
    "id" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locationText" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetupPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderMeetup" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "meetupPointId" TEXT,
    "locationTextSnapshot" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "OrderMeetupStatus" NOT NULL DEFAULT 'PROPOSED',
    "proposedById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "buyerArrivedAt" TIMESTAMP(3),
    "sellerArrivedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "noShowReportedById" TEXT,
    "noShowTargetId" TEXT,
    "noShowReportedAt" TIMESTAMP(3),
    "triggeredDisputeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderMeetup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeetupPoint_campusId_isActive_idx" ON "MeetupPoint"("campusId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "MeetupPoint_campusId_name_key" ON "MeetupPoint"("campusId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "OrderMeetup_triggeredDisputeId_key" ON "OrderMeetup"("triggeredDisputeId");

-- CreateIndex
CREATE INDEX "OrderMeetup_orderId_status_idx" ON "OrderMeetup"("orderId", "status");

-- CreateIndex
CREATE INDEX "OrderMeetup_campusId_status_idx" ON "OrderMeetup"("campusId", "status");

-- AddForeignKey
ALTER TABLE "MeetupPoint" ADD CONSTRAINT "MeetupPoint_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_meetupPointId_fkey" FOREIGN KEY ("meetupPointId") REFERENCES "MeetupPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_noShowReportedById_fkey" FOREIGN KEY ("noShowReportedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_noShowTargetId_fkey" FOREIGN KEY ("noShowTargetId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_triggeredDisputeId_fkey" FOREIGN KEY ("triggeredDisputeId") REFERENCES "OrderDispute"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---
-- Active meetup DB invariant（应用层检查只是提前失败体验，本 partial unique
-- 才是最终兜底）：一个 Order 至多一个 active meetup；只有 CANCELLED 允许
-- 之后创建新 meetup；COMPLETED / NO_SHOW_REPORTED 终局不可重开。
-- ---
CREATE UNIQUE INDEX "OrderMeetup_order_active_key" ON "OrderMeetup"("orderId")
WHERE "status" IN ('PROPOSED', 'CONFIRMED', 'COMPLETED', 'NO_SHOW_REPORTED');

-- ---
-- 状态权威字段一致性 CHECK（canonical service 写入合同的 DB 纵深防御）：
-- CONFIRMED/COMPLETED/NO_SHOW_REPORTED 必须带确认人 + 确认时间（取消后保留
-- 历史字段，故只做单向蕴含，不反向强制 NULL）。
-- ---
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_confirm_authority_check" CHECK (
    NOT ("status" IN ('CONFIRMED', 'COMPLETED', 'NO_SHOW_REPORTED'))
    OR ("confirmedById" IS NOT NULL AND "confirmedAt" IS NOT NULL)
);

-- CANCELLED 必须带取消人 + 取消时间
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_cancel_authority_check" CHECK (
    "status" <> 'CANCELLED'
    OR ("cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL)
);

-- NO_SHOW_REPORTED 必须带完整 allegation provenance（reporter / target / 时间）
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_noshow_authority_check" CHECK (
    "status" <> 'NO_SHOW_REPORTED'
    OR (
        "noShowReportedById" IS NOT NULL
        AND "noShowTargetId" IS NOT NULL
        AND "noShowReportedAt" IS NOT NULL
    )
);

-- COMPLETED 必须双方到场（self-arrival attestation 齐备）
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_completion_arrivals_check" CHECK (
    "status" <> 'COMPLETED'
    OR ("buyerArrivedAt" IS NOT NULL AND "sellerArrivedAt" IS NOT NULL)
);

-- PROPOSED 纯净性：proposal 创建时不可能带任何后续状态字段（无 reopen 路径）
ALTER TABLE "OrderMeetup" ADD CONSTRAINT "OrderMeetup_proposed_purity_check" CHECK (
    "status" <> 'PROPOSED'
    OR (
        "confirmedById" IS NULL
        AND "confirmedAt" IS NULL
        AND "cancelledById" IS NULL
        AND "cancelledAt" IS NULL
        AND "noShowReportedById" IS NULL
        AND "noShowTargetId" IS NULL
        AND "noShowReportedAt" IS NULL
        AND "buyerArrivedAt" IS NULL
        AND "sellerArrivedAt" IS NULL
    )
);
