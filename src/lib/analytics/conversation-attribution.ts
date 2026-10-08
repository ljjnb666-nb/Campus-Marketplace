import type { Prisma } from "@prisma/client";
import {
  LISTING_CONVERSATION_CREATED_AGGREGATE_TYPE,
  LISTING_CONVERSATION_CREATED_EVENT_SCHEMA_VERSION,
  LISTING_CONVERSATION_CREATED_EVENT_TYPE,
  type LIQUIDITY_LISTING_TYPES,
} from "@/lib/domain-events/domain-event-registry";
import { recordDomainEventTx } from "@/lib/domain-events/domain-event";

export type AttributableListingType = (typeof LIQUIDITY_LISTING_TYPES)[number];

/**
 * R2b factual record only — one newly CREATED, listing-scoped conversation.
 *
 * TRUST CONTRACT: call ONLY from getOrCreateConversationSafe after the
 * canonical listing has been freshly verified under participant governance
 * locks, the new conversation+initial direct message were created in this
 * SAME transaction, and the campus has been derived from that listing.
 *
 * The ledger contains stable machine IDs & type, not participant identities,
 * messages, listing titles, IP, query, pricing or free-text provenance.
 * A DomainEvent here is NOT a conversion, first reply, or a new metric.
 */
export function recordListingConversationCreatedTx(
  tx: Prisma.TransactionClient,
  input: {
    conversationId: string;
    listingId: string;
    listingType: AttributableListingType;
    campusId: string;
    occurredAt: Date;
  },
) {
  return recordDomainEventTx(tx, {
    eventType: LISTING_CONVERSATION_CREATED_EVENT_TYPE,
    schemaVersion: LISTING_CONVERSATION_CREATED_EVENT_SCHEMA_VERSION,
    aggregateType: LISTING_CONVERSATION_CREATED_AGGREGATE_TYPE,
    aggregateId: input.conversationId,
    campusId: input.campusId,
    occurredAt: input.occurredAt,
    payload: {
      conversationId: input.conversationId,
      listingId: input.listingId,
      listingType: input.listingType,
    },
  });
}
