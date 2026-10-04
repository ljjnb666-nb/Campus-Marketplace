-- Phase 9C-03 — Async durable privacy data export。
--
-- 语义（冻结）：
--   DataExportArtifact = system-generated derived privacy artifact
--   （1:0..1 PrivacyRequest，requestId UNIQUE = canonical artifact 不变量）。
--   绝不复用 UploadedAsset：不参与 AssetCategory / storage quota / upload
--   lifecycle；artifact 不计入 User.storageUsedBytes（用户导出自身隐私
--   数据绝不被存储 quota 阻断）。
--
--   bucket / objectKey 是内部秘密（STORAGE_METADATA）：只存 DB 与 server
--   storage 层，绝不进入任何 browser-visible surface。objectKey
--   deterministic（requestId → exactly one object key）：durable WRITING
--   anchor 在任何 S3 PUT 之前落库，ambiguous PUT / crash replay 重放安全。
--
--   PrivacyRequest active-DATA_EXPORT 去重：partial unique index 强制
--   "同一用户至多一个 active（REQUESTED / IN_PROGRESS）DATA_EXPORT 请求"
--   ——异步化后双击 / 多 tab / HTTP retry 并发重复创建由 DB 收敛
--   （P2002 → DATA_EXPORT_ALREADY_ACTIVE），绝不用 findFirst+create TOCTOU。
--   终态（COMPLETED / REJECTED / CANCELLED）不占用该约束，用户可重新申请。
--
-- Forward safety：纯新增表 / 索引，无破坏性改写；既有 PrivacyRequest 行
-- 不受影响（新列全在独立新表上，active 去重索引对历史终态行零占用）。

-- CreateEnum
CREATE TYPE "DataExportArtifactStatus" AS ENUM ('WRITING', 'READY', 'PENDING_DELETE', 'DELETED');

-- CreateTable
CREATE TABLE "DataExportArtifact" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "DataExportArtifactStatus" NOT NULL DEFAULT 'WRITING',
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/json',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DataExportArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DataExportArtifact_requestId_key" ON "DataExportArtifact"("requestId");
CREATE UNIQUE INDEX "DataExportArtifact_objectKey_key" ON "DataExportArtifact"("objectKey");
CREATE INDEX "DataExportArtifact_userId_status_idx" ON "DataExportArtifact"("userId", "status");
CREATE INDEX "DataExportArtifact_status_expiresAt_idx" ON "DataExportArtifact"("status", "expiresAt");
CREATE INDEX "DataExportArtifact_status_updatedAt_idx" ON "DataExportArtifact"("status", "updatedAt");

-- AddForeignKeys（request 级联：PrivacyRequest 行不存在时 artifact 失去意义；
--   物理对象由 cleanup / erasure 收敛，不依赖 DB 级联）
-- RB03：artifact 行是 S3 external side-effect 的 durable recovery authority
-- （bucket/objectKey/status）——parent 物理删除绝不能静默 CASCADE 抹掉本行
-- （否则 S3 PII 对象可能成为无主 orphan）。RESTRICT：存在未收敛 artifact 时
-- PrivacyRequest / User 物理删除一律被 DB 拒绝；收敛只能经 cleanup 状态机
-- （PENDING_DELETE → DELETED tombstone 保留）。
ALTER TABLE "DataExportArtifact" ADD CONSTRAINT "DataExportArtifact_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PrivacyRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DataExportArtifact" ADD CONSTRAINT "DataExportArtifact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 9C-03 active DATA_EXPORT 去重（§7）：同一用户至多一个 active
-- DATA_EXPORT request。与 ACCOUNT_DELETION partial unique index 同一惯例
-- （并发重复创建 → P2002 → 稳定映射 DATA_EXPORT_ALREADY_ACTIVE）。
CREATE UNIQUE INDEX "PrivacyRequest_userId_active_data_export_key"
ON "PrivacyRequest"("userId")
WHERE "type" = 'DATA_EXPORT' AND "status" IN ('REQUESTED', 'IN_PROGRESS');
