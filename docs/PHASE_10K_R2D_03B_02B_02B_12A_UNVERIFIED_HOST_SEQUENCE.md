# Phase 10K-R2d-03B-02B-02B-12A — UNVERIFIED Host Journal Transaction Sequencing

**STATUS: INTERNAL UNVERIFIED SAFETY SEAM / NOT TRUSTED CAS / NO ROLLOUT.**

## Scope and rationale

The accepted Phase 11 ADR concludes that full trusted replay/continuity requires an independently enrolled observer, registry epoch fencing, an independently administered durable cursor, external anchoring, deployment census and source reconciliation. None of those external prerequisites is currently proved. This small **implementation** slice therefore adds a narrower fallback: an opt-in transaction-only PostgreSQL sequence guard over the existing immutable `HostLifecycleClaim` journal. It **does not implement** the Phase 11 trusted CAS or change its G1–G6 gates.

Exactly three additive files: `funnel-host-lifecycle-contiguous-unverified.ts`, a real-PG integration regression, and this document. No Prisma schema/migration, API, background writer, Docker socket/observer, credentials, feature flag or KPI publisher changes. Existing insert seam remains unchanged.

## Safety model

- The new helper must be called **inside a caller-owned READ COMMITTED Prisma transaction**. It snapshots/canonicalizes a candidate observation once, then reads only its sanitized copy to avoid input-mutation TOCTOU.
- It acquires a per-`(hostId,sessionId)` PostgreSQL *transaction* advisory lock using a length-framed JSON scope and bounded lock wait (1.5s). Hash collisions only serialize unrelated scopes; they cannot merge keys. It then reads the already-persisted journal and performs all checks and writes within the caller's transaction.
- Genesis requires BASELINE at sequence 1. Fresh writes require exactly latest sequence + 1, monotonic observation timestamps, ≤15m between observations, no repeated BASELINE and no continuation after DISCONNECTED. Same-slot replay is idempotent only when the persisted immutable claim matches in full; different content is rejected. Unknown-commit callers can repeat their exact input without inventing history.
- Existing immutable journal DB unique constraints and regular-DML append-only enforcement remain intact; all test fixtures roll back. DB/lock errors are refused generically without exposing raw SQL errors or host identities.
- A committed DISCONNECTED claim does not prove subsequent coverage. Missing or failed writes **cannot** become evidence of continuity, and the helper is not a trusted checkpoint authority.

## Crucial bypass limitation

This is an opt-in **cooperating-callers** guard, not a global schema invariant. The older internal writer and privileged SQL roles can still bypass its advisory lock and append claims with skipped sequences; an independent identity root is not provided. The journal belongs to the same database trust domain, with no independently witnessed receipt hash anchor or root-owned epoch. A successful call never means that an observed event actually occurred or that any omitted events/hosts do not exist.

All returned authority flags remain `false`:

```text
independentProvisioningVerified = false
independentHostAuthenticated = false
deploymentMembershipComplete = false
captureContinuityProven = false
canPublish = false
```

## Verification / stop gates

Real-PG tests: transactional rollback, genesis and retry, sequence hole, same-slot conflict, timestamp rollback/silence, disconnect, repeated baseline, old writer bypass, isolation fail-closed, and a two-connection bounded contention test. These do **not** substitute for real independent host enrollment, external revoke/cutover, durable trusted cursor CAS, crash injection after actual commit, full fleet inventory or production fault drill.

Require exact-HEAD Typecheck, Lint, full Vitest/coverage, Build, Playwright and independently recorded audit. No self-merge; explicit user approval, expected-head Merge Commit and exact-master-SHA CI remain mandatory. Keep Issue #97 (ops shell) and #109 (8C-02 flaky locator) OPEN and separate. Phase 10 and Phase 3B production release remain blocked.
