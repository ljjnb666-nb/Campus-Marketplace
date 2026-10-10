# Phase 10K-R2d-03B-02B-02B-07 — Candidate window-edge bracketing

**STATE: DRAFT / CANDIDATE SUBMITTED DATA ONLY / ZERO HOST CAPTURE AUTHORITY / NO DURABLE REPLAY PROTECTION / ZERO KPI PUBLICATION RIGHTS.**

## Narrow purpose

The previous candidate timeline diagnostic (02B-02B-06) can accept a
single submitted tip as locally consistent. Such a candidate cannot
establish coverage at the beginning or end of a requested interval.
This slice rejects supplied candidate sets that **do not bracket the
requested time interval**. The window, timestamps, hashes and host
identities remain caller-controlled and untrusted.

## Contract

- The request supplies a `windowStart` and `windowEnd` with an elapsed
  interval greater than zero and no more than 60 minutes, plus 2–128
  candidate checkpoint tips. All input is plain-data machine DTO shape.
- Dates use native Date internal-slot reads; forged getters, symbols,
  unexpected fields, null/negative/invalid timestamps, malicious proxies,
  missing sparse-array entries, malformed IDs, sequences and hashes fail
  closed with reason-only diagnostics and no echoed personal or host data.
- Every candidate tip is snapshotted exactly once, then the snapshot set
  passes the earlier fork/digest-scope comparator. Duplicate exact tips
  collapse. Contradictions and reuse of digest across different slots
  are denied before timeline evaluation.
- A single window request must contain tips from one claimed principal,
  host and boot session. Order by sequence and require sequence+1,
  non-rollback of observed/signing time and no more than 15 minutes
  between consecutive **submitted** observed timestamps.
- The earliest submitted tip must have observed timestamp no later than
  the requested window start but no more than 15 minutes earlier.
  The latest submitted tip must be at or after the window end, but no
  more than 15 minutes later.
- The only positive code is `CANDIDATE_SUBMITTED_WINDOW_BRACKET_ONLY`,
  meaning *a submitted sequence and timestamps bracket the user-supplied
  requested window*. It is NOT an independently observed duration or proof
  that any real Docker/workload event occurred.

## Deliberate blind spots and authority denial

This is neither a full fleet census nor an operational monitor:

- A malicious producer may fabricate all checkpoint timestamps, IDs
  and hashes or omit entire hosts, sessions, or events.
- Two sets that individually bracket a window may be contradictory if
  never submitted together. An in-memory comparator cannot discover
  separated forks or persist replay checkpoints.
- A signed receipt elsewhere in the product is only as independent
  as its caller-injected keys. This pure function does not even ingest
  signatures: it accepts candidate checkpoint *tips*, not source facts.
- A continuous submitted sequence is compatible with an unknown outage,
  process restart, missing capture adapter or falsified observations.

**Every result, including positives, unconditionally retains:**

```text
independentProvisioningVerified = false
independentHostAuthenticated = false
deploymentMembershipComplete = false
captureContinuityProven = false
canPublish = false
```

No Prisma migration, SQL/Redis CAS, trusted endpoint, provider enrollment,
Docker socket reader, worker, queues, CI secrets, operational switches,
real capture, source reconciliation or production KPI publisher is added.
Actual continuity, recovery and authorization are blocked on independent
observer provisioning, durable transactional CAS with concurrent writers,
host census, capture-gap drill evidence and explicit release approval.

## Review requirements

Exactly 3 additive files: pure candidate-bracketing module, 21 adversarial
tests and this trust-boundary document. Require exact-HEAD Typecheck, Lint,
Vitest/coverage, Build and Playwright, independent security review and
explicit user merge authorization. On authorized Merge Commit check
`expected_head_sha`, both parents, and master exact-SHA CI.
Issue #97 remains separately OPEN.
