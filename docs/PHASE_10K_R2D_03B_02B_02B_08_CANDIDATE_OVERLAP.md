# Phase 10K-R2d-03B-02B-02B-08 — Candidate cross-window overlap

**STATE: DRAFT / UNVERIFIED SUBMITTED DATA ONLY / NO PERSISTENCE / NO PRODUCTION IDENTITY OR KPI PERMISSION.**

## Purpose

Phase 02B-02B-07 checks the first and last submitted candidate checkpoint tips
of a single bounded window. Two separately valid windows can still
contradict each other, or contain no common checkpoint within their claimed
time overlap. This slice offers a **pure, bounded two-window comparison**
within one call. No independent collector or trusted persistence is added.

## Protocol

- Input is exactly two candidate windows (`earlier` and `later`).
  Each has a requested start/end and **2–64** candidate checkpoint tips;
  64 + 64 fits the existing 128-tip candidate fork scanner.
- Strict own plain-data snapshots are taken **once**. Unknown fields,
  accessors, symbol properties, invalid/scary Date impersonators, sparse or
  hostile input arrays and oversized sets fail closed. No caller-provided
  object is reread after snapshotting.
- Both windows must pass the existing candidate-only window-edge
  checker, each subject to its maximum 60-minute bound, its claimed
  sequence and clock requirements and submitted-edge bracketing.
- The two requested intervals must overlap by a **positive duration**.
  Their claimed principal, host and boot-session tuples must match.
- Compare the combined submitted tips with the preexisting candidate
  fork/digest-scope scanner. Duplicate exact tips collapse, and same-slot
  conflicting hashes/timestamps or reused digests are denied.
- Require at least one identical submitted
  `(principal,host,session,sequence,hash,observedAt,signedAt)` checkpoint
  appearing in both windows **with its observed timestamp inside the
  requested time overlap**. A tip repeated only outside the overlap is
  not a shared overlap anchor.
- The only affirmative reason is
  `CANDIDATE_SUBMITTED_OVERLAP_ONLY`, a statement exclusively about
  these two provided candidate sets. The response only returns a generic
  reason and a safe shared-anchor count, never IDs, digest values or
  credential/PII fields.

## What passing DOES NOT prove

The window bounds, timestamps, sequence numbers, hash values, scope IDs
and submitted sets are all controlled by the caller. Two internally
consistent overlapping windows can still omit entire machines, source
events, reboots, fork branches or capture outages.

Further, conflicting window pairs can each pass if submitted in
**separate calls**. Without a shared, durable and independently sourced
checkpoint authority, nothing discovers these omitted histories. The
comparator neither verifies signatures nor establishes a real host
identity or fleet-wide coverage.

Every outcome retains:

```text
independentProvisioningVerified = false
independentHostAuthenticated = false
deploymentMembershipComplete = false
captureContinuityProven = false
canPublish = false
```

## Excluded / independent release gates

No PostgreSQL migration or lock, Redis, database write, scheduler,
worker, HTTP ingress, Docker socket, host agent, private-key source,
key enrollment, production feature flag, capture authority, or KPI
publisher. Production use still requires independent observer ownership
and credential provisioning, durable concurrent-writer CAS, historical
capture/recovery tests, fleet census, source correlation and explicit
authorization. Keep Issue #97 OPEN as a separate historical flaky
ops-rollback work item.

## Acceptance

Three additive files only: pure checker, 20 adversarial unit tests and this
trust-boundary document. Require exact-HEAD Typecheck, Lint, Vitest with
coverage, Build, Playwright and final independent audit. PR remains DRAFT
until explicit user merge approval. If approved, use Merge Commit with
`expected_head_sha`, validate both Parent SHA values and
exact-master-SHA postmerge CI.
