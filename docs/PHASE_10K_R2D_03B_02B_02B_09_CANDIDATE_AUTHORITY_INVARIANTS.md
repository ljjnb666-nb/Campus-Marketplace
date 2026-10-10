# Phase 10K-R2d-03B-02B-02B-09 — Candidate authority non-promotion regression

**STATE: DRAFT / NEGATIVE-ONLY CROSS-MODULE REGRESSION / NO PRODUCTION TRUST OR RELEASE CHANGE.**

## Reason for this slice

Phases 04–08 added five distinct candidate-only diagnostics: checkpoint
proposal, same-batch fork scan, submitted timeline scan, single-window
bracketing and two-window overlap comparison. Each performs only a
caller-supplied, in-memory consistency check. A subtle future refactor
might accidentally reinterpret an internally consistent *candidate*
as independently verified host identity, complete capture or permission
to publish. This slice establishes a consolidated regression gate
covering all five consumers, not a sixth ingestion pathway.

## Test coverage

The new adversarial cross-module test file verifies:

- A positive candidate fork/timeline/window/overlap result always retains
  every production-authority bit set to false.
- A missing registry and empty checkpoint receipt batch cannot create a
  trusted checkpoint or authorize publishing.
- Spoofed `source`, extra student PII/metadata, symbolic properties,
  accessor-based objects and forged Date impostors fail closed.
- Same-slot forks, reused receipt hashes across sequences, missing
  sequence numbers, time rollback, missing interval boundaries and
  inconsistent cross-window anchors cannot elevate trust.
- Two forked candidate tips submitted in separate calls can each appear
  locally consistent; this false negative is intentional test evidence
  of the missing durable compare-and-swap authority.
- Caller-supplied fabricated host labels can produce internally
  consistent candidate results, but never become host attestation.
- Diagnostics do not disclose submitted host/principal/hash values,
  and pure checks do not mutate the provided timestamps or hashes.
- Sparse candidate batches fail closed and do not create authority.

## Trust and ownership boundaries

No observer key is independently provisioned or authenticated; no host
inventory is independently gathered; no cross-process or crash-safe
checkpoint transaction exists. These tests may indicate internal
consistency **only for one caller-submitted set**, and cannot prove
genuine capture, host authenticity, missing-event absence, replay
resistance, fleet-wide completeness or source reconciliation.

All candidate diagnostics must return:

```text
independentProvisioningVerified = false
independentHostAuthenticated = false
deploymentMembershipComplete = false
captureContinuityProven = false
canPublish = false
```

This PR changes no production code, Prisma/SQL, Redis, HTTP surface,
background worker, Docker collector, privileged identity, signing key,
feature flag, CI configuration or KPI publisher.

## Approval gate

Only **two additive files**: a cross-module adversarial Vitest test
suite and this contract document. Require exact-HEAD Typecheck, Lint,
full Vitest/coverage, Build, Playwright and independent audit. Do not
merge without separate explicit user approval and expected-head Merge
Commit, followed by verified two-Parent and master exact-SHA CI.

Issue #97 remains independently OPEN. Production observer trust stays
NOT AUTHORIZED even if this test suite is entirely green.
