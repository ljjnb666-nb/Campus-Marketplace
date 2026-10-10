# Phase 10K-R2d-03B-02B-02B-12E — UNVERIFIED instance lifecycle consistency

**STATUS: opt-in local candidate integrity only / NO external authority / NO rollout.**

## Defect and invariant

Phase 12C rejects gaps and invalid genesis, Phase 12D rejects duplicate BASELINE, historical time rollback, >15-minute silence and events after DISCONNECTED. But numeric/time-valid legacy candidate journals may still encode impossible per-instance START/STOP transitions: START for an instance already present in the baseline/running set, STOP for an absent instance, or STOP with a different release SHA/role than the currently running instance. The guarded caller likewise could append such transitions.

## Scoped repair

Under the existing caller-owned READ COMMITTED transaction and fail-fast per-host/session PostgreSQL advisory transaction lock, **after the 12C bounded numeric integrity and 12D bounded time/kind checks**:

- Read only baseline / START / STOP rows for the same candidate host+session in sequence order. Existing per-session prefix limit is **4096**, so this second bounded scan is permitted for candidate-only internal use; it is not a scalable external historian.
- Re-parse the persisted BASELINE through the existing `prepareUnverifiedHostLifecycleClaim` allowlist validator, initializing the machine-only running map keyed by `instanceId` with `releaseSha` and `role`.
- Replay historical START only if the instance is absent; historical STOP only if that exact instance+release+role is currently running. Any contradiction fails closed. This runs **before** same-slot retry results.
- Validate a newly proposed START/STOP against this reconstructed state. Existing exact retries are not double-applied. Never mutate the historical rows or caller transaction's SQL session settings. All errors remain the generic `UNVERIFIED_HOST_SEQUENCE_REFUSED`.
- 4 new real PostgreSQL rollback-only regression tests cover legacy duplicate START, legacy orphan/mismatched STOP, proposed invalid/valid transitions and exact retry, and a valid legacy process transition prefix.

## Exclusions and release gates

Running map consistency is merely a self-consistency property of **UNVERIFIED** local journal content, not independent proof that any process ever existed or ran on the host. This patch does not authenticate host identity, attest deployment membership, monitor Docker, establish external durable custody, close cross-session gaps, remove the older unguarded writer, or guard against privileged/noncooperating writes. No migration, route, feature flag, worker privilege, credential, scheduler, publisher or KPI input changes.

`independentProvisioningVerified=false`, `independentHostAuthenticated=false`, `deploymentMembershipComplete=false`, `captureContinuityProven=false`, `canPublish=false` remain unchanged. Issue #97 and #109 independently OPEN, all Phase 11 G1–G6 and production KPI trust gates blocked.

Require complete exact-head CI (Typecheck, Lint, real-PG Vitest/Coverage, Build, Playwright), independent audit and separate explicit user merge approval. Merge Commit + expected_head_sha, validate both Parent SHA, master HEAD and exact-master-SHA dual CI. This document grants no merge or rollout permission.
