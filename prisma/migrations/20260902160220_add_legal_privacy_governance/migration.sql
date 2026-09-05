-- CreateEnum
CREATE TYPE "LegalDocumentType" AS ENUM ('TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'PLATFORM_RULES', 'PROHIBITED_TRANSACTIONS');

-- CreateEnum
CREATE TYPE "LegalDocumentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "PolicyAcceptanceSource" AS ENUM ('SIGNUP', 'RECONSENT', 'SETTINGS');

-- CreateEnum
CREATE TYPE "PrivacyRequestType" AS ENUM ('DATA_EXPORT', 'ACCOUNT_DELETION');

-- CreateEnum
CREATE TYPE "PrivacyRequestStatus" AS ENUM ('REQUESTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DataHoldType" AS ENUM ('LEGAL', 'DISPUTE');

-- CreateEnum
CREATE TYPE "DataHoldStatus" AS ENUM ('ACTIVE', 'RELEASED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "erasedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LegalDocument" (
    "id" TEXT NOT NULL,
    "type" "LegalDocumentType" NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "LegalDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "requiresAcceptance" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentType" "LegalDocumentType" NOT NULL,
    "documentVersion" INTEGER NOT NULL,
    "documentHash" TEXT NOT NULL,
    "source" "PolicyAcceptanceSource" NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PrivacyRequestType" NOT NULL,
    "status" "PrivacyRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "reasonCode" TEXT,
    "handledNote" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataHold" (
    "id" TEXT NOT NULL,
    "type" "DataHoldType" NOT NULL,
    "status" "DataHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "scope" TEXT NOT NULL DEFAULT 'USER_ACCOUNT',
    "subjectType" TEXT NOT NULL DEFAULT 'USER',
    "subjectId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,

    CONSTRAINT "DataHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalDocument_type_status_effectiveAt_idx" ON "LegalDocument"("type", "status", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "LegalDocument_type_version_key" ON "LegalDocument"("type", "version");

-- CreateIndex
CREATE INDEX "PolicyAcceptance_userId_acceptedAt_idx" ON "PolicyAcceptance"("userId", "acceptedAt");

-- CreateIndex
CREATE INDEX "PolicyAcceptance_documentId_idx" ON "PolicyAcceptance"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyAcceptance_userId_documentId_key" ON "PolicyAcceptance"("userId", "documentId");

-- CreateIndex
CREATE INDEX "PrivacyRequest_userId_type_status_idx" ON "PrivacyRequest"("userId", "type", "status");

-- CreateIndex
CREATE INDEX "PrivacyRequest_status_requestedAt_idx" ON "PrivacyRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "DataHold_subjectType_subjectId_status_idx" ON "DataHold"("subjectType", "subjectId", "status");

-- CreateIndex
CREATE INDEX "DataHold_status_type_createdAt_idx" ON "DataHold"("status", "type", "createdAt");

-- AddForeignKey
ALTER TABLE "PolicyAcceptance" ADD CONSTRAINT "PolicyAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyAcceptance" ADD CONSTRAINT "PolicyAcceptance_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "LegalDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyRequest" ADD CONSTRAINT "PrivacyRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 5 数据库级不变量：同一用户同时至多一个 active（REQUESTED / IN_PROGRESS /
-- BLOCKED）账号注销请求，防止重复请求绕过应用层幂等检查。COMPLETED/CANCELLED/
-- REJECTED 不占用该约束。
CREATE UNIQUE INDEX "PrivacyRequest_userId_active_deletion_key"
ON "PrivacyRequest"("userId")
WHERE "type" = 'ACCOUNT_DELETION' AND "status" IN ('REQUESTED', 'IN_PROGRESS', 'BLOCKED');
