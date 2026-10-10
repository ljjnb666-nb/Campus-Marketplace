# Phase 10K-R2d-03B-02B-02B-03 — Candidate signed receipt chain

**STATE: DRAFT / IN-MEMORY NEGATIVE-ONLY DIAGNOSTIC / NO INDEPENDENT OBSERVER / NO DURABLE REPLAY CHECKPOINT / NO PRODUCTION ROLLOUT.**

## Scoped goal

After the detached Ed25519 signature primitive (02B-02B-01) and
caller-provided SPKI candidate pin catalog (02B-02B-02), check whether a
**single submitted host+boot-session set** of signed lifecycle observations
is internally ordered and linked by candidate cryptographic hashes.

The verifier does not own its public-key registry. All candidate receipts,
keys and fingerprints remain caller-injected and potentially forged. A
cryptographically matching signed link is NOT an independent host credential
or evidence of actual capture. No production API or durable observer exists.

## Exact link and state-machine contract

- Each link contains a detached signed observation envelope, its predecessor
  hash (null for genesis) and a lowercase 64-hex candidate receipt hash.
- Receipt hash is SHA-256 of the versioned JSON tuple:
  `["campus-marketplace-candidate-host-receipt/v1", previousReceiptHash,
  canonicalSigningBytesBase64url, detachedSignatureBase64url]`.
  The signing bytes already bind a canonical SHA-256 host claim, principal,
  key epoch and signed timestamp. A receipt hash is NOT a signature or MAC.
- The chain is bounded to 1–512 links. Inputs must be plain own-property
  machine DTOs without getters, symbols or extra metadata. Observation
  roster entries contain only instance ID, role and deployment SHA.
  Date fields are snapshotted, and raw Docker metadata, labels, IPs, logs,
  email/user identity and credentials are never carried into diagnostics.
- Every envelope's Ed25519 candidate signature is checked against the
  **caller-injected**, hence UNTRUSTED key registry from earlier phases.
  Revoked/expired credentials, forged signatures and clock skew fail closed.
- First link MUST contain a BASELINE with sequence=1 and no predecessor.
  All subsequent links must exactly reference the preceding receipt hash.
  Host ID, principal and boot/session ID must remain constant.
  Sequence increments by exactly one; no duplicate/reorder/gap is accepted.
  Observation and signature times must never move backward. The interval
  between observations cannot exceed 15 minutes.
- Key IDs may rotate within one principal/host session if each candidate
  public key and signature matches. This is **not** an authenticated key
  rotation or revocation authority.
- Every rejection yields only generic diagnostic codes, no signature, hash,
  host ID, principal ID, release SHA or user/sensitive content.

## Hard negative-only authority

Even when every submitted receipt is internally consistent:

```text
candidateChainInternallyConsistent = true  # submitted rows ONLY
independentProvisioningVerified = false
independentHostAuthenticated = false
deploymentMembershipComplete = false
captureContinuityProven = false
canPublish = false
```

In particular, a matching candidate chain **cannot prove that no unsubmitted
receipts exist** or that a missing observer, new boot session, rolling
deployment, network outage, skipped Docker event or a silent period did not
occur. A process restart forgets the in-memory predecessor: this module
provides **NO cross-process or cross-restart replay protection**. It must
not be used as a trusted ingress gate, credential authority or KPI publisher.

## Deliberate non-goals and release blockers

No Prisma migration, HTTP endpoint, background worker, Docker socket reader,
external private keys, secret handling, independent enrollment, durable
receipt ledger/checkpoint, key distribution, immutable evidence promotion,
capture activation or KPI publication. Existing UNVERIFIED database journal
is unchanged.

Future independently reviewed work still requires:

1. Out-of-app independent observer credential provisioning, protected
   fingerprint distribution, host/workload scope and revocation authority.
2. Durable, transactional, crash-safe monotonic host/session/sequence
   checkpoints with replay/conflict detection, persistent gap state, restart
   and concurrent-writer tests, and clear recovery semantics.
3. Actual least-privileged host process and failover/reconciliation drills;
   exhaustive historical fleet census and per-instance stream switches.
4. Source-fact completeness reconciliation and separately approved release.

## Verification and merge gate

Only three additive files: pure candidate-chain module, adversarial Vitest,
and this trust-boundary document. Test missing/gap/replay, altered predecessor,
wrong signer/key, key rotation, session/scope change, timestamp rollback and
silence, malformed/accessor/oversized inputs and redacted results. Require
exact-HEAD Typecheck, Lint, full Vitest/coverage, Build, Playwright, independent
review and **explicit user approval** before any Merge Commit. Verify both
parents and exact-master-SHA CI after merge. Issue #97 stays independent.
