# Phase 10K-R2c-01 — First direct counterparty reply fact

**STATUS:** CODE_CANDIDATE / DEFAULT_OFF / METRIC_UNAVAILABLE.
Base: Phase 10K-R2b. Phase 10K-R2c-02 order attribution is a different scope.

## Authority and exclusions

- Source: canonical sendMessageTx, after complete USER pair locks and both
  participant / block / campus / activity authorization checks, with the
  newly created DIRECT message and ledger+projection job in ONE transaction.
- Only one PRODUCT/SERVICE/RENTAL listing-scoped conversation containing an
  exact, eligible R2b LISTING_CONVERSATION_CREATED fact may produce this event.
  Order-first, rental-order, errand demand, zero/multi-listing links, unknown
  campus and historical conversations without R2b are excluded.
- The response must be authored by the participant other than the original
  DIRECT message author, and must be the sender's FIRST DIRECT reply. The
  current reply message is excluded from all prior-message checks; no
  timestamp/CUID tie is used for ordering those checks.
- Event: LISTING_CONVERSATION_FIRST_REPLY@1, occurrence per conversation.
  Payload has only conversationId, listingId, listingType, replyMessageId,
  elapsedMilliseconds. No actor ID, message text, target identity, content,
  private metadata, search term, IP or browser fields.
- The event's occurredAt is the message's database-created timestamp.
  No preexisting messages/events are rewritten, estimated or backfilled.
- No MetricContribution, projection-version change or analytics UI exposure.
  TIME_TO_FIRST_INTERACTION is still UNAVAILABLE pending cohort coverage,
  censored windows, privacy and production rollout proof.

## Release safety

- ANALYTICS_CONVERSATION_EVENT_EMISSION must be enabled AND
  ANALYTICS_FIRST_REPLY_EVENT_EMISSION must be enabled; both default OFF.
- Do not enable either until every async projection worker recognizes both
  event types and rollout is explicitly authorized. Unknown events on old
  workers can be permanent failures.
- Disabling before rollout causes no new DB reads or writes from R2c.
- Transactional ledger failure while enabled can reject message submission.
  Keep flag OFF unless deployment/rollback readiness is approved.
- No canonical order attribution in this PR: order forms currently lack an
  authoritative conversation-to-order link; temporal/listing coincidence is
  not proof of conversion.

## Gates

- Strict event schema and zero-metric test; negative cohort/payload tests.
- Real PostgreSQL: first reply, second reply, disabled-then-enabled without
  historical reconstruction, rollback, event+job atomicity.
- Exact-HEAD CI Verify/E2E and independent review before merge.
