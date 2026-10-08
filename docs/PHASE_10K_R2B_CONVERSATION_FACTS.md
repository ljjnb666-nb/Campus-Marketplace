# Phase 10K-R2b — Listing-conversation factual event (rollout fenced)

Scope: New direct PRODUCT/SERVICE/RENTAL listing conversations only. Never order-first, rental-order, or ERRAND demand conversations. This is a source fact, NOT yet a conversion metric.

## Invariants
- All participant governance locks, account/campus authority, block policy, marketplace capability, listing exposure and kill switches are checked before writing the new fact.
- Strict LISTING_CONVERSATION_CREATED@1 DomainEvent: aggregateId=conversationId; payload={conversationId,listingId,listingType}; campus derived from canonical resource; occurredAt=DB conversation.createdAt; no messages or PII copied.
- Ledger+projection-intent, new conversation, first DIRECT message and notification share one transaction; fail/rollback is atomic; duplicate existing-key paths emit nothing.
- The v3 metric registry deliberately returns zero contributions. Historical data are not backfilled or declared complete; all R1 funnel metrics remain UNAVAILABLE.

## Production rollout fence — REQUIRED
- ANALYTICS_CONVERSATION_EVENT_EMISSION is **OFF by default**; only the exact string enabled opts in.
- A rolling fleet that includes old projection workers must not emit the new event. Old workers can treat unknown registry event types as permanent failures.
- Deploy this registry and verify every worker upgraded, then enable the flag in a separately authorized operations step; or plan a future-version job fence. No production activation is claimed by this PR.
- No change to feature-flags policy, permission, payment, or governance write path.

## Verification
- Registry strict identity/PII tests; R2b writer invocation only on fresh eligible listing conversations with enabled rollout gate; mock-free real-PG ledger/job/replay/rollback/conflicting tenant tests.
- Exact-HEAD verify+E2E, independent review, explicit merge approval, then exact-master CI; this PR is stacked on #82 and cannot merge into master before its base is merged.
