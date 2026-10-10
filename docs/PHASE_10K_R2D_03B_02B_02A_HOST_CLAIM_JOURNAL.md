# Phase 10K-R2d-03B-02B-02A — Unverified host lifecycle evidence journal

**State: IMPLEMENTATION CANDIDATE / INTERNAL ONLY / UNVERIFIED / NO HOST AUTHENTICATION.**

This is the first bounded slice of **Phase 03B-02B-02** (persistence and
authentication boundary). It adds **only a durable claim store** for host
lifecycle observations defined by Phase 03B-02B-01. It is NOT an
independently authenticated host observer, fleet completeness attestation,
production deployment milestone, emission proof, or KPI publication grant.

## Data ownership, idempotency and failure model

- The Prisma `HostLifecycleClaim` table and PostgreSQL migration preserve a
  machine-only, strictly shaped observation candidate:
  `hostId`, `sessionId`, positive `sequence`, observed timestamp, event kind,
  optional START/STOP instance identity or sanitized BASELINE member roster.
- BASELINE machine members are canonicalized/sorted with an exact allowlist
  (instance ID, lowercase Git release SHA, APP/ASYNC_WORKER role). Unknown
  fields, environments, raw Docker payloads, labels, user identity, IP,
  credentials and free text are never copied into the persisted snapshot.
- The deterministic SHA-256 `claimKey` is a **content identifier only**;
  it is **not a MAC, signature, credential, chain of custody or observer proof**.
  A caller can forge a key. Database CHECK and application contract constrain
  shape; neither authenticates the host.
- Unique `(hostId, sessionId, sequence)` enforces per-session sequence
  idempotency: an identical retry is a no-op, conflicting same-sequence data
  throws and rolls back. Ingestion does not invent a missing sequence or
  repair gaps. Phase 02B-01's replay diagnostic remains responsible for
  negative gap detection, and is not driven by a new production read path.
- DB CHECK freezes `source='UNVERIFIED'`, requires finite observed
  timestamps, and enforces kind-specific payload shape. A PostgreSQL insert
  trigger overwrites `recordedAt` with server statement time, validates each
  baseline member, and **replaces raw JSON TEXT with the validated JSONB
  normalized serialization**. This prevents shadowed duplicate JSON keys
  from retaining a sensitive value discarded during validation. The internal
  writer compares semantic canonical member identity instead of the raw JSON
  whitespace/key order. UPDATE/DELETE/TRUNCATE are explicitly refused for
  ordinary application DML roles. This defense is not tamper-proof against DB
  superusers or privileged schema operators; separate audit and role control
  are still required.
- Table/constraints/indexes/triggers are created inside one BEGIN/COMMIT
  migration, without any historical backfill or production job scheduling.
  Test fixtures roll back, so tests do not create fake fleet evidence.

## Credential and observer authority boundary: NOT YET SATISFIED

This slice provides **no HTTP endpoint, background producer, host Docker
socket reader, provisioning, shared secret, operator-selected certificate,
external transport, credential storage, authentication verification, key
rotation or network trust admission**. `recordUnverifiedHostLifecycleClaimTx`
is an internal transaction helper with an explicit unverified contract, not
an ingress endpoint. An internal caller could submit fabricated claims;
its presence alone must not be called a secure external intake.

The remaining Phase 03B-02B-02 work needs independent provisioned observer
principals, a separate worker/host account (never the app's own API auth),
host/workload scoping, signed payload binding to host/session/sequence/time,
replay and conflict rejection, short bounded time skew, receipt chaining,
credential rollover/revocation, a durable observation gap checkpoint and
real infrastructure/failover tests. Provisioning must be controlled outside
the app and **do not ship plaintext secrets in Git, CI, DB or logs**.
The full multi-host member census and historical per-stream effective switch
epochs remain later independent acceptance gates.

## Invariants held in this PR

1. No route/UI/flag/production deploy hook or automatic writer is added.
2. `canPublish=false`, `deploymentMembershipComplete=false` and
   `captureContinuityProven=false` remain unchanged in all existing
   evaluators.
3. Neither a successful insert, server receipt timestamp, SHA-256 content
   digest, green CI nor an identical sequence of claims is deployment
   authority.
4. Bad/conflicting input and DB mutation attempts fail closed.
5. The release remains blocked until the original Production Phase 3B
   external infrastructure gates are completed.

## Verification requirements

Strict unit cases for canonicalization, shape validation, redaction, duplicate
instance identity and deterministic keys; real PostgreSQL tests for atomic
rollback, same-sequence conflict, forged source, kind checks, server receipt
time and UPDATE/DELETE/TRUNCATE protection. Exact-HEAD Typecheck/Lint/Build,
Vitest coverage and Playwright CI; independent audit; explicit merge
authorization and exact-master post-merge CI are all required.
