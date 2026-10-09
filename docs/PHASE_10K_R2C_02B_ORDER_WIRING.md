# Phase 10K-R2c-02B — Real chat → listing → order wiring (default OFF)

This work adds the explicit, **POST-only** chat-header "查看详情" navigation
authority and connects an *optional* HMAC-verified source credential to canonical
PRODUCT, SERVICE and RENTAL order creation.

## Source and security boundaries

1. Chat header posts only a conversation ID, never a claimed listing/tenant/actor.
   Server Action requires the current ACTIVE/consent-compliant user and reads
   conversation by ID + participant, then computes exactly one canonical listing
   link itself. Order-first, errand and multi-link sources are never eligible.
2. When enabled, issuance additionally checks exactly two participants, buyer
   first DIRECT message, source listing owner, canonical campus and exact R2b
   event payload/occurredAt. No token minted merely for same listing/participants.
3. The token is 20-minute HMAC actor-bound, carried in HttpOnly SameSite=Strict
   cookie (Secure in production) rather than GET query strings, URLs, localStorage,
   or user-controlled order form fields. A new chat navigation invalidates stale
   credentials; a successful order consumes the active cookie.
4. PRODUCT/SERVICE/RENTAL action reads only the cookie (and only when emission
   flags are enabled). The existing governance locks, fresh listing FOR UPDATE,
   validations and order creation are not moved. Inside the SAME order transaction,
   after the new order and its demand fact, the strict R2c-02A verifier re-reads
   the exact buyer/seller/listing/campus/conversation and R2b provenance, and
   appends attribution event + durable projection job atomically.
5. Missing/forged/mismatched/expired intent is **INELIGIBLE**, not an error or
   purchase denial. Any trusted ledger writing failure after eligibility must
   roll back the order, rather than fabricate partial source facts.
6. Both ANALYTICS_CONVERSATION_EVENT_EMISSION and
   ANALYTICS_ORDER_ATTRIBUTION_EMISSION must equal `enabled`, plus a distinct
   strong ANALYTICS_ORDER_ATTRIBUTION_SECRET (32+ bytes). All remain OFF
   in committed example environments. No production rollout, no conversion
   rate/MetricContribution projections, and no version bump in this PR.

## Verification before merge

- Server Action unit contracts for all three listing links, no-source safe
  fallbacks, participant/tenant/actor/event refusal, default-disabled behavior.
- Inherited R2c-02A real PostgreSQL order-origin event/job/rollback tests.
- Full typecheck, lint, unit+integration, build and E2E exact-HEAD CI.
- Independent code and review-thread inspection, explicit merge authorization.
