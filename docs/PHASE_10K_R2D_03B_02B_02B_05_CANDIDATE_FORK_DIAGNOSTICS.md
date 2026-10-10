# Phase 10K-R2d-03B-02B-02B-05 — Candidate checkpoint fork diagnostics

**STATUS: DRAFT / PURE BOUNDED COMPARISON / NO INDEPENDENT AUTHORITY / NO PERSISTENCE / NO PRODUCTION ROLLOUT.**

## Purpose and exact evidence boundary

The earlier 02B-02B-04 phase introduced an unverified **proposal** to
advance a single caller-supplied receipt-chain checkpoint. Two competing
`sequence+1` proposals from the same checkpoint can both appear locally
consistent, because no durable transactional compare-and-swap (CAS) exists.

This slice introduces a **pure diagnostic comparator** for a single bounded
set of candidate checkpoint tips. It can detect forks *only when both
contradictory proposals are explicitly included in this same call*. It
does NOT scan the real fleet, historical storage, or other processes.

## Comparison rules

- Input: 1–128 plain own-property `UnverifiedCandidateReceiptCheckpoint`
  records, each containing exactly source, principal, host, boot/session,
  sequence, last candidate receipt SHA-256 hash, observed timestamp and
  signature timestamp. Reject unexpected keys, symbols, accessors,
  malformed IDs/digests, invalid sequence, forged/negative/nonfinite dates
  and excessive observed-vs-signed future clock skew.
- The collision key is a JSON tuple of principal, host, boot/session and
  sequence; JSON avoids ambiguous concatenation even when IDs contain
  permitted punctuation.
- Identical repeated tips for a key are collapsed.
- Two tips for the **same** tuple with conflicting last receipt hashes
  or contradictory timestamps are denied with
  `DENIED_CONFLICTING_CANDIDATE_TIPS`.
- One identical candidate receipt digest reused across different
  principal/host/session/sequence scopes is denied with
  `DENIED_CANDIDATE_HASH_SCOPE_REUSE`.
- Different principals may produce distinct tips on the same host. Even a
  positive result remains `CANDIDATE_SUBMITTED_TIPS_NO_CONFLICT_ONLY`;
  it does NOT identify which principal, if any, owns that host.
- All diagnostics contain only generic reasons and safe counts, never
  host IDs, checkpoint hashes, private keys, Docker metadata or user data.

## Critical failure model and denied trust escalation

A caller can submit two forked tips in **separate calls** and receive
`CANDIDATE_SUBMITTED_TIPS_NO_CONFLICT_ONLY` for both calls. An adversary can
also omit any fork entirely. The comparator does not see unsubmitted
candidates and does not provide a shared atomic ingestion boundary.
The unit tests deliberately demonstrate these false negatives.

Thus this is **NOT** durable replay protection, an independent observer,
host enrollment, a fleet census, deployment membership attestation,
a cryptographic source of truth or authorization for any KPI.

Every response unconditionally returns:

```text
independentProvisioningVerified = false
independentHostAuthenticated = false
deploymentMembershipComplete = false
captureContinuityProven = false
canPublish = false
```

## Exact excluded scope

No Prisma migration, database write, Redis, transaction/lock, endpoint,
worker, Docker socket, key provisioning, runtime secret, CI config change,
collector activation, feature flag or publishing permission.

Future authorization still requires an independently controlled observer
identity and protected key enrollment, durable transactional checkpoint CAS
with crash/restart and concurrent-writer tests, independently gathered host
census and capture-switch history, source event reconciliation and explicit
release gates. Issue #97 stays separately OPEN.

## Verification

Exactly three additive files: standalone pure comparator, 20 adversarial
unit tests (including mixed-scope hash reuse and separate-call fork
blindness), and this boundary document. Require exact-HEAD CI typecheck,
lint, all Vitest/coverage, production build, Playwright, independent review
and user-authorized merge. Following Merge Commit, verify two parents and
master exact-SHA CI before proceeding.
