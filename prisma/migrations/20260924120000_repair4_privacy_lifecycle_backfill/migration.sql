-- Repair 4 / RB-04: privacy lifecycle closure — historical secondary-copy
-- redaction + deterministic already-erased-user backfill.
--
-- Hard contracts (frozen by external audit):
-- - DATA_ONLY: zero DDL, zero network I/O, zero object-storage deletion.
--   Physical objects are deleted exclusively by the existing storage cleanup
--   (PENDING_DELETE → deleteObject → DELETED → exactly-once quota release).
-- - No heuristic author guessing (no LIKE / regex / string-contains). Every
--   backfill statement attributes authorship via FK / ownership / explicit
--   actor relation (operatorId / cancelledById / senderId / authorId /
--   reporterId / initiatorId / enforcementAction.targetId / requesterId /
--   ownerId).
-- - Idempotent in effect: every statement is a deterministic SET-to-constant
--   guarded by the exact erasure predicate; re-running converges to the same
--   end state.
-- - Historical Notification.content (DERIVED_EPHEMERAL) is redacted to a
--   generic marker: old rows have no reliable source attribution, and derived
--   copies may be sacrificed without touching authoritative business records.
--   title / type / isRead / createdAt are preserved.

BEGIN;

-- ------------------------------------------------------------------
-- A. Historical Notification redaction (all rows predating this migration)
-- ------------------------------------------------------------------
UPDATE "Notification"
SET "content" = '历史通知详情已按隐私策略清理，请查看相关业务记录。'
WHERE "content" <> '历史通知详情已按隐私策略清理，请查看相关业务记录。';

-- ------------------------------------------------------------------
-- B. Already-erased users backfill (deterministic, FK-attributed)
-- ------------------------------------------------------------------

-- B1. UserVerification: reviewer free text must not survive erasure
UPDATE "UserVerification" uv
SET "reviewNote" = NULL
WHERE uv."reviewNote" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "User" u
    WHERE u."id" = uv."userId" AND u."erasedAt" IS NOT NULL
  );

-- B2. SupportTicket: user free text + operator free text per current
--     erasure rules (subject/description → marker; resolution messages /
--     internal notes → NULL) for terminal tickets of erased requesters
--     (active tickets block erasure, so any row here is terminal).
UPDATE "SupportTicket" st
SET "subject" = '（该内容已随账号注销删除）',
    "description" = '（该内容已随账号注销删除）',
    "resolutionMessage" = NULL,
    "internalNote" = NULL
WHERE st."requesterId" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
)
  AND (
    st."subject" <> '（该内容已随账号注销删除）'
    OR st."description" <> '（该内容已随账号注销删除）'
    OR st."resolutionMessage" IS NOT NULL
    OR st."internalNote" IS NOT NULL
  );

-- B3. UploadedAsset: originalFileName is potential PII — cleared for every
--     asset of an erased owner regardless of category/access/status.
UPDATE "UploadedAsset" a
SET "originalFileName" = NULL
WHERE a."originalFileName" IS NOT NULL
  AND a."ownerId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

-- B4. UploadedAsset: sensitive private evidence of erased owners enters the
--     durable deletion queue (AVATAR was not covered by the legacy
--     expiresAt-based marking). UPLOADING rows stay on the stale-upload TTL
--     recovery contract (object-revival race with in-flight S3 PUT).
UPDATE "UploadedAsset" a
SET "status" = 'PENDING_DELETE'
WHERE a."status" IN ('UPLOADED', 'ATTACHED')
  AND a."category" IN ('AVATAR', 'VERIFICATION', 'HANDOVER', 'RETURN', 'REPORT')
  AND a."ownerId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

-- B5. RentalOrderStatusLog: notes authored by erased operators (future
--     writes are frozen to system-generated descriptions only).
UPDATE "RentalOrderStatusLog" sl
SET "note" = NULL
WHERE sl."note" IS NOT NULL
  AND sl."operatorId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

-- B6. RentalOrder free text with exact actor attribution.
UPDATE "RentalOrder" ro
SET "renterNote" = NULL
WHERE ro."renterNote" IS NOT NULL
  AND ro."renterId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

UPDATE "RentalOrder" ro
SET "cancellationNote" = NULL
WHERE ro."cancellationNote" IS NOT NULL
  AND ro."cancelledById" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

-- B7. Message: rows survive (conversation/report relational history), but
--     free text → marker and the sender reference is dropped (nullable FK).
UPDATE "Message" m
SET "content" = '（该内容已随账号注销删除）',
    "senderId" = NULL
WHERE m."senderId" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
)
  AND (m."content" <> '（该内容已随账号注销删除）' OR m."senderId" IS NOT NULL);

-- B8. Review / RentalReview authored text cleared; structural rating
--     history preserved; authorId keeps referencing the pseudonymous row.
UPDATE "Review" r
SET "content" = NULL,
    "tags" = '{}'::text[]
WHERE r."authorId" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
)
  AND (r."content" IS NOT NULL OR r."tags" <> '{}'::text[]);

UPDATE "RentalReview" rr
SET "content" = NULL,
    "tags" = '{}'::text[]
WHERE rr."authorId" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
)
  AND (rr."content" IS NOT NULL OR rr."tags" <> '{}'::text[]);

-- B9. Report: reporter-authored detail cleared; reason enum / status /
--     scope provenance / decision history retained. handledNote is
--     governance (RETAIN_GOVERNANCE, untouched).
UPDATE "Report" rp
SET "detail" = NULL
WHERE rp."detail" IS NOT NULL
  AND rp."reporterId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

-- B10. Appeal: appellant-authored statement (non-nullable column → marker);
--      status / decision machine records retained; decisionNote untouched.
UPDATE "Appeal" ap
SET "statement" = '（该内容已随账号注销删除）'
WHERE ap."statement" <> '（该内容已随账号注销删除）'
  AND EXISTS (
    SELECT 1 FROM "EnforcementAction" ea
    WHERE ea."id" = ap."enforcementActionId"
      AND ea."targetId" IN (
        SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
      )
  );

-- B11. General Order: no reliable cancelledBy attribution exists — when any
--      participant is erased, ambiguous participant free text is cleared
--      (privacy first); amounts / status / type / timestamps retained.
UPDATE "Order" o
SET "note" = NULL,
    "cancelReason" = NULL
WHERE (o."buyerId" IN (
         SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
       )
       OR o."sellerId" IN (
         SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
       ))
  AND (o."note" IS NOT NULL OR o."cancelReason" IS NOT NULL);

-- B12. RentalDispute: initiator-authored reason / evidence cleared for
--      terminal disputes of erased initiators (active disputes block
--      erasure via DataHold + IN_DISPUTE status). adminNote untouched.
UPDATE "RentalDispute" rd
SET "reason" = '（该内容已随账号注销删除）',
    "evidencePhotos" = '{}'::text[]
WHERE rd."initiatorId" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
)
  AND (
    rd."reason" <> '（该内容已随账号注销删除）'
    OR rd."evidencePhotos" <> '{}'::text[]
  );

COMMIT;
