ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "mfaSecretEncrypted" TEXT,
  ADD COLUMN "mfaPendingEncrypted" TEXT,
  ADD COLUMN "mfaPendingSessionId" TEXT,
  ADD COLUMN "mfaPendingExpiresAt" TIMESTAMP(3),
  ADD COLUMN "mfaLastCounter" BIGINT;
-- Existing addresses are deliberately not backfilled as verified.
CREATE TABLE "AccountChallenge" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "purpose" TEXT NOT NULL CHECK ("purpose" IN ('VERIFY_EMAIL', 'RESET_PASSWORD')),
  "tokenHash" TEXT NOT NULL,
  "bindingHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AccountChallenge_userId_purpose_expiresAt_idx" ON "AccountChallenge"("userId", "purpose", "expiresAt");
