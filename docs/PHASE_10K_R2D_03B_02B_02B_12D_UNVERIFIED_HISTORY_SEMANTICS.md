# Phase 10K-R2d-03B-02B-02B-12D — UNVERIFIED historical semantic guard

**STATUS: scoped, local candidate-only integrity / NOT an independently trusted observer / NO ROLLOUT.**

## Audited failure mode

12C checked a gap-free numeric sequence prefix and that sequence one was a BASELINE, but it did not inspect the **semantics of older persisted entries**. The still-existing unguarded internal writer could create an otherwise gap-free legacy sequence with a duplicate BASELINE, an observation clock rollback, a silence interval over 15 minutes, or events after DISCONNECTED. Without historical inspection, the current guard could append a new record or return an exact-slot replay success and obscure the prior semantic breach.

## Scoped fix and ownership

While holding the existing scoped, fail-fast PostgreSQL advisory **transaction** lock in a caller-owned READ COMMITTED transaction, and **only after 12C's max-4096 tip/count/genesis gate**, run one bounded ordered SQL window query over the stored candidate host/session prefix:

- For each historical entry after sequence one: reject any extra BASELINE.
- Reject an entry if the preceding kind was DISCONNECTED.
- Reject a timestamp earlier than the prior entry, or more than 15 minutes later.
- Require the query to return exactly one Boolean `invalid=false` result, otherwise fail closed with the existing generic error.
- Run this check **before** same-slot exact-retry handling or new writes; keep existing immutable row identity and current-event checks unchanged.

The count/unique/positive-sequence invariants still establish the numeric prefix; this slice adds a local semantic screening for the already persisted rows. This is O(N) on the scoped prefix and **N must be at most 4096**; larger sessions remain fail-closed. There is no backfill, repair, reconciliation, producer modification or generalized historian.

## Real PostgreSQL regression and limitations

Four new roll-back-only real-PG tests check duplicate BASELINE (including old-record exact retry), clock rollback, >15-minute historical silence, and continuing after DISCONNECTED; previous valid-prefix and idempotency, concurrent lock, caller transaction policy, count, time and numeric gap tests remain.

A passing bounded database scan says only that this current database snapshot of the **UNVERIFIED** candidate stream is internally consistent under these checks. It does **not** prove events occurred, external custody, timestamp authenticity, independent host enrollment or fleet census, crash survival, cross-session coverage, lack of bypassing privileged/direct DB writers, or prospective continuity. The old journal writer remains capable of bypassing this opt-in seam. No new external credential, migration, API, scheduler, producer, Docker privilege, host collector, feature flag or KPI publication is introduced.

All permission/proof flags must remain false: `independentProvisioningVerified=false`, `independentHostAuthenticated=false`, `deploymentMembershipComplete=false`, `captureContinuityProven=false`, `canPublish=false`. Phase 11 G1–G6 and production KPIs remain blocked; Issue #97 and #109 stay independently OPEN.

Require exact-HEAD CI dual success, real-PG integration evidence, independent security review, explicit user-authorized Merge Commit + `expected_head_sha`, two Parent SHA validation and exact-master-SHA dual CI. Do not self-merge.
