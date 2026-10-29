-- Preserve the fact that recovered password hashes may be older than
-- password changes performed after a disaster-recovery snapshot.
-- Normal accounts default to usable; the production restore authority sets
-- this flag to TRUE for *every restored user* before releasing any writer.
ALTER TABLE "User"
  ADD COLUMN "credentialRecoveryRequired" BOOLEAN NOT NULL DEFAULT false;
