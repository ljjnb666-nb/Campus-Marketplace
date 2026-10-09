# Phase 10K-R2c-02A — Explicit chat-to-order provenance contract

**State**: SOURCE_CONTRACT_ONLY / NOT_WIRED / DEFAULT_OFF / METRIC_UNAVAILABLE.

R2c-02A intentionally does NOT change order actions, listing detail, routing,
source telemetry, background jobs or user interface. The new fact cannot emit
from production order creation until R2c-02B separately wires a user-visible
chat-to-listing intent into canonical order transactions.

## Why

Matching buyer, seller and listing is not causal attribution. Order-first
system-created chat is expressly out of the source cohort. To claim a conversion,
R2c-02B must issue an actor-bound, short-lived order-origin token on a verified,
explicit chat → listing transition and pass it to the order create transaction.

## Contract

- Server-origin token: HMAC-SHA256, separate 32+ byte
  ANALYTICS_ORDER_ATTRIBUTION_SECRET, binds active actor without embedding actor
  ID; only conversation/listing ID, type, issue timestamp and schema version;
  20-minute lifetime. Token is untrusted client input after issuance.
- Rollout: requires BOTH ANALYTICS_CONVERSATION_EVENT_EMISSION=enabled and
  ANALYTICS_ORDER_ATTRIBUTION_EMISSION=enabled, plus strong signing secret.
  Defaults OFF everywhere; NEVER enable on mixed-version workers.
- Verification MUST happen under canonical user governance locks, with the
  newly created Order/RentalOrder in the SAME transaction after listing row
  locks and fresh authorization. This helper independently re-reads the
  immutable authoritative order, campus/listing lineage, exact 2 participant
  set, strict R2b source event and the pre-order buyer DIRECT message.
- No order is attributed for missing, forged, expired, wrong-buyer, wrong-listing,
  mixed-link, order-first, cross-campus, or >7d source intents. Invalid attribution
  is a no-op for legitimate direct ordering, not a purchase denial.
- Output strict DomainEvent LISTING_CONVERSATION_ORDER_ATTRIBUTED@1,
  aggregateType=ORDER_ATTRIBUTION, order ID as aggregate identity, payload only
  {conversationId,orderId,listingId,listingType}. No message text, actor ID,
  prices, meeting location, campus label or private details in payload.
- Ledger, projection intent and order create must be transactional. Replay is
  occurrence-key deduped. New events yield ZERO v3 MetricContribution.
- CONVERSATION_TO_ORDER_RATE remains UNAVAILABLE: no production traffic, full
  matured 7d denominator/cohort coverage, backfill or user UI claim is proven.

## Follow-up R2c-02B (separate PR)

Wire only explicitly authorised chat → listing → checkout routes into the
order creation authority. Bind actor to the verified source on issuance. Pass the
source token as optional data (direct orders remain ordinary orders). First
validate across PRODUCT/SERVICE/RENTAL test surfaces. No rollout until coverage
& privacy review and worker fleet upgrade are separately approved.

## Tests

Registry fails closed on unknown fields/PII, actor binding, tamper, expiration,
default-off; real PostgreSQL atomic order/event/job, missing-origin no attribution,
rollback. Exact-head CI required before merge.
