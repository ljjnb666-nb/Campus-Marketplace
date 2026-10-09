# Phase 10K-R2d-02 — Authorized read-only funnel diagnostics

**CANDIDATE ONLY / NOT USER-VISIBLE / DEFAULT OFF / NO METRIC PUBLICATION**

## Scope

The `loadAuthorizedUnreleasedFunnelDiagnostic` service is an intentionally
internal, non-routed read boundary. It revalidates active-account RBAC for the
exact tenant on every call. A campus-only grant can never see another campus.
`ANALYTICS_FUNNEL_DIAGNOSTICS=enabled` is separately required to issue reads;
the flag stays **unset/default OFF** in all checked-in deployments. The service
does not add UI, Server Actions, API handlers, writes, a scheduler, or a metric
registry entry.

The query is bounded by campusId, strict four-kind event allowlist, and a
mature 7/30-day UTC cohort plus seven days of attribution observation. The
SQL limit of 5,001 rows is enforced **before** matching and a 5,001st row
makes the whole candidate unavailable, not a truncated denominator.

ProjectionReceipt v3 and matching AsyncJob states provide *negative*
diagnostics (missing receipt / missing intent / in flight / dead-letter);
they are **not evidence** that all application servers, worker versions,
feature flags, privacy approvals, historical reconciliation, production
collection or deletion/retention policies were continuously correct.
Even with zero missing receipts, the result remains
`UNAVAILABLE_PENDING_CAPTURE_COVERAGE`. No rates or durations are published.

Future coverage closure requires a separate rollout registry/source-of-truth,
window-specific capture health, deployment-version continuity, forward- and
backfill-reconciliation policy, privacy review, and source/domain inventory
completeness checks. Until then the six Phase 10K measurement gaps remain
UNAVAILABLE and existing production controls default OFF.

## Verification

- Unauthorized, inactive and wrong-campus fail before any ledger read.
- Exact SQL predicates and 5,001st-row refusal.
- Missing and complete projection evidence both never publish a rate.
- Real PostgreSQL integration for tenant isolation and intent/receipt health.
- Exact-HEAD Verify and Playwright gates, independent review, explicit merge approval.
