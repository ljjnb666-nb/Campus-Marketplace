# Phase 10K-R2d-03B-02B-02B-01 — Candidate host observer signature contract

**State: DRAFT IMPLEMENTATION / CRYPTOGRAPHIC CANDIDATE ONLY / NO INDEPENDENT IDENTITY AUTHORITY / NO ROLLOUT.**

## Narrow goal

Implement a deterministic, versioned Ed25519 signature verification
primitive for lifecycle *candidate observations* already defined in
03B-02B-01 and sanitized/persisted as `UNVERIFIED` claims by 03B-02B-02A.

This slice changes **no database schema, no HTTP endpoints, no Docker
configuration, no CI credential provisioning, no production emitter, no
capture switches, no KPI publication logic**. The primitive consumes a
**caller-supplied public-key registry**. Its values are not automatically
trusted, and the primitive does not prove independent host ownership.

## Signature envelope contract

- `principalId` and globally identified `keyId` are bounded machine IDs.
- `signedAt` is a finite UTC timestamp.
- Signing bytes are the exact UTF-8 JSON tuple
  `["campus-marketplace-host-observer/v1", principalId, keyId,
  signedAt.toISOString(), claimKey]`, where claimKey is the canonical
  SHA-256 content digest of the full normalized observation.
- Signature message and key host-scope validation use the **same normalized\n  claim snapshot**, never a second read of a mutable caller-supplied host ID.\n  A malformed or throwing caller-injected registry fails closed.\n- Signature must be a canonical 64-byte Ed25519 detached signature encoded
  as unpadded base64url. Public key must be Ed25519 SPKI PEM.
- Key record scope must match both the claimed principal and host. Key
  lifetime must include both `signedAt` **and verifier runtime time**; expired
  or revoked keys fail closed without post-expiry grace periods. Public-key
  PEM parsing is bounded (64–2048 characters), and only Ed25519 is accepted.
- The verifier uses runtime `Date.now()`, not caller-provided `now`.
  The signed clock may deviate by at most 5 minutes; the observation may
  be at most 15 minutes older than the signed timestamp and at most 5
  minutes in its future. The bounds are not user-controlled.
- No host identity, private key, signature or raw event JSON is included in
  the diagnostic output. A cryptographic match is explicitly labeled
  `CANDIDATE_SIGNATURE_MATCH_ONLY`.

## Why this is not an authentication or publication milestone

Anyone who can supply a substitute registry can generate a matching key
pair and obtain a `cryptographicSignatureMatches=true` result. Even a
correct Ed25519 signature says only that the signer had a private key for
the supplied public key — not that the key belongs to an independent
host/orchestrator-owned principal.

The output is **unconditionally**:
`independentHostAuthenticated=false`,
`deploymentMembershipComplete=false`,
`captureContinuityProven=false`, and `canPublish=false`.

Future, separately gated slices must implement independent enrollment
and public-key pinning; key rotation and revocation ownership; replay
resistance across restarts with durable monotonic sequence/receipt
checkpoints; securely restricted transport and host scope; failure and
disconnection continuity; actual privileged observer deployment with
least privilege; independently observed fleet census; per-instance
capture-switch history; source event reconciliation; and production
recovery drills. Reusing application metrics bearer credentials,
NextAuth secrets, or signed self-reports is forbidden.

## Verification

Pure unit coverage shall include valid cryptographic match (without
trust promotion), missing registry, altered content, forged signature,
principal/key/host mismatch, revocation/rotation window, non-Ed25519
public key, malformed base64url, signed clock skew, observation drift,
privacy-safe output and explicit acknowledgement that signature checks
alone cannot reject identical replays.

Exact-HEAD CI and independent audit are required before this PR can be
considered for explicit merge approval. Production Phase 3B stays blocked.
