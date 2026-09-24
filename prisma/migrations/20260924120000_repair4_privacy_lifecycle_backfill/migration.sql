-- Repair 4 / RB-04: privacy lifecycle closure — historical secondary-copy
-- redaction + deterministic already-erased-user backfill.
-- REVIEW FIX (R4-01/02/03): User.schoolName REDACT backfill; already-erased
-- Notification rows DELETE before historical redaction; listing/order
-- attached user-authored content converged (STRUCTURAL ROW RETENTION !=
-- USER CONTENT RETENTION).
--
-- Hard contracts (frozen by external audit):
-- - DATA_ONLY: zero DDL, zero network I/O, zero object-storage deletion.
--   Physical objects are deleted exclusively by the existing storage cleanup
--   (PENDING_DELETE → deleteObject → DELETED → exactly-once quota release).
-- - No heuristic author guessing (no LIKE / regex / string-contains). Every
--   backfill statement attributes authorship via FK / ownership / explicit
--   actor relation (operatorId / cancelledById / senderId / authorId /
--   reporterId / initiatorId / enforcementAction.targetId / requesterId /
--   ownerId / publisherId / sellerId / providerId / submittedById).
-- - Idempotent in effect: every statement is a deterministic SET-to-constant
--   guarded by the exact erasure predicate; re-running converges to the same
--   end state.

BEGIN;

-- ------------------------------------------------------------------
-- A. Already-erased users: Notification rows are DERIVED_EPHEMERAL
--    inbox — registry erasure policy is DELETE (R4-02). Must run
--    BEFORE the historical redaction so erased owners' rows are
--    removed, not merely redacted.
-- ------------------------------------------------------------------
DELETE FROM "Notification"
WHERE "userId" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
);

-- ------------------------------------------------------------------
-- B. Historical Notification redaction (surviving rows predate this
--    migration and belong to active accounts — derived copies may be
--    sacrificed; title / type / isRead / createdAt preserved)
-- ------------------------------------------------------------------
UPDATE "Notification"
SET "content" = '历史通知详情已按隐私策略清理，请查看相关业务记录。'
WHERE "content" <> '历史通知详情已按隐私策略清理，请查看相关业务记录。';

-- ------------------------------------------------------------------
-- C. Already-erased users backfill (deterministic, FK-attributed)
-- ------------------------------------------------------------------

-- C1. User.schoolName is NON-NULLABLE direct identity (R4-01) — REDACT
--     with the erasure display-name marker, never NULL.
UPDATE "User" u
SET "schoolName" = '已注销用户'
WHERE u."schoolName" <> '已注销用户'
  AND u."erasedAt" IS NOT NULL;

-- C2. UserVerification: reviewer free text must not survive erasure
UPDATE "UserVerification" uv
SET "reviewNote" = NULL
WHERE uv."reviewNote" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "User" u
    WHERE u."id" = uv."userId" AND u."erasedAt" IS NOT NULL
  );

-- C3. SupportTicket: user free text + operator free text per current
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

-- C4. UploadedAsset: originalFileName is potential PII — cleared for every
--     asset of an erased owner regardless of category/access/status.
UPDATE "UploadedAsset" a
SET "originalFileName" = NULL
WHERE a."originalFileName" IS NOT NULL
  AND a."ownerId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

-- C5. UploadedAsset: every business-mirrored asset of an erased owner
--     enters the durable deletion queue (R4-03 §10/§18: PRODUCT / SERVICE /
--     RENTAL listing images included; PUBLIC objects follow the same
--     lifecycle). UPLOADING rows stay on the stale-upload TTL recovery
--     contract (object-revival race with in-flight S3 PUT).
UPDATE "UploadedAsset" a
SET "status" = 'PENDING_DELETE'
WHERE a."status" IN ('UPLOADED', 'ATTACHED')
  AND a."category" IN (
    'AVATAR', 'VERIFICATION', 'HANDOVER', 'RETURN', 'REPORT',
    'PRODUCT', 'SERVICE', 'RENTAL'
  )
  AND a."ownerId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

-- C6. RentalOrderStatusLog: notes authored by erased operators (future
--     writes are frozen to system-generated descriptions only).
UPDATE "RentalOrderStatusLog" sl
SET "note" = NULL
WHERE sl."note" IS NOT NULL
  AND sl."operatorId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

-- C7. RentalOrder free text with exact actor attribution.
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

-- C8. Message: rows survive (conversation/report relational history), but
--     free text → marker and the sender reference is dropped (nullable FK).
UPDATE "Message" m
SET "content" = '（该内容已随账号注销删除）',
    "senderId" = NULL
WHERE m."senderId" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
)
  AND (m."content" <> '（该内容已随账号注销删除）' OR m."senderId" IS NOT NULL);

-- C9. Review / RentalReview authored text cleared; structural rating
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

-- C10. Report: reporter-authored detail cleared; reason enum / status /
--      scope provenance / decision history retained. handledNote is
--      governance (RETAIN_GOVERNANCE, untouched).
UPDATE "Report" rp
SET "detail" = NULL
WHERE rp."detail" IS NOT NULL
  AND rp."reporterId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

-- C11. Appeal: appellant-authored statement (non-nullable column → marker);
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

-- C12. General Order: no reliable cancelledBy attribution exists — when any
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

-- C13. RentalDispute: initiator-authored reason / evidence cleared for
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

-- ------------------------------------------------------------------
-- D. Listing / order-attached user-authored content (R4-03): rows and
--    structural metadata survive; raw user content does not.
-- ------------------------------------------------------------------

-- D1. BlockedUser: blocker-authored reason (relation row behavior unchanged).
UPDATE "BlockedUser" bu
SET "reason" = NULL
WHERE bu."reason" IS NOT NULL
  AND bu."blockerId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

-- D2. ErrandTask: publisher is the sole author. title / description /
--     pickupLocation / deliveryLocation are NON-NULLABLE → REDACT;
--     contactNote nullable → CLEAR.
UPDATE "ErrandTask" et
SET "title" = '（该内容已随账号注销删除）',
    "description" = '（该内容已随账号注销删除）',
    "pickupLocation" = '（该内容已随账号注销删除）',
    "deliveryLocation" = '（该内容已随账号注销删除）',
    "contactNote" = NULL
WHERE et."publisherId" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
)
  AND (
    et."title" <> '（该内容已随账号注销删除）'
    OR et."description" <> '（该内容已随账号注销删除）'
    OR et."pickupLocation" <> '（该内容已随账号注销删除）'
    OR et."deliveryLocation" <> '（该内容已随账号注销删除）'
    OR et."contactNote" IS NOT NULL
  );

-- D3. Product: seller is the sole author. description NON-NULLABLE → REDACT;
--     ProductImage rows are attached content rows (row-level CLEAR).
UPDATE "Product" p
SET "title" = '（该内容已随账号注销删除）',
    "description" = '（该内容已随账号注销删除）',
    "locationText" = '（该内容已随账号注销删除）'
WHERE p."sellerId" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
)
  AND (
    p."title" <> '（该内容已随账号注销删除）'
    OR p."description" <> '（该内容已随账号注销删除）'
    OR p."locationText" <> '（该内容已随账号注销删除）'
  );

DELETE FROM "ProductImage" pi
WHERE pi."productId" IN (
  SELECT p."id" FROM "Product" p
  WHERE p."sellerId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  )
);

-- D4. ServiceListing: provider is the sole author. description NON-NULLABLE
--     → REDACT; coverImageUrl nullable → CLEAR.
UPDATE "ServiceListing" sv
SET "title" = '（该内容已随账号注销删除）',
    "description" = '（该内容已随账号注销删除）',
    "locationText" = '（该内容已随账号注销删除）',
    "availableSchedule" = NULL,
    "coverImageUrl" = NULL
WHERE sv."providerId" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
)
  AND (
    sv."title" <> '（该内容已随账号注销删除）'
    OR sv."description" <> '（该内容已随账号注销删除）'
    OR sv."locationText" <> '（该内容已随账号注销删除）'
    OR sv."availableSchedule" IS NOT NULL
    OR sv."coverImageUrl" IS NOT NULL
  );

-- D5. RentalListing: owner is the sole author. description NON-NULLABLE →
--     REDACT; RentalListingImage rows are attached content rows.
UPDATE "RentalListing" rl
SET "title" = '（该内容已随账号注销删除）',
    "description" = '（该内容已随账号注销删除）',
    "pickupLocation" = '（该内容已随账号注销删除）',
    "returnLocation" = '（该内容已随账号注销删除）',
    "brand" = NULL,
    "model" = NULL,
    "usageRules" = NULL,
    "damagePolicy" = NULL,
    "overduePolicy" = NULL
WHERE rl."ownerId" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
)
  AND (
    rl."title" <> '（该内容已随账号注销删除）'
    OR rl."description" <> '（该内容已随账号注销删除）'
    OR rl."pickupLocation" <> '（该内容已随账号注销删除）'
    OR rl."returnLocation" <> '（该内容已随账号注销删除）'
    OR rl."brand" IS NOT NULL
    OR rl."model" IS NOT NULL
    OR rl."usageRules" IS NOT NULL
    OR rl."damagePolicy" IS NOT NULL
    OR rl."overduePolicy" IS NOT NULL
  );

DELETE FROM "RentalListingImage" rli
WHERE rli."rentalListingId" IN (
  SELECT rl."id" FROM "RentalListing" rl
  WHERE rl."ownerId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  )
);

-- D6. RentalDamageClaim (terminal-only here; active obligations block
--     erasure): damageDescription / photos attributed via submittedById
--     (owner-only write path); renterNote via order.renterId.
UPDATE "RentalDamageClaim" dc
SET "damageDescription" = '（该内容已随账号注销删除）',
    "photos" = '{}'::text[]
WHERE dc."submittedById" IN (
  SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
)
  AND (
    dc."damageDescription" <> '（该内容已随账号注销删除）'
    OR dc."photos" <> '{}'::text[]
  );

UPDATE "RentalDamageClaim" dc
SET "renterNote" = NULL
WHERE dc."renterNote" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "RentalOrder" ro
    WHERE ro."id" = dc."orderId"
      AND ro."renterId" IN (
        SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
      )
  );

-- D7. RentalExtensionRequest: ownerNote is written by the owner
--     (order.ownerId) when responding.
UPDATE "RentalExtensionRequest" rx
SET "ownerNote" = NULL
WHERE rx."ownerNote" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "RentalOrder" ro
    WHERE ro."id" = rx."orderId"
      AND ro."ownerId" IN (
        SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
      )
  );

-- D8. RentalReturnRecord: inspectionNote authored by the owner
--     (order.ownerId). photos are dual-confirmation overwrite-semantics
--     asset locators (STORAGE_METADATA, no per-photo attribution) —
--     objects are removed via the HANDOVER/RETURN asset lifecycle.
UPDATE "RentalReturnRecord" rr
SET "inspectionNote" = NULL
WHERE rr."inspectionNote" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "RentalOrder" ro
    WHERE ro."id" = rr."orderId"
      AND ro."ownerId" IN (
        SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
      )
  );

-- D9. RentalUnavailablePeriod: owner-managed via the listing FK; reason
--     cleared, structural timing retained.
UPDATE "RentalUnavailablePeriod" up
SET "reason" = NULL
WHERE up."reason" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "RentalListing" rl
    WHERE rl."id" = up."rentalListingId"
      AND rl."ownerId" IN (
        SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
      )
  );

-- D10a. Order.meetingLocation: buyer-authored (productOrderFormSchema /
--       serviceOrderFormSchema → create*OrderTx); seller erasure never
--       touches the buyer's data.
UPDATE "Order" o2
SET "meetingLocation" = NULL
WHERE o2."meetingLocation" IS NOT NULL
  AND o2."buyerId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  );

-- D10. RentalHandoverRecord: accessories / currentCondition / knownIssues
--      are owner/renter dual-writable free text with no per-field author
--      attribution → participant-erasure rule (same as General Order):
--      either rental participant erased → cleared. No author guessing.
UPDATE "RentalHandoverRecord" rh
SET "accessories" = NULL,
    "currentCondition" = NULL,
    "knownIssues" = NULL
WHERE EXISTS (
    SELECT 1 FROM "RentalOrder" ro
    WHERE ro."id" = rh."orderId"
      AND (ro."ownerId" IN (
        SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
      ) OR ro."renterId" IN (
        SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
      ))
  )
  AND (
    rh."accessories" IS NOT NULL
    OR rh."currentCondition" IS NOT NULL
    OR rh."knownIssues" IS NOT NULL
  );

-- D11. RentalOrder location snapshots: owner-authored listing location
--      durable secondary copies (RentalListing.pickupLocation /
--      returnLocation → createRentalOrderTx). Owner erasure → REDACT
--      marker; renter erasure never touches owner data. Transaction
--      structure (amounts / status / time window) retained.
UPDATE "RentalOrder" ro2
SET "pickupLocationSnapshot" = '（该内容已随账号注销删除）',
    "returnLocationSnapshot" = '（该内容已随账号注销删除）'
WHERE ro2."ownerId" IN (
    SELECT u."id" FROM "User" u WHERE u."erasedAt" IS NOT NULL
  )
  AND (
    ro2."pickupLocationSnapshot" <> '（该内容已随账号注销删除）'
    OR ro2."returnLocationSnapshot" <> '（该内容已随账号注销删除）'
  );

COMMIT;
