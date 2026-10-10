# Phase 10K-R2d-03B-02B-02B-12B — Caller transaction lock policy ownership

**STATUS: INTERNAL UNVERIFIED TRANSACTION REPAIR / NO EXTERNAL AUTHORITY / NO ROLLOUT.**

## Audited defect and invariants

Phase 12A correctly limits the sequence guard to a caller-owned READ COMMITTED Prisma transaction and a per-host/session PostgreSQL advisory transaction lock. But the helper wrote `SET LOCAL lock_timeout = '1500ms'` into that **caller-owned** transaction and did not restore it. This means a caller that explicitly selected a longer/shorter lock timeout could silently have unrelated SQL lock behavior changed after a *successful* sequence write. This is a transaction ownership and error-budget violation, not a host-identity or KPI security bypass.

The canonical owner of the whole transaction owns SQL-level settings. An opt-in helper may acquire a transaction-scoped advisory lock, but it must not mutate ambient `lock_timeout` and must not block forever.

## Fix

- Replace blocking `pg_advisory_xact_lock` + `SET LOCAL lock_timeout` with PostgreSQL `pg_try_advisory_xact_lock` using the **unchanged** machine-only canonical host/session scope hash. A scope already held by another transaction returns false immediately; malformed/unexpected driver results or SQL errors fail closed with the existing generic error. The lock still stays held until the caller commits or rolls back.
- Keep identical journal ordering, idempotency, immutable claim semantics, READ COMMITTED isolation check, sanitization and `DISCONNECTED` gap refusal. A caller should retry later under its own bounded policy; this helper does not silently sleep or choose retry delays.
- In real PostgreSQL, demonstrate that a configured caller `lock_timeout='7s'` survives the **successful** guarded insert unchanged; a concurrent unrelated host can make progress while the first host's transaction holds its scoped advisory lock; same host contention is rejected. All fixtures roll back. No proxy/mocked PostgreSQL claims are substituted for integration evidence.
- Update the Phase 12A documentation so it does not advertise a 1.5-second timeout that no longer exists.

## Explicit limitations

This changes *only* the opt-in internal `UNVERIFIED` seam. It creates no trusted checkpoint, external principal identity, independent roster, cross-process evidence root, ingestion route, new migration, feature activation, Docker/worker privileges or KPI publication. A legacy writer not using this guard can still bypass it; privileged DB users remain in the same trust domain. All output trust flags stay permanently false:
```text
independentProvisioningVerified=false
independentHostAuthenticated=false
deploymentMembershipComplete=false
captureContinuityProven=false
canPublish=false
```

## Release gates

Require exact-HEAD Typecheck/Lint/Vitest with real-PG integration/Coverage/Build/Playwright and final independent security review. New DRAFT PR, never self-merge; separate user authorization plus Merge Commit/expected_head_sha and exact-master-SHA CI. Existing Issues #97 and #109 remain OPEN and independent. Phase 10 / Phase 3B production deployment remains blocked.
