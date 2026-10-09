# Phase 10K-R2d-03B-02A — Candidate fleet roster gap diagnostics

**State: IMPLEMENTATION CANDIDATE / NEGATIVE-ONLY / NOT AN INDEPENDENT AUTHORITY.**
No production rollout, new DB table, API, public UI, flag activation, or conversion-rate publication is authorized by this slice.

## Why this distinct slice is necessary

R2d-03A can identify gaps in the **union** of untrusted capture claims. The union is not sufficient during a rolling deployment. An old app and a new app can both accept traffic; coverage from only one app can span the whole window while the other never emitted required facts.

R2d-03B-02A introduces a **candidate roster vs per-instance/stream** cross-check.
For each 7- or 30-day cohort plus its 7-day attribution tail, it:

- Checks proposed fleet epochs as half-open intervals without any millisecond gap or conflicting overlap, and validates bounded unique instance IDs and exact lowercase deployment SHAs.
- Requires APP and ASYNC_WORKER instances in every covered epoch.
- During rolling updates requires **both** listed old and new APP instances to have continuous enabled UNVERIFIED claims for each of four app streams, and each listed ASYNC_WORKER to have PROJECTION_WORKER claims.
- Never borrows another campus, instance, SHA, or stream to fill missing claims. Disabled claims are negative evidence.
- Returns only scoped reason codes and clearly prefixed candidate diagnostics, never instance IDs, tenant data, deployment secrets, event payloads or raw user content.
- Bounds inputs at 512 epochs, 128 instances per epoch, 2,048 total instance-epochs, and 10,000 claims.

**No trust escalation:** Any candidate roster can omit an unreported instance. An application and a deploy-log string cannot prove the completeness of an orchestrator's instance inventory. Even with zero gap reasons the returned fields canPublish, captureContinuityProven, and deploymentMembershipComplete are permanently false. A true value for allListedInstancesHaveClaims means **only** that the submitted rows are internally consistent. It never proves emission or roster completeness.

## Why Docker Compose and release logs do not close the authority gap

Production Phase 3B (real external deployment) remains deferred in the deployment documentation. Existing deploy.sh records a readiness-gated release artifact set, not all process births/deaths or every historical capture flag epoch. Neither a current Docker ps response nor a successful readiness probe certifies the absence of unobserved containers, prior outages, rolling update races or disabled producer code.

### Remaining Phase 03B-02 independent evidence gates

1. A separately owned host/orchestrator observer with explicit workload namespace and exhaustive membership enumeration, startup baseline, Docker event sequence continuity, reconnect gap detection, restart/stop/failure events, multi-host membership if future topology changes, exact image digest and Git release SHA, and immutable audit identity.
2. Durable authenticated replay-resistant observation ingestion with independent writer credentials, bounded time drift, source-of-truth checkpoints, explicit UNKNOWN intervals and an operational correction protocol. Application/worker self-reports cannot sign their own completeness.
3. Independently captured **per-instance and per-stream** effective enable/disable epoch history, including environment/config, rollout overlap and revisions. Current environment values or revisions alone are not history proof.
4. Role permissions, retention, privacy review, restore/replay/failover tests. Lost observations, missing observer, duplicated/reordered sequences, zero-instance periods and pre-installation histories remain UNKNOWN/UNAVAILABLE.
5. R2d-03B-03 source event and historical reconciliation must separately prove source emission completeness. Even a perfect fleet roster is not source completeness proof.

No Phase 03B PR directly changes the R2d-03A negative-only evaluator, R2d-02 unproven gate, or any production capture switch. KPI publication requires a separate, independently approved release gate.

## Verification

Pure adversarial tests cover mixed-release rolls, missing listed instances, one-millisecond gaps, overlaps, absent worker/app, disabled claims, wrong campus/SHA, forged provenance, 30-day windows, invalid inputs, bounds and redaction. Exact-HEAD Verify and Playwright CI, independent review, explicit merge approval and exact-master post-merge CI remain mandatory.
