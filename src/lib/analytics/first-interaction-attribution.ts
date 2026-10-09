import type { Prisma } from "@prisma/client";
import {
  LISTING_CONVERSATION_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_FIRST_REPLY_EVENT_TYPE,
  LISTING_CONVERSATION_FIRST_REPLY_EVENT_SCHEMA_VERSION,
  LISTING_CONVERSATION_FIRST_REPLY_AGGREGATE_TYPE,
  type LIQUIDITY_LISTING_TYPES,
} from "@/lib/domain-events/domain-event-registry";
import { recordDomainEventTx } from "@/lib/domain-events/domain-event";

type ListingType = (typeof LIQUIDITY_LISTING_TYPES)[number];
type ConversationRefs = {
  productId?: string | null;
  errandTaskId?: string | null;
  serviceListingId?: string | null;
  rentalListingId?: string | null;
  orderId?: string | null;
  rentalOrderId?: string | null;
};

export function firstReplyEventEmissionEnabled(): boolean {
  // Both flags are required. R2c cannot mint an event for an R2b cohort that
  // was never activated. Both default OFF until every worker is upgraded.
  return process.env.ANALYTICS_CONVERSATION_EVENT_EMISSION === "enabled"
    && process.env.ANALYTICS_FIRST_REPLY_EVENT_EMISSION === "enabled";
}

function resolveListing(refs: ConversationRefs): { listingId: string; listingType: ListingType } | null {
  if (refs.errandTaskId || refs.orderId || refs.rentalOrderId) return null;
  const links: Array<{ listingId: string; listingType: ListingType }> = [];
  if (refs.productId) links.push({ listingId: refs.productId, listingType: "PRODUCT" });
  if (refs.serviceListingId) links.push({ listingId: refs.serviceListingId, listingType: "SERVICE" });
  if (refs.rentalListingId) links.push({ listingId: refs.rentalListingId, listingType: "RENTAL" });
  return links.length === 1 ? links[0]! : null;
}

/**
 * Call ONLY after a canonical sendMessageTx DIRECT message was inserted under
 * the same complete pair governance locks. The pre-existing R2b fact proves
 * the listing-scoped cohort originated from the authoritative creation path.
 * No message body or participant identity enters the event.
 */
export async function recordFirstListingReplyIfEligibleTx(
  tx: Prisma.TransactionClient,
  input: {
    conversationId: string;
    senderId: string;
    replyMessageId: string;
    replyAt: Date;
    conversationCreatedAt: Date;
    campusId: string;
    refs: ConversationRefs;
  },
): Promise<"DISABLED" | "INELIGIBLE" | "RECORDED" | "DUPLICATE"> {
  if (!firstReplyEventEmissionEnabled()) return "DISABLED";
  const listing = resolveListing(input.refs);
  if (!listing) return "INELIGIBLE";

  const origin = await tx.domainEvent.findUnique({
    where: { occurrenceKey: LISTING_CONVERSATION_CREATED_EVENT_TYPE + ":" + input.conversationId },
    select: {
      eventType: true, schemaVersion: true, aggregateType: true,
      aggregateId: true, campusId: true, occurredAt: true, payload: true,
    },
  });
  if (!origin || origin.eventType !== LISTING_CONVERSATION_CREATED_EVENT_TYPE
    || origin.schemaVersion !== 1 || origin.aggregateType !== "CONVERSATION"
    || origin.aggregateId !== input.conversationId || origin.campusId !== input.campusId
    || origin.occurredAt.getTime() !== input.conversationCreatedAt.getTime()) {
    return "INELIGIBLE";
  }
  const payload = origin.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "INELIGIBLE";
  const facts = payload as Record<string, unknown>;
  if (facts.conversationId !== input.conversationId ||
    facts.listingId !== listing.listingId || facts.listingType !== listing.listingType) {
    return "INELIGIBLE";
  }

  // First DIRECT message proves the original initiator. System messages do not.
  // Both reads happen AFTER the just-written reply in the same canonical tx.
  const firstDirect = await tx.message.findFirst({
    where: { conversationId: input.conversationId, type: "DIRECT", id: { not: input.replyMessageId } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, senderId: true, createdAt: true },
  });
  if (!firstDirect || !firstDirect.senderId || firstDirect.senderId === input.senderId
    || firstDirect.createdAt.getTime() < input.conversationCreatedAt.getTime()) {
    return "INELIGIBLE";
  }
  // Check every other prior reply by this sender, not the timestamp/ID sort.
  // DB millisecond clock ties make lexicographic CUID order a bad chronology.
  // Pair locks serialize sendMessageTx, so all other sender rows are earlier.
  const priorReply = await tx.message.findFirst({
    where: {
      conversationId: input.conversationId, type: "DIRECT",
      senderId: input.senderId, id: { not: input.replyMessageId },
    },
    select: { id: true },
  });
  if (priorReply) return "INELIGIBLE";

  const elapsedMilliseconds = input.replyAt.getTime() - input.conversationCreatedAt.getTime();
  if (!Number.isSafeInteger(elapsedMilliseconds) || elapsedMilliseconds < 0) return "INELIGIBLE";
  const result = await recordDomainEventTx(tx, {
    eventType: LISTING_CONVERSATION_FIRST_REPLY_EVENT_TYPE,
    schemaVersion: LISTING_CONVERSATION_FIRST_REPLY_EVENT_SCHEMA_VERSION,
    aggregateType: LISTING_CONVERSATION_FIRST_REPLY_AGGREGATE_TYPE,
    aggregateId: input.conversationId,
    campusId: input.campusId,
    occurredAt: input.replyAt,
    payload: {
      conversationId: input.conversationId,
      listingId: listing.listingId,
      listingType: listing.listingType,
      replyMessageId: input.replyMessageId,
      elapsedMilliseconds,
    },
  });
  return result.recorded ? "RECORDED" : "DUPLICATE";
}
