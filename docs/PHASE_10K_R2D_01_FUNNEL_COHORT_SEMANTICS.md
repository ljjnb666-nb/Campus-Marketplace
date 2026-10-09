# Phase 10K-R2d-01 — Provisional funnel cohort semantics

**Status: DIAGNOSTIC_ONLY / NO_PRODUCTION_QUERY / NO_METRIC_PUBLICATION / DEFAULT_OFF.**

This scoped PR introduces a *pure* and bounded cohort evaluation primitive.
It is not a new dashboard, production coverage claim, projection version,
historical repair, or release approval. All six Phase 10K-R1 measures remain
`UNAVAILABLE_PENDING_INSTRUMENTATION`.

## What the contract proves in isolation

- Separate 7×24h and 30×24h **UTC half-open** cohort windows. Require full
  seven days of additional observable time after the cohort end, not a partial
  immature denominator.
- Same exact campus and listing type. Reuse strict registry payload, aggregate,
  occurrence identity and v1 schema, rejecting malformed event candidates.
  Exclude backfilled source facts from v1 live-only diagnostics; never silently
  merge historical reconstructions with current events.
- Listing cohort: unique LIQUIDITY_LISTING_CREATED listing IDs with
  first LISTING_CONVERSATION_CREATED within 7 days (inclusive) of listing event.
  The conversion event may lie *after* the numerator cohort end; it does not
  become part of the next cohort's denominator.
- Conversation cohort: unique eligible LISTING_CONVERSATION_CREATED IDs in
  the report window; require a matching listingId/type/campus and source
  conversation for attributed orders, not mere correlated Order timestamps.
  Count at most one converted conversation despite many orders.
- First interaction: match the single canonical FIRST_REPLY occurrence and
  exact elapsedMilliseconds to DB event time, excluding >7-day / malformed
  observations and keeping nonresponders **censored** (not zero seconds).
- Invalid and duplicate facts are counted as QA diagnostics, never credited.
  Numerators are per unique listing/conversation, not per event row.

## Why the diagnostic is not a user-visible rate

The function returns `UNAVAILABLE_PENDING_CAPTURE_COVERAGE` **even when its
candidate counts look valid**. These are incomplete sample diagnostics only;
no rate or median is served to the frontend or the metric registry.

Future R2d-02 must add an authorized PostgreSQL read path, bounded server-side
cohort aggregation (not unlimited event scans), fleet-version/flag continuity,
capture health and event/worker watermark proof, reprocessing/backfill policy,
privacy-retention approval and completeness evidence for *every* mature cohort.

Only after those gates may a separate, independently reviewed version register
new metrics and enable authorized production reads. R2a search coverage is
GLOBAL_ONLY; it must never be joined with a campus cohort.

## Verification

Strict pure-function unit and real-PostgreSQL ledger samples; exact-HEAD
Verify + Playwright E2E; independent review; explicit merge authorization.
