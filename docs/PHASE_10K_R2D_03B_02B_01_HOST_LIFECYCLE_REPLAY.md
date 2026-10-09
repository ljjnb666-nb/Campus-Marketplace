# Phase 10K-R2d-03B-02B-01 — Unverified host lifecycle replay

**State: IMPLEMENTATION CANDIDATE / PURE NEGATIVE-ONLY CONTRACT / NO HOST OBSERVER DEPLOYED.**
This slice does NOT create an independent Docker host observer, persistent
host journal, transport, database migration, production flag or KPI publication.
It defines a fail-closed replay/validation seam BEFORE an independently owned
observer can be commissioned.

## Threat model

Existing release readiness probes, the deploy log, Docker Compose's current
container snapshot and application heartbeats cannot prove all historical
app/worker instances were present, that there were zero unobserved containers,
or that the observation channel did not silently lose events.

The module `replayUnverifiedHostLifecycle` accepts ONLY explicitly
`UNVERIFIED_HOST_OBSERVER` candidates. This *tag* is descriptive and can
be forged: callers cannot assert that host evidence is authenticated.
It checks chronological event sequence, static 15-minute heartbeat budget,
one observer host/session, full initial baseline, per-instance start/stop
consistency and app/worker presence during heartbeat observations.

Unknown intervals and malformed inputs cannot be silently backfilled by later
snapshots. An observer outage, missing/replayed event, session change, clock
rollback, unannounced baseline reset, absent app or async worker, identity
reuse, malformed instance, incomplete 7-/30-day cohort + 7-day tail, or stale
heartbeat produces a negative reason. Results include only generic reason
codes; host ID, session ID, process/container ID, release SHA, tenant identity
and secrets are never returned.

Even if the candidate history looks internally consistent, these three gates
are **always false**:

- `deploymentMembershipComplete=false`
- `captureContinuityProven=false`
- `canPublish=false`

No application self-report, source label, healthy process, CI pass or
candidate event stream may turn those fields true.

## Future independent authority work (NOT part of this PR)

1. Out-of-process **host/orchestrator-owned** Docker event observer with
   least-privilege socket permissions and explicit workload scope, zero-instance
   detection, startup baseline, reconnect/reconciliation and restart handling.
   Observing through privileged Docker APIs is security-sensitive and should
   NOT be wired into app/worker or enabled by this slice.
2. Durable authenticated journal with independent credentials, ordered
   sequence/boot epoch, monotonic clock + bounded drift, hash/chaining
   provenance, source gap detection, retention/privacy and replay tests.
   The observer must be separate from application/worker writers.
3. Independently owned effective per-instance, per-stream switch epoch
   evidence. Environment variables or current flags alone are not history.
4. Correlation of authenticated lifecycle epochs with candidate fleet
   membership from R2d-03B-02A and later source-fact reconciliation from
   R2d-03B-03. Even authenticated membership does not prove emitted facts.
5. Actual production deployment and recovery drill remain deferred by
   the existing Production Phase 3B gate.

## Scope and verification

The PR contains a pure module, adversarial Vitest coverage and this contract
document only. There is no Prisma schema, migration, API, UI, deploy hook,
Docker socket access, logging of secrets or feature activation. Validation
must include exact-HEAD TypeScript, lint, Vitest coverage, production build and
Playwright E2E; independent review and explicit merge authorization remain
required. Only after merge should exact-master CI be considered.
