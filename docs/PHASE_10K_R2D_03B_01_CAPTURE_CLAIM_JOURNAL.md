# Phase 10K-R2d-03B-01 — Durable *unverified* capture claim journal

**State:** REPO IMPLEMENTATION CANDIDATE / NO ROLLOUT / NO KPI PUBLICATION.

This scoped slice adds a PostgreSQL append-only `FunnelCaptureClaim` journal
and a transaction-only idempotent writer for strictly machine-shaped,
**unverified** candidate capture intervals. This is NOT proof that any real
deployment instance ran for the claimed interval, or that an event was emitted.

## Core controls

- A single deterministic SHA-256 claim key over version, campus, stream,
  instanceId, releaseSha, start, end, enabled flag; duplicate replay is checked
  for **full semantic identity** after conflict-skipping insertion.
- Database constraints independently refuse malformed type/instance/SHA,
  missing campus, zero/inverted windows, and any source except `UNVERIFIED`.
- Database trigger refuses UPDATE and DELETE (normal application privilege);
  it is *not* cryptographic tamper-resistance against database superusers.
- Immutable `recordedAt` is **when PostgreSQL saw the claim**, never proof that
  the claimed past interval was actually operating. No backfill is performed.
- No actor names, user IDs, email addresses, message content, IPs, search
  keywords or secret tokens stored.
- No API route, Server Action, UI, scheduler, automatic rollout producer or
  deploy hook. This is an **internal repository seam only**, and must never be
  advertised as externally audited producer evidence.

## R2d-03B remaining gates

B-02: establish the independent deployment/fleet membership authority,
including zero-instance periods, rolling updates, exact SHA, effective time,
per-stream actual feature switch transitions, version eligibility and
instance birth/death. All records from B-01 remain `UNVERIFIED`.
B-03: source inventory and reconciliation/late event completeness,
cross-tenant authorized read, retention policy, and adversarial production
evidence drill. R2d-03A evaluator's output must continue to set
`canPublish=false` even when all stored claims look contiguous.

R2d-02 `captureContinuityProven=false` remains unchanged. The six R1
measurements stay UNAVAILABLE, all production capture flags stay OFF.

## Verification

Unit contracts for identity, malformed payloads and duplicate semantics;
real PostgreSQL tests that rollback fixtures and verify immutable database
triggers and CHECK constraints; exact-head PR CI and independently reviewed
migration before explicit merge approval.
