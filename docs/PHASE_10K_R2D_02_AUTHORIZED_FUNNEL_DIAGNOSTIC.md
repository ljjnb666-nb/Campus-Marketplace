# Phase 10K-R2d-02 — Authorized, bounded PostgreSQL funnel diagnostics

## Release state
**IMPLEMENTED_CANDIDATE / INTERNAL_ONLY / NO_ROLLOUT / NO_METRIC_PUBLICATION.**

R2d-01 defined the unpublishable pure 7-/30-day event cohort contract.
R2d-02 adds an actual PostgreSQL read under the same privacy and verification
rules. It does **not** establish historic capture continuity, enrollment or
legitimate conversion-rate denominators. All six R1 metrics stay UNAVAILABLE.

## Exact authority boundaries

1. Internal `loadAuthorizedFunnelDiagnostic` requires actorId, explicit
   campusId, one PRODUCT/SERVICE/RENTAL listingType, a 7- or 30-day cohort
   and cohortEnd. It reads *fresh* RBAC context and requires `analytics.read`
   permission for this exact campus, with active account and membership.
   No exposed API route, server action, UI widget, scheduled job or dashboard
   accessor is added.
2. A separate diagnostic opt-in, `ANALYTICS_FUNNEL_DIAGNOSTICS=enabled`,
   is required even for an authorized operator. The checked-in default is OFF;
   without opt-in, no tenant fact, receipt or event is queried.
3. It refuses immature time windows (the 7-day conversion period has not
   fully elapsed). Client-provided `now` or arbitrary "coverage complete"
   booleans cannot publish any metric; `now` exists only for deterministic
   test fixtures.
4. PostgreSQL reads DomainEvent with exact campusId, strict four-event-type
   list and bounded occurredAt range, **inside a single REPEATABLE READ**
   transaction. The query is ordered deterministically and limited to
   MAX_FACTS+1 = 5,001, with no unbounded scan transferred to Node.
   Greater than 5,000 records is an explicit unavailable state, never a
   truncated/misleading cohort.
5. In the same snapshot, count missing current-version ProjectionReceipts
   against DOMAIN_TX events in the exact scope. The receipt gate diagnoses
   worker lag/corruption; a zero missing count proves only that all **observed**
   events have receipts, NOT that all user activity was observed.
6. Reuse R2d-01 registry validation for schema/aggregate/occurrence payload,
   same campus/type, first reply, unique conversion and 7-day maturation.
   No raw message text, actor email, user identity, IP or search keyword is
   read. Never return record IDs, source events or PII to callers.
7. Flag check for R2b conversation, R2c first reply, R2c order attribution
   and 32-byte signing secret is a negative gate only. Even when all four
   are enabled and receipt lag is zero, the result is unconditionally
   `UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN`.
   **There is no evidence store for which deployment versions, exact
   timestamps and worker epochs emitted the facts throughout the cohort.**
8. Query/driver failure, load >5,000, immature cohort, flags disabled,
   missing receipts or lack of historical coverage can never silently become
   a 0% or a published median. The internal response has diagnostics only.

## Why this does not yet satisfy Phase 10K final acceptance

The current DomainEvent ledger cannot prove a negative: a missing event may
mean a conversion did not happen, or that the writer/flag/worker was disabled.
Neither an event row count nor a green CI run proves producer continuity.
R2d-03 must introduce durable per-fleet writer/worker deployment evidence
and/or reconciled capture coverage and verify it across each entire cohort
and attribution window **before** any denominator can be considered complete.

R2a search telemetry remains GLOBAL_ONLY and off unless separately approved
for privacy. R3 supply-demand and pilot north star remain independent work.

## Acceptance gates

- Unit tests: authorization precedes any tenant event read, same-campus query
  predicates, bounded snapshots, immutable coverage refusal, invalid windows,
  driver errors, missing receipts and disabled flags.
- Real PostgreSQL: exact campus isolation, stable receipt lag count,
  append-only source event read, no published rate.
- Exact-HEAD lint, typecheck, build, Vitest and Playwright verification.
- Independent review / explicit merge approval / exact-master CI.

Do not activate production flags as part of this PR.
