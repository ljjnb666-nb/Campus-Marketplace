# Phase 10G — Governance Feature Flags UI

**Scope:** Existing Phase 10F nine-key authoritative flag backend. This PR adds
the Chinese responsive governance operator interface, not new business switches.

## Authority and safety

- Entry: `/governance/feature-flags`, independently gated under the existing
  `feature.flags.manage` permission. Root /governance union admission never
  implies sibling read/write permission.
- GLOBAL grant permits GLOBAL and campus selection. CAMPUS grants need ACTIVE
  actor membership and grant scope matching the target campus. The campus
  selector is discovery only; never an authorization source.
- Reads: one transaction under actor USER governance lock, fresh RBAC,
  deterministic sorted shared feature-flag locks; exact-scope state/history
  only. Campus operators may see whether global disable is effective, but not
  global revision history or other campus overrides.
- Mutations: `requireUser` session ownership, strict allowlisted FormData
  schema, explicit acknowledgement, 10F `setFeatureFlag` CAS/write/revision/
  audit under the original exclusive lock and fresh authorization. Stale
  browser versions fail with a user-visible refresh instruction.
- **GLOBAL disabled wins over CAMPUS false.** Null means inherited override.
  Safety/recovery operations are unaffected as defined by the 10F registry.
- Frontend: nine Chinese status cards, effect warnings, scoped revision history,
  two-step confirmation, mobile layout, meaningful disabled/loading/error
  states. No secrets, privileged IDs or hidden RBAC metadata rendered.
- No React Server Component caching: route is force-dynamic.
- No changes to payment, role definitions, Phase 10F business canonical seams,
  event models, databases, migrations, or external deployment.

## Release gate

1. Typecheck, lint, unit / integration suite, coverage and build.
2. Playwright critical paths, exact PR head CI.
3. Independent review of authorization, global precedence, concurrent writes,
   revision consistency, failure presentation and UX.
4. Explicit merge authorization, then exact-master CI green.

Do not claim production release or Phase 10G CLOSED before these gates.
