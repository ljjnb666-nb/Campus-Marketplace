# ADR 0002 — Non-Payment Production Completion Roadmap Amendment

- Status: ACCEPTED
- Date: 2026-10-01
- Supersedes: no prior ADR; amends ADR 0001 / Master Roadmap v1.0
- Roadmap version after amendment: v1.1

## Context

Campus Marketplace has intentionally deferred real online payment until product validation. The current roadmap already permits Phase 12–14 controlled launches to use offline / face-to-face payment semantics and explicitly gates Phase 15–19 payment work behind GATE C.

Repository development has also advanced beyond the Phase 7 closure snapshot: Phase 8 Marketplace Lifecycle Hardening is in progress. At the same time, review of the current authentication surface shows that governance, privacy, operations and recovery foundations are substantially more mature than ordinary end-user account lifecycle capabilities.

The current authentication baseline uses NextAuth JWT sessions with bounded lifetime and server-side database revalidation for active account state. However, the roadmap does not explicitly require a production-complete user account recovery and session-security surface before pilot deployment.

The missing product-level account lifecycle requirements include:

- email ownership verification and transactional account-security email delivery;
- forgot-password / password-reset lifecycle;
- authenticated password change;
- session / device visibility and selective revocation;
- revoke-other / revoke-all session capability;
- invalidation of pre-existing sessions after credential reset/change;
- anti-enumeration and rate limiting for recovery flows;
- account security event visibility;
- stronger authentication for privileged governance accounts.

Separately, Phase 10 already contains Feature Flags / Config Center / kill switches, but the production requirements need to be explicit: flags are server-authoritative operational controls, audited and fail-safe, not client-side security boundaries.

## Decision

The project adopts **NON_PAYMENT_PRODUCTION_READY** as the production-completion target before payment work.

This does **not** insert a new top-level Phase and does not renumber the frozen roadmap.

Phase 11 remains the canonical Phase 11 and is split into implementation slices:

- **Phase 11A — Account Lifecycle & Session Security**
- **Phase 11B — Pilot UX / Onboarding / Mobile Critical Paths**
- **Phase 11C — Pilot Operations Closure**

These are implementation slices inside Phase 11, not new canonical top-level phases.

### Phase 11A required capabilities

At minimum:

1. Email ownership verification with resend, expiry, single-use semantics, anti-enumeration and rate limiting.
2. Forgot-password / reset-password with opaque random token, server-side hash storage, TTL, single consumption and no account-existence oracle.
3. Authenticated password change requiring the current password and rejecting equivalent credentials.
4. Session revocation authority that does not rely only on waiting for JWT maxAge expiry.
5. User-facing controls for current/recent sessions and revoke-one / revoke-others / revoke-all semantics.
6. Password reset/change must invalidate sessions according to an explicit security policy, with reset invalidating all pre-reset sessions.
7. Security-event records for login, credential change/reset and session revocation without storing credentials, raw reset tokens or JWTs.
8. Stronger authentication for privileged governance accounts, preferably MFA / second factor before pilot production access.
9. Recovery-flow abuse controls across account/email/IP dimensions.
10. All security states and end-user statuses exposed in the UI must use understandable Chinese labels rather than raw enums or machine codes.

Phase 11A should reuse the existing Phase 6 identity/RBAC/governance authority and Phase 9 notification delivery foundation. It must not create a second disconnected authentication or audit system.

### Phase 9 dependency clarification

Phase 9's notification architecture must support transactional account-security delivery, including email required by verification and recovery flows. Account-security email is a first-class transactional delivery use case, not marketing mail.

### Phase 10 clarification

Feature Flags / Config Center must include server-authoritative, audited and fail-safe operational controls. Required kill-switch classes include, as applicable:

- registration;
- new listings;
- new orders;
- new conversations/messages;
- meetup operations;
- dispute initiation;
- maintenance mode;
- read-only mode;
- campus-scoped disable controls.

Feature flags may control product availability but must never replace authorization, ownership checks or lifecycle invariants.

### GATE B amendment

GATE B cannot pass until Phase 11A account lifecycle and session security are accepted in addition to the existing governance, notification, analytics, risk, feature-flag and pilot-UX requirements.

At minimum GATE B now requires:

- password recovery/change flows;
- session revocation / revoke-all;
- account-security transactional delivery;
- privileged-account strong-auth policy;
- recovery-flow abuse controls;
- production-ready security-event visibility.

## Payment boundary

The payment boundary is unchanged.

Before GATE C PASS, the platform must not add online payment, platform fee collection, refund, split settlement, withdrawal or payment reconciliation merely to satisfy production readiness.

Phase 12–14 may continue using offline / face-to-face payment semantics.

Phase 15–19 remain locked until GATE C PASS.

## Dependency changes

The high-level sequence remains:

Phase 8 → Phase 9 → Phase 10 → Phase 11A/11B/11C → GATE B → Phase 3B reopen → Phase 12–14 → GATE C.

Phase 11A depends on Phase 9 transactional notification/email delivery. It may consume Phase 10 risk/config controls where useful, but authentication correctness must not depend on client-side flags.

## Schema / migration impact

This ADR itself changes no schema.

Future Phase 11A implementation is expected to require schema/migrations for recovery tokens and/or session-revocation authority. The exact model is intentionally not frozen here; implementation must define the authoritative state and concurrency contract before migration.

## Launch impact

This amendment strengthens, rather than relaxes, the production launch gate.

A non-payment production launch can eventually clear the launch gate without Phase 15–19 only when all other gate requirements are met, including GATE B, real Phase 3B deployment evidence, production smoke, backup/restore, security, observability and incident readiness.

"NON_PAYMENT_PRODUCTION_READY" does not mean "payment ready" or "commercial ready".

## Why backlog is insufficient

These capabilities are not optional product polish:

- password recovery is required when a legitimate user loses credentials;
- explicit session revocation is necessary after credential compromise/reset;
- privileged-account stronger authentication materially affects governance security;
- audited kill switches are required for controlled pilot incident containment.

They are therefore production-launch / security blockers under the roadmap's own amendment criteria and belong in the canonical roadmap rather than an unconstrained backlog.

## Non-goals

This amendment does not start or authorize:

- online payment;
- platform fees;
- refunds;
- payment split;
- settlement;
- reconciliation;
- withdrawals;
- payment operations console;
- unrelated growth phases.
