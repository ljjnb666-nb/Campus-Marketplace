# Phase 10K-R2d-03B-02B-02B-10 — Authorized funnel read vs. candidate observation trust

**State: DRAFT / TEST-ONLY CROSS-BOUNDARY SAFETY GATE / NO PRODUCTION-CAPTURE ENABLEMENT.**

## Purpose and stopping rule

Candidate checkpoint, fork, timeline, window, and overlap helpers provide
only caller-supplied consistency evidence. Earlier integrated tests assert
`canPublish=false` on those helpers. They do not, by themselves, prove the
**actual authorized PostgreSQL funnel diagnostic** will refuse to promote
those results to public measurement.

This slice adds a cross-boundary regression suite joining three existing
surfaces: positive candidate checkpoint/window evidence, apparently complete
five-stream unverified fleet capture intervals, and the authorized campus-
scoped internal funnel read. It is test-only: no application production code,
schema, routing, migration, key, collector or environment configuration
changes.

## Mandatory negative outcomes

1. Even when all three present-tense capture feature flags are enabled,
   the attribution secret is available, all ledger rows are projected, and
   candidate fork/overlap checks pass, `loadAuthorizedFunnelDiagnostic`
   returns `UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN`, not a release-ready
   conversion rate or published KPI.
2. Even when every one of the five unverified capture streams claims exact
   cohort + 7-day attribution tail coverage, the fleet-claim diagnostic must
   still return `UNAVAILABLE_FLEET_AUTHORITY_NOT_ESTABLISHED`.
3. Caller-injected fields named `canPublish`, `captureContinuityProven`,
   `independentHostAuthenticated` and `deploymentMembershipComplete`
   must never be accepted as an authorization or trusted provenance source.
4. Disabled emission flags, missing projection receipts, immature cohorts,
   query failures, fact truncation and diagnostic opt-out remain independent,
   fail-closed refusal gates.
5. `analytics.read` authorization and exact-campus scoping must precede
   ledger query; candidate proofs cannot bypass RBAC or allow cross-campus
   facts.
6. Forged host labels, sensitive SQL errors and candidate identities are
   never echoed as verified host identities or user-facing measurement.

## What this DOES NOT establish

Passing these assertions is not independent host enrollment, a full
deployment census, durable checkpoint compare-and-swap, evidence of
continuous capture, source inventory reconciliation, or a right to publish.
Separate, independently operated sources and full historical verification
are required. The existing R1 measurements remain unavailable in the
absence of those future gates.

Candidate positive statuses remain precisely **UNVERIFIED**. This PR
does not turn on R1 metrics, expose an HTTP route, change production
authorization rules, persist keys or write any candidate record.

## Validation and review

Exactly two additive files: 15 cross-boundary adversarial tests using
isolated RBAC / Prisma transaction mocks, and this negative-trust contract.
Require exact-HEAD CI Typecheck, Lint, full Vitest with coverage, Build,
Playwright, independent review, and separate explicit user authorization
to merge. On approved Merge Commit validate `expected_head_sha`,
both Parent SHA values, master HEAD, and exact-master-SHA CI.

Issue #97 remains independently OPEN; historical ops rollback flakiness
must not be hidden or silently coupled to this slice.
