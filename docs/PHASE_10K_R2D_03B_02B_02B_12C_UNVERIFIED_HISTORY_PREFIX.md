# Phase 10K-R2d-03B-02B-02B-12C — Refuse UNVERIFIED historical sequence gaps

**STATUS: candidate-only fail-closed integrity guard / not trusted / no rollout.**

## Discovered defect

The Phase 12A/12B opt-in writer checked only the latest journal record when deciding whether to append sequence `N+1`. The older `recordUnverifiedHostLifecycleClaimTx` method bypasses that guard and can leave a persisted journal with sequence 1 and sequence 4 but no 2/3. The opt-in writer could then accept sequence 5, making a subsequent chain look locally contiguous even though the historical prefix is invalid. This is a **local candidate integrity defect**; no production trust or publisher authority was ever granted.

## Scoped repair

In the existing READ COMMITTED, same-host/session advisory-locked transaction, read the latest persisted sequence, count stored rows of that exact host/session and inspect the actual sequence-1 row:

- Enforce `count === latestSequence`. Together with the existing SQL `UNIQUE(hostId,sessionId,sequence)` and `sequence >= 1`, this proves there are **no numeric holes in the stored local prefix**.
- The row at sequence 1 must be `BASELINE`, even if it was inserted by an older writer. Apply the prefix check **before** allowing any same-slot idempotent retry, so replay cannot disguise a dirty prefix.
- The query is intentionally bounded to `sequence <= 4096`; longer sessions fail closed rather than letting a request perform an unbounded history count. This is a consciously restrictive candidate-only resource gate, **not a scalable trusted checkpoint design**. Future operational support requires an independently managed durable cursor/CAS and resource proof.
- Keep unchanged the transaction owner policy fix (nonblocking `pg_try_advisory_xact_lock`, no `SET LOCAL`), full-identity comparison, current-event monotonic time and disconnect checks, sanitization, and caller-owned transaction commit/rollback.
- New real PostgreSQL rollback tests exercise legacy 1→4→5 hidden-gap refusal, dirty-prefix exact replay refusal, missing BASELINE, and a valid legacy 1→2→3 prefix retaining all false trust flags.

## Limitations and non-promotion

This is only a **numeric sequence + genesis-shape check** on the current database snapshot. It does not establish historical clock monotonicity, prove events occurred, prevent privileged direct SQL writes, bind independently signed identities, show the full deployment inventory, prove external receipt custody, or guarantee coverage across host reboot/session changes. Uncooperative legacy writers can still bypass this opt-in policy. A concurrent privileged bypassing writer is outside the advisory-lock protection. Therefore `independentProvisioningVerified=false`, `independentHostAuthenticated=false`, `deploymentMembershipComplete=false`, `captureContinuityProven=false`, and `canPublish=false` remain immutable.

No new migration, producer, credential, ingestion API, worker, Docker host-access, feature flag, or KPI publication change. Issue #97 and Issue #109 stay independently OPEN. Exact-head full Verify/real-PG/Vitest/Coverage/Build and Playwright must be green, plus independent final security audit, user authorization for Merge Commit with `expected_head_sha`, and exact-master-SHA CI. Phase 11 G1–G6 independent authority gates remain blocked.
