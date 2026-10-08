# Phase 10K-R2a — Private search submission telemetry (implementation boundary)

**Status:** CODE_CANDIDATE / DEFAULT_OFF / UNAVAILABLE_FOR_ANALYTICS.
Parent contract: `docs/PHASE_10K_R1_MEASUREMENT_CONTRACT.md`.

## Source, unit and exclusions
- `GET /search?q=...` remains an ordinary canonical read, **never** counted on
  RSC render, reload, navigation prefetch, crawler GET or pagination.
- A real user's explicit search form POST to `/search/submit` first executes the
  existing server `getSearchResults(keyword)` read. Only after all four result
  lists finish does it attempt to record one success/zero outcome. The browser
  then receives HTTP 303 to the unchanged GET results page.
- Form ticket is random, HMAC-signed with NEXTAUTH_SECRET, valid 20 minutes.
  Database keeps only a SHA-256 token digest for 24 hours; a unique insert
  and hourly upsert occur in one PostgreSQL transaction.
- Reject mismatched Origin, cross-site/missing navigation activation headers,
  known crawler user agents, empty/control-character/>120 character keywords,
  invalid/reused/expired tickets. No user ID, visitor ID, IP, device signature,
  campus, raw query, content, result IDs, or UA is written to either telemetry table.
  Bot exclusion is **conservative**, not a proof of human identity.
- `SearchTelemetryHour` is GLOBAL_ONLY UTC-hour low-cardinality data:
  `attempts`, `zeroResults`, `expiresAt` only. No DomainEvent, no AuditLog,
  no metric contribution, no personal activity/history.
- `SEARCH_TELEMETRY_CAPTURE=enabled` is an *opt-in*, disabled otherwise. It
  **MUST NOT be enabled** before privacy notice / retention/legal review,
  migrations, worker deployment and canary verification are approved.
- The existing cleanup worker removes claim rows after 24 hours and hourly
  aggregates after 31 days, in bounded batches on its existing 30m cadence,
  including when capture is disabled. Manual: existing storage-cleanup
  `--run-once` or `--run-once --dry-run`.

## Known, intentional incompleteness
- Direct bookmarks/GET query navigations and non-activated browsers do not count.
  Retrying from a newly rendered form is a new request; retrying the same POST
  ticket is deduplicated. PRG GET results may differ if live listings change
  between server POST and render; aggregate uses **POST-time** server result.
- A transient write failure preserves normal search but cannot create reliable
  negative evidence ("missing attempted count"), therefore completeness remains
  UNKNOWN. Collection OFF, missing coverage proof, downtime, bot uncertainty or
  pre-rollout windows => SEARCH_ZERO_RESULT_RATE stays **UNAVAILABLE**, not 0%.
- Before R3 publishes any rate, design and independently verify capture-coverage
  health, valid collection windows, query-channel coverage, request origin mix,
  retention bounds and authorized GLOBAL reads. No historical backfill.

## Deployment safety
1. Apply additive DB migration; leave capture OFF.
2. Roll out the web app and periodic storage-cleanup worker (schema-compatible).
3. Complete privacy notice + retention approval and explicitly authorize enable.
4. Enable only on approved canary. Verify PostgreSQL transaction, unique claim,
   post-retry idempotency, retention execution and failure mode.
5. R3 can evaluate trustworthy windows independently; **do not change** R1
   measurement status or present a ratio based on incomplete counters.
