# Phase 10K-R2d-03A — Fleet capture continuity negative proof contract

**Status:** IMPLEMENTED CANDIDATE / UNTRUSTED CLAIM DIAGNOSTIC ONLY /
NO PRODUCTION ROLLOUT / NO PUBLIC METRICS.

## Why this slice exists

The repository already pins immutable release Git SHAs, has deploy readiness
checks and async-worker heartbeat logs, and R2d-02 reads immutable domain facts
and current-version projection receipts in a RepeatableRead snapshot.
None of those mechanisms proves the **absence of missing facts** throughout a
7/30-day cohort plus a further 7-day attribution tail.

Specifically: a process with perfect heartbeat and release SHA may coexist
with an older writer still handling some traffic, a disabled feature flag, a
producer bug, or a partial/failed rollout. A missing ledger event cannot reveal
which of those happened.

## R2d-03A contract

`diagnoseUnverifiedCaptureContinuity` inspects bounded, campus-scoped,
UNTRUSTED interval **claims** for five critical streams: listing creation,
listing-conversation creation, first reply, attributed order, and projection
worker. The union of intervals for each stream must span the complete
cohort + 7-day tail with no millisecond gaps. The diagnostic rejects invalid
release SHAs/instance identities, future or corrupt intervals, disabled claims
during the observation window, missing streams and truncated claim inputs.
Other campuses never contribute to a scope. An operator cannot derive other
tenant identities, instance names, secrets or release hashes from its output.

**Security invariant:** a claimed complete interval is NEVER a verified
deployment/fleet census. The result `canPublish` and
`captureContinuityProven` are permanently **false**, even when every claimed
interval is contiguous. This contract adds NO HTTP endpoint, analytics query,
metric registry version, producer writer, schema migration, state change or
production flag.

## R2d-03B requirements (not delivered here)

- A durable, independently verified owner of application and worker
  deployment/termination/rolling-update epochs (exact SHA, effective start/end,
  instance identity and membership), not just logs written by a running app.
- Persisted per-stream capture switch transitions with a monotonic clock,
  including startup downtime and partial rollouts. No self-assertion can prove
  instances that were omitted from the census.
- PostgreSQL/worker source inventory completeness and replay/late-arrival
  bounds for the entire requested cohort and attribution window.
- Per-campus authorization, fail-closed historical queries, retention/privacy
  review, gaps marked unavailable, operator-run evidence drills.
- Independent proof that projection receipt/watermark completeness is coupled
  to SOURCE emission completeness; one does not imply the other.
- Only after these checks could a distinct opt-in/published metric phase be
  considered. Current capture flags stay OFF, and R1 metrics stay UNAVAILABLE.

## Verification and release gate

Pure adversarial unit tests for gap, overlap, half-open boundaries, 30-day
cohort, wrong campus, disabled/invalid evidence, worker-only heartbeat,
spoofed SHA, duplicated claims and unpublishable fully-covered claims.
Then exact-head PR CI, independent review, explicit merge authorization,
followed by exact-master CI. No release toggle in this PR.
