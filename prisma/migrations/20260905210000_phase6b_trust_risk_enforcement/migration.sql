-- CreateEnum
CREATE TYPE "RiskStateLevel" AS ENUM ('NORMAL', 'WATCH', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "RiskFlagKind" AS ENUM ('REPORT_SUBMITTED', 'REPORT_CONFIRMED', 'RENTAL_DISPUTE_OPENED', 'MANUAL_FLAG');

-- CreateEnum
CREATE TYPE "RiskFlagSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "RiskFlagStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "EnforcementActionType" AS ENUM ('MARKETPLACE_RESTRICT', 'MARKETPLACE_RESTORE', 'ACCOUNT_SUSPEND', 'ACCOUNT_REINSTATE', 'MEMBERSHIP_SUSPEND', 'MEMBERSHIP_REINSTATE');

-- CreateEnum
CREATE TYPE "EnforcementReasonCode" AS ENUM ('FRAUD_CONFIRMED', 'HARASSMENT_CONFIRMED', 'ACCOUNT_SECURITY', 'POLICY_VIOLATION', 'MANUAL_REVIEW', 'FALSE_POSITIVE_CORRECTION', 'OTHER');

-- CreateTable
CREATE TABLE "RiskState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campusId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "state" "RiskStateLevel" NOT NULL DEFAULT 'NORMAL',
    "reasonCode" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskFlag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campusId" TEXT,
    "kind" "RiskFlagKind" NOT NULL,
    "severity" "RiskFlagSeverity" NOT NULL DEFAULT 'INFO',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "reasonCode" TEXT,
    "note" TEXT,
    "status" "RiskFlagStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnforcementAction" (
    "id" TEXT NOT NULL,
    "type" "EnforcementActionType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "campusId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "reasonCode" "EnforcementReasonCode" NOT NULL,
    "note" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "resultState" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnforcementAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiskState_userId_state_idx" ON "RiskState"("userId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "RiskState_userId_scopeKey_key" ON "RiskState"("userId", "scopeKey");

-- CreateIndex
CREATE INDEX "RiskFlag_userId_status_idx" ON "RiskFlag"("userId", "status");

-- CreateIndex
CREATE INDEX "RiskFlag_status_severity_idx" ON "RiskFlag"("status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "RiskFlag_kind_sourceType_sourceId_key" ON "RiskFlag"("kind", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "EnforcementAction_targetId_createdAt_idx" ON "EnforcementAction"("targetId", "createdAt");

-- CreateIndex
CREATE INDEX "EnforcementAction_actorId_createdAt_idx" ON "EnforcementAction"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "EnforcementAction_type_createdAt_idx" ON "EnforcementAction"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "RiskState" ADD CONSTRAINT "RiskState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskState" ADD CONSTRAINT "RiskState_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskFlag" ADD CONSTRAINT "RiskFlag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskFlag" ADD CONSTRAINT "RiskFlag_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnforcementAction" ADD CONSTRAINT "EnforcementAction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnforcementAction" ADD CONSTRAINT "EnforcementAction_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnforcementAction" ADD CONSTRAINT "EnforcementAction_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Phase 6B 回填说明（#48 truthful default）：
-- 本迁移不写入任何 RiskState 行。无行 = NORMAL 是真实默认态——
-- 绝不从历史 creditScore 或未经裁决的举报推断风险状态；
-- 仅显式 enforcement 决策（restrict/suspend service）才会创建行。
-- 既有 User.status=SUSPENDED 属账号硬停用（account-level），不映射为 risk state。
