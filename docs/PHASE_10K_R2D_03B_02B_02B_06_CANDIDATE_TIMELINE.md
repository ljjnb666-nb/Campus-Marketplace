# Phase 10K-R2d-03B-02B-02B-06 — Candidate checkpoint timeline diagnostic

**STATUS: DRAFT / UNTRUSTED SUBMITTED-TIP CONSISTENCY ONLY / NO PERSISTENCE / NO CAPTURE AUTHORITY / NO KPI PUBLISHING.**

## Scope

Phase 02B-02B-05 can identify contradictory or reused checkpoint tips in
**one supplied set**, but does not check whether different sequence slots of
the same unverified principal, host and boot-session form a plausible
timeline. This slice performs that limited additional negative-only check.

- Accept 1–128 caller-submitted checkpoint tips. Snapshot them **once** into
  machine-only plain DTOs, checking exact fields and native Date internal
  slots. Reject getters, symbols, arbitrary metadata, forged dates, malformed
  sizes, sparse arrays, hostile Proxy traps and non-finite or negative dates.
- Reuse the Phase 02B-02B-05 candidate fork and hash-scope comparator on
  snapshots, so an inconsistent or malformed set cannot enter timeline
  checks. Original caller objects are not reread after snapshotting.
- Group by the JSON tuple of `principalId, hostId, sessionId`, then sort
  submitted checkpoints by monotonically increasing numeric sequence.
  Identical duplicate slots collapse.
- Within each submitted group, require the next sequence to equal the
  previous sequence+1, prevent observed/signature time rollback, and reject
  observed intervals greater than 15 minutes. IDs and receipt hashes never
  appear in diagnostic responses.
- Multiple principals or sessions are *not* considered independently
  authenticated. They are only separately evaluated candidate groups.

## Important missing-observation counterexamples

- A caller may give only one sequence-1 tip and receive an internally
  consistent result despite omitting every later observation.
- A different caller may give only sequence-3 and receive the same positive
  result. When the two tips are submitted **together** a missing sequence-2
  is detected, but the comparison function cannot join separate calls.
- A caller can omit an entire host, boot session or participant or falsify
  every field. The number of returned unique submitted slots is **not** a
  host census, independent inventory or proof that missing tips do not exist.
- All candidate receipt hashes, timestamps and identity claims originate
  from untrusted callers and lack a durable, transactional commit point.
  This does not prevent cross-process or cross-restart replay.

Thus a positive result has exactly one meaning:
`CANDIDATE_SUBMITTED_TIMELINE_ONLY` — no contradictions detected within
**this supplied set**, with no claim about anything unobserved or omitted.

Every response (including positive responses) retains:

```text
independentProvisioningVerified = false
independentHostAuthenticated = false
deploymentMembershipComplete = false
captureContinuityProven = false
canPublish = false
```

## Non-goals and release gates

No Prisma/SQL migration, database write, transaction, Redis checkpoint,
Docker access, private keys, credential provisioning, collector, HTTP
endpoint, job scheduling, runtime configuration or KPI publishing.

Separate review and authorization are still required for independent
observer provisioning, protected public-key distribution, crash-safe
PostgreSQL CAS checkpoints and competing-writer tests, independent host
fleet census, capture outage/failover evidence, true source reconciliation
and approved production release.

## Verification

The PR adds only three files: pure candidate timeline module, 20 adversarial
tests (including distinct requests concealing a missing tip), and this
negative trust-boundary document. Require exact-HEAD lint/typecheck,
Vitest/coverage, build, Playwright and independent security review. Do not
merge without explicit user authorization and Merge Commit expected-head
precondition; after merge, verify two parents and master exact-SHA CI.
Issue #97 remains OPEN and outside this PR.
