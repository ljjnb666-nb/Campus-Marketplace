-- 10K-R2a: privacy-limited GLOBAL_ONLY search telemetry.
-- Not a DomainEvent. No keyword, IP, user ID, campus ID, UA or request header.
CREATE TABLE "SearchTelemetryClaim" (
  "digest" VARCHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SearchTelemetryClaim_pkey" PRIMARY KEY ("digest")
);
CREATE INDEX "SearchTelemetryClaim_expiresAt_idx" ON "SearchTelemetryClaim"("expiresAt");

CREATE TABLE "SearchTelemetryHour" (
  "hourStart" TIMESTAMP(3) NOT NULL,
  "attempts" BIGINT NOT NULL DEFAULT 0,
  "zeroResults" BIGINT NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SearchTelemetryHour_pkey" PRIMARY KEY ("hourStart"),
  CONSTRAINT "SearchTelemetryHour_counts_check"
    CHECK ("attempts" >= 0 AND "zeroResults" >= 0 AND "zeroResults" <= "attempts"),
  CONSTRAINT "SearchTelemetryHour_ttl_check"
    CHECK ("expiresAt" > "hourStart")
);
CREATE INDEX "SearchTelemetryHour_expiresAt_idx" ON "SearchTelemetryHour"("expiresAt");
