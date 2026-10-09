import {
  LIQUIDITY_LISTING_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_FIRST_REPLY_EVENT_TYPE,
  LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_TYPE,
  validateDomainEventIntent,
  type LIQUIDITY_LISTING_TYPES,
} from "@/lib/domain-events/domain-event-registry";

type ListingType = (typeof LIQUIDITY_LISTING_TYPES)[number];

/**
 * R2d-01: preliminary, non-publishable cohort matching against a BOUNDED,
 * campus-scoped set of canonical domain facts. This is NOT a completeness
 * authority, production rate query, or analytics.read entrypoint.
 *
 * The caller must include all domain facts between cohortStart and
 * cohortEnd + seven days to test a mature cohort. No historical ingestion,
 * projection watermark or rollout continuity is asserted by this function.
 */
export type FunnelFact = Readonly<{
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  occurrenceKey: string;
  campusId: string;
  sourceType: string;
  occurredAt: Date;
  payload: unknown;
}>;

const DAY_MS = 86_400_000;
export const FUNNEL_CONVERSION_WINDOW_MS = 7 * DAY_MS;
const TYPES = new Set([
  LIQUIDITY_LISTING_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_FIRST_REPLY_EVENT_TYPE,
  LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_TYPE,
]);

type Diagnostic = Readonly<{
  newListings: number;
  listingsWithConversations: number;
  eligibleConversations: number;
  conversationsWithOrders: number;
  conversationsWithFirstReply: number;
  censoredConversations: number;
  medianFirstReplyMilliseconds: number | null;
  excludedNonRealtimeFacts: number;
  invalidOrDuplicateFacts: number;
}>;

export type FunnelCandidateResult =
  | Readonly<{
      status: "INVALID_WINDOW" | "IMMATURE_COHORT";
      candidate: null;
    }>
  | Readonly<{
      // No caller may promote these candidate counts to externally visible
      // rates. A separate future rollout/coverage authority is REQUIRED.
      status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE";
      candidate: Diagnostic;
    }>;

type ListingOrigin = { listingId: string; createdAtMs: number };
type ConversationOrigin = { conversationId: string; listingId: string; createdAtMs: number };
type FollowUpFact = { conversationId: string; listingId: string; timeMs: number; elapsedMs?: number };

const validTime = (date: Date) => date instanceof Date && Number.isFinite(date.getTime());
const inRange = (time: number, start: number, end: number) => time >= start && time < end;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Diagnostic-only. Canonical source event + campus + listing type + matching
 * identity MUST agree before cohort membership. Occurrence duplicates cannot
 * increment cardinality; historical backfills and unverifiable event kinds
 * do not fabricate missing exposure/first-message/order provenance.
 */
export function evaluateUnreleasedFunnelCohort(input: Readonly<{
  campusId: string;
  listingType: ListingType;
  cohortStart: Date;
  cohortEnd: Date;
  observedThrough: Date;
  facts: readonly FunnelFact[];
}>): FunnelCandidateResult {
  const { cohortStart, cohortEnd, observedThrough } = input;
  if (!input.campusId || !["PRODUCT", "SERVICE", "RENTAL"].includes(input.listingType) ||
      !validTime(cohortStart) || !validTime(cohortEnd) ||
      !validTime(observedThrough)) return { status: "INVALID_WINDOW", candidate: null };
  const start = cohortStart.getTime();
  const end = cohortEnd.getTime();
  const observed = observedThrough.getTime();
  if (end <= start || ![7, 30].includes((end - start) / DAY_MS) ||
      !Array.isArray(input.facts) || input.facts.length > 50_000) {
    return { status: "INVALID_WINDOW", candidate: null };
  }
  if (end + FUNNEL_CONVERSION_WINDOW_MS > observed) {
    return { status: "IMMATURE_COHORT", candidate: null };
  }

  const listings = new Map<string, ListingOrigin>();
  const conversations = new Map<string, ConversationOrigin>();
  const replies: FollowUpFact[] = [];
  const orders: FollowUpFact[] = [];
  const seen = new Set<string>();
  let excludedNonRealtimeFacts = 0;
  let invalidOrDuplicateFacts = 0;

  for (const fact of input.facts) {
    if (!fact || fact.campusId !== input.campusId || !TYPES.has(fact.eventType)) continue;
    if (fact.sourceType !== "DOMAIN_TX") {
      excludedNonRealtimeFacts++;
      continue;
    }
    if (!validTime(fact.occurredAt) || !Number.isSafeInteger(fact.schemaVersion) ||
        typeof fact.occurrenceKey !== "string") {
      invalidOrDuplicateFacts++;
      continue;
    }
    const at = fact.occurredAt.getTime();
    if (at < start || at > end + FUNNEL_CONVERSION_WINDOW_MS || at > observed) continue;
    const parsed = validateDomainEventIntent(
      fact.eventType, fact.schemaVersion, fact.aggregateType, fact.aggregateId, fact.payload,
    );
    if (!parsed.ok || parsed.occurrenceKey !== fact.occurrenceKey ||
        seen.has(fact.occurrenceKey)) {
      invalidOrDuplicateFacts++;
      continue;
    }
    seen.add(fact.occurrenceKey);
    const p = parsed.payload;
    if (p.listingType !== input.listingType) continue;

    switch (fact.eventType) {
      case LIQUIDITY_LISTING_CREATED_EVENT_TYPE:
        if (inRange(at, start, end)) {
          listings.set(p.listingId as string, {
            listingId: p.listingId as string, createdAtMs: at,
          });
        }
        break;
      case LISTING_CONVERSATION_CREATED_EVENT_TYPE:
        conversations.set(p.conversationId as string, {
          conversationId: p.conversationId as string,
          listingId: p.listingId as string,
          createdAtMs: at,
        });
        break;
      case LISTING_CONVERSATION_FIRST_REPLY_EVENT_TYPE:
        replies.push({
          conversationId: p.conversationId as string,
          listingId: p.listingId as string, timeMs: at,
          elapsedMs: p.elapsedMilliseconds as number,
        });
        break;
      case LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_TYPE:
        orders.push({
          conversationId: p.conversationId as string,
          listingId: p.listingId as string, timeMs: at,
        });
        break;
    }
  }

  const listingConverted = new Set<string>();
  const cohortConversations = new Map<string, ConversationOrigin>();
  for (const conv of conversations.values()) {
    const listing = listings.get(conv.listingId);
    if (listing &&
        conv.createdAtMs >= listing.createdAtMs &&
        conv.createdAtMs - listing.createdAtMs <= FUNNEL_CONVERSION_WINDOW_MS) {
      listingConverted.add(listing.listingId);
    }
    if (inRange(conv.createdAtMs, start, end)) {
      cohortConversations.set(conv.conversationId, conv);
    }
  }

  const convertedConversations = new Set<string>();
  for (const order of orders) {
    const conv = cohortConversations.get(order.conversationId);
    if (conv && conv.listingId === order.listingId &&
        order.timeMs >= conv.createdAtMs &&
        order.timeMs - conv.createdAtMs <= FUNNEL_CONVERSION_WINDOW_MS) {
      convertedConversations.add(conv.conversationId);
    }
  }

  const firstReplies = new Map<string, number>();
  for (const reply of replies) {
    const conv = cohortConversations.get(reply.conversationId);
    if (!conv || conv.listingId !== reply.listingId ||
        reply.timeMs < conv.createdAtMs ||
        reply.timeMs - conv.createdAtMs > FUNNEL_CONVERSION_WINDOW_MS ||
        reply.elapsedMs !== reply.timeMs - conv.createdAtMs) continue;
    // Exactly one validated first reply per conversation. Do not turn
    // multiple messages or append-only replay into multiple observations.
    if (!firstReplies.has(conv.conversationId)) {
      firstReplies.set(conv.conversationId, reply.elapsedMs);
    }
  }

  return {
    status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE",
    candidate: {
      newListings: listings.size,
      listingsWithConversations: listingConverted.size,
      eligibleConversations: cohortConversations.size,
      conversationsWithOrders: convertedConversations.size,
      conversationsWithFirstReply: firstReplies.size,
      censoredConversations: cohortConversations.size - firstReplies.size,
      medianFirstReplyMilliseconds: median([...firstReplies.values()]),
      excludedNonRealtimeFacts,
      invalidOrDuplicateFacts,
    },
  };
}
