# Phase 10F — Feature Flags / Kill Switches (frozen backend contract)

Source of truth: `MASTER_ROADMAP §5.6`, Phase 10E config and existing Phase 5–9
canonical lifecycle and authorization contracts.

## Authority

- DB `FeatureFlagOverride` is the only mutable server-side state, not front-end
  flags, process memory, environment defaults or admin UI.
- Registered keys: DISABLE_REGISTRATION, DISABLE_NEW_LISTINGS,
  DISABLE_NEW_ORDERS, DISABLE_NEW_CONVERSATIONS, DISABLE_NEW_MESSAGES,
  DISABLE_MEETUPS, DISABLE_DISPUTE_INITIATION, MAINTENANCE_MODE,
  READ_ONLY_MODE. No arbitrary or sensitive keys.
- Missing rows after successful DB read: all enabled, preserving existing
  behavior. `disabled:true` at GLOBAL OR the exact campus disables.
  Campus `disabled:false` cannot override global disable. `null` is
  versioned INHERIT.
- DB outage/corrupt scoped flag state: new activities deny. Never fall back
  to "enabled" when the authority is unreadable.
- `feature.flags.manage` is independent RBAC capability; mutation with fresh
  authority and actor governance subject lock, plus same-tx AdminLog.
  Config write CAS and append-only revision, no raw deletes.
- Shared advisory transaction lock for business writes and exclusive advisory
  transaction lock for flag mutations, identical scope+flag key.
  Lock order: existing complete sorted participant USER/CAMPUS governance
  locks → ordered feature flag locks → DB reads → business writes.
- No secret values, arbitrary strings, automatic enforcement or payments.

## Activity policy (strict server-boundary)

| New activity | Additional blocks |
| --- | --- |
| Account registration | DISABLE_REGISTRATION, MAINTENANCE_MODE |
| New Product/Errand/Service/Rental listing | DISABLE_NEW_LISTINGS, MAINTENANCE_MODE, READ_ONLY_MODE |
| New Product/Errand/Service/Rental order | DISABLE_NEW_ORDERS, MAINTENANCE_MODE, READ_ONLY_MODE |
| New conversation | DISABLE_NEW_CONVERSATIONS, MAINTENANCE_MODE, READ_ONLY_MODE |
| New direct message | DISABLE_NEW_MESSAGES, MAINTENANCE_MODE, READ_ONLY_MODE |
| Propose *new* meetup | DISABLE_MEETUPS |
| Initiate *new* dispute | DISABLE_DISPUTE_INITIATION |

**Recovery / safety carve-outs:** continue allowing cancellation, returning items,
fulfilling existing obligations, settlement-free dispute review/resolution,
appeals, reports/support, privacy operations and moderator actions.
Maintenance and read-only should not silently cause users to lose legal claims
or prevent recovering entrusted goods. `DISABLE_DISPUTE_INITIATION` is a
high-risk, separately authorized emergency control; operator must have a
runbook and direct support channel while it is engaged.

**Explicit non-goals:** 10G governance UI, permission changes beyond feature
flags, online payment, percentage/cohort rollouts, standalone second queue,
front-end security checks or mutable auth/email/verification policy.

## Milestones and gate

1. Typed DB authority, scoped controls, permission, audit, advisory fences.
2. Canonical write-seam wiring for all seven new-activity kinds, across all
   applicable business types; no action-only gates.
3. Real PG tests: GLOBAL/CAMPUS, flag/no-flag/default, fail-closed,
   concurrent disable/write ordering, role-revoke race, audit rollback, and
   bypass attempts via direct service invocation.
4. Exact-head verify + E2E, independent review, explicit merge approval,
   post-merge master-green closure.

`10F != COMPLETE` while any canonical write seam is unguarded or tests fail.
