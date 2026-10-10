# Phase 10K-R2d-03B-02B-02B-04 — Unverified candidate receipt checkpoint transitions

**STATE: PURE TRANSITION PROPOSAL / NO PERSISTENCE / NO INDEPENDENT AUTHORITY / NO PRODUCTION ROLLOUT.**

## What the code actually provides

Phase 02B-02B-03 checks a bounded signed receipt chain starting with a
candidate BASELINE at sequence 1. This slice adds an isolated, bounded
single-session **checkpoint transition proposal** allowing incremental
batches to be checked against a caller-supplied checkpoint. Each request
produces only a new machine-only proposal. It does not write to the DB,
advance any trusted clock or persist anything across process restarts.

- A proposed checkpoint has exactly eight required fields: source
  `UNVERIFIED_CANDIDATE`, principal ID, host ID, session ID, last
  sequence, last candidate SHA-256 receipt hash, observation timestamp and
  detached-signature timestamp. No credential, signature, raw Docker payload,
  IP, user ID, release history or free text is stored.
- An optional prior checkpoint and 1–256 newly proposed receipts are
  snapped into allowlisted plain DTOs. Accessors, symbols, unknown properties,
  hostile arrays, non-Date impersonators and invalid machine identifiers
  fail closed with generic reason codes; no content is echoed.
- Each receipt reuses the canonical candidate receipt digest and the
  detached Ed25519 candidate verifier. Every expected predecessor must
  equal the proposed last receipt hash, and every sequence must increment
  by exactly one without gaps or duplicates.
- A batch starting from null must begin with candidate BASELINE sequence 1.
  When continuing a supplied checkpoint, host, principal and boot-session
  identity cannot change. Signer/key rotation within the same principal
  remains merely a candidate consistency result.
- Observed and signed times may not roll back, and adjacent observed
  intervals cannot exceed 15 minutes. Every signature must pass the
  existing at-check-time key validity and bounded-clock checks.
- A positive result is `CANDIDATE_CHECKPOINT_PROPOSAL_ONLY`, never a
  database commit, authenticated receipt or independently observed fact.

## Crucial fork and rollback limitation

A caller can supply the same candidate checkpoint twice and construct two
different, validly signed sequence+1 receipts. **Both independent calls may
pass**. Nothing here provides a PostgreSQL CAS, transaction ownership,
unique durably recorded (host, session, sequence), monotonic source
checkpoint, process crash recovery, or historical correction policy.

An in-memory proposal therefore proves neither durable anti-replay nor
observer session continuity. It must never be used as the authoritative
checkpoint for a production ingress route.

Every result, positive or negative, retains:

```text
independentProvisioningVerified = false
independentHostAuthenticated = false
deploymentMembershipComplete = false
captureContinuityProven = false
canPublish = false
```

All candidate public keys and fingerprints remain caller-injected. No
out-of-process observer, credential provisioner, Docker API reader or
durably anchored replay chain is being delivered. No Prisma schema,
migration, scheduler, HTTP endpoint, feature switch, KPI publisher or
production authorization changes.

## Future independently reviewed gates

1. A host/orchestrator-owned real observer with externally provisioned
   identity, revocation, scope, key rotation and independent operation.
2. A durable transaction/checkpoint CAS that detects same-sequence competing
   writes and crash/restart replay, with race and recovery test evidence.
3. Explicit unknown intervals, historical session boundaries, host fleet
   inventory completeness, per-instance stream-switch epochs and verified
   source emission correlation.
4. Explicit release authorization; existing production trust/publish gates
   remain blocked regardless of every candidate test passing.

## CI, review and merge policy

Scope exactly three additive files: pure proposal module, 18 adversarial
tests (including a **two-fork demonstration** that stays untrusted) and this
contract. Exact-HEAD typecheck, lint, full Vitest/coverage, production build,
Playwright and independent security review are mandatory. PR remains DRAFT
until review and explicit user merge authorization. After authorized merge
verify two parents and exact-master-SHA CI. Issue #97 remains a separate
historical ops rollback test stability issue.
