# Phase 10K-R2d-03B-02B-02B-02 — Candidate Observer Principal / SPKI pin catalog

**State: DRAFT / CANDIDATE CATALOG ONLY / NO INDEPENDENT PROVISIONING AUTHORITY / NO PRODUCTION ROLLOUT.**

## Goal and exact trust boundary

The immediately preceding Phase 02B-02B-01 introduced a detached Ed25519
candidate-signature verifier against a **caller-injected**, therefore forgeable,
public-key registry. This slice provides a strict, bounded *candidate* key
catalog that can prepare machine-only principal/host/key epoch descriptors
and verify the caller-supplied SHA-256 fingerprint against actual canonical
Ed25519 SPKI DER bytes.

**This is NOT enrollment in an independently controlled observer registry.**
A caller can generate a new Ed25519 key pair, put the corresponding public
key and its matching fingerprint in the candidate input, and pass every
validation rule. The catalog cannot establish who owns that key or host.
No trust root, enrollment approval, out-of-process provisioning, private
key material, hardware binding or production observer is created.

## Candidate pin contract

- Each entry requires exactly 8 own plain data properties: `principalId`,
  `hostId`, `keyId`, `publicKeyPem`, `spkiSha256`, `validFrom`,
  `validUntil`, and `revoked`. Unknown properties, accessor properties,
  symbols, inherited inputs, raw Docker metadata and free text are rejected;
  all failures use generic negative reason codes.
- Principal, host and key identifiers use the same bounded machine-ID grammar
  as the observer signature contract. There are at most 128 pin entries.
  A `keyId` and an Ed25519 SPKI fingerprint are each globally unique.
- All epochs belonging to one principal must specify the same host; distinct
  principals may share a host for future redundancy. Different keys for a
  principal may have overlapping validity during a deliberately staged
  rotation, but reusing the same private/public key across epochs is rejected.
- Public key must be canonical Ed25519 **PUBLIC KEY SPKI PEM**, not a private
  PEM, RSA, modified PEM, oversized input or noncanonical serialization.
  `spkiSha256` is lowercase SHA-256 of exported canonical SPKI **DER bytes**
  and must match the supplied public key. It is **not an authenticated
  fingerprint** because both values come from the same caller.
- Epoch bounds are finite and nonnegative, with exclusive `validUntil`.
  The catalog stores numeric snapshots and returns fresh Date objects so
  callers cannot mutate its internal validity windows. Revocation remains
  an explicit boolean; verification-time expiry/revocation is enforced by the
  existing detached-signature verifier, not claimed as an enrollment step.
- Returned `getCandidateKey` is a candidate-only key lookup, not a trusted
  application registry. A valid catalog returns only
  `CANDIDATE_PINSET_CONSISTENT_ONLY`; it never asserts that the independent
  principal owns the signed host observations.

## Absolute negative-only authority

For all inputs and outputs, including a cryptographically consistent pinset:

```text
independentProvisioningVerified = false
independentHostAuthenticated = false
deploymentMembershipComplete = false
captureContinuityProven = false
canPublish = false
```

No Prisma schema or migration, HTTP ingress, user-facing interface, Worker
producer, Docker socket read, environment variable, CI secret, host deployment,
metric publisher or capture-switch activation is added.

## Follow-up gates: deliberately still blocked

1. An independently controlled principal enrollment root, exact host/workload
   scoping, approved fingerprint pin distribution and privileged-reader
   separation from application/worker credentials.
2. Durable signed receipt journal, monotonic per-host boot/session/sequence
   checkpoint, conflict/replay rejection across process restarts and explicit
   unobserved gaps.
3. Key rotation and revocation owned by the independent authority, including
   safe recovery, trust-root change and fail-closed expired-key behavior.
4. Real least-privileged host collector deployment, fleet census, outage and
   failover drills, independent effective capture-switch history and source
   event reconciliation.

None of these may be inferred merely from `CANDIDATE_PINSET_CONSISTENT_ONLY`
or `CANDIDATE_SIGNATURE_MATCH_ONLY`. Production evidence/KPI publication
remains blocked.

## Review and CI gates

This is a three-file additive pure-contract slice. Adversarial tests cover
principal/host/key collisions, SPKI fingerprint and algorithm confusion, PEM
private-key rejection, excess metadata and getters, malformed timestamps,
rotations, revocations, mutable Date aliasing, pathological inputs and
integration with the previous negative-only signature verifier.

Require exact-HEAD typecheck, lint, full Vitest/coverage, production build,
Playwright E2E, independent security review and explicit merge authorization.
On approved merge verify both Parent SHAs and exact-master-SHA CI.
Historical ops rollback instability remains separate Issue #97.
