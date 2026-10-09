import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { recordDomainEventTx } from "@/lib/domain-events/domain-event";
import {
  LISTING_CONVERSATION_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_ORDER_ATTRIBUTED_AGGREGATE_TYPE,
  LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_SCHEMA_VERSION,
  LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_TYPE,
  type LIQUIDITY_LISTING_TYPES,
} from "@/lib/domain-events/domain-event-registry";

export type AttributedOrderType = (typeof LIQUIDITY_LISTING_TYPES)[number];
type OrderOrigin = {
  version: 1;
  conversationId: string;
  listingId: string;
  listingType: AttributedOrderType;
  issuedAtMs: number;
};
const TOKEN_LIFETIME_MS = 20 * 60 * 1000;
const CONVERSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,191}$/;
const SIGNATURE = /^[A-Za-z0-9_-]+$/;
const VALID_TYPES = new Set<AttributedOrderType>(["PRODUCT", "SERVICE", "RENTAL"]);

function secret(): string | null {
  const value = process.env.ANALYTICS_ORDER_ATTRIBUTION_SECRET;
  return value && Buffer.byteLength(value, "utf8") >= 32 ? value : null;
}

/** Default OFF. An enabled fleet must have all projection workers upgraded. */
export function orderAttributionEnabled(): boolean {
  return process.env.ANALYTICS_CONVERSATION_EVENT_EMISSION === "enabled"
    && process.env.ANALYTICS_ORDER_ATTRIBUTION_EMISSION === "enabled"
    && secret() !== null;
}

function validId(input: unknown): input is string {
  return typeof input === "string" && ID.test(input);
}

function validOrigin(input: unknown): input is OrderOrigin {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).sort().join(",") ===
    "conversationId,issuedAtMs,listingId,listingType,version" &&
    value.version === 1 && validId(value.conversationId) &&
    validId(value.listingId) &&
    VALID_TYPES.has(value.listingType as AttributedOrderType) &&
    Number.isSafeInteger(value.issuedAtMs) && (value.issuedAtMs as number) > 0;
}

function mac(content: string, actorId: string, key: string): Buffer {
  return createHmac("sha256", key)
    .update("R2C_ORDER_ORIGIN_V1\0")
    .update(actorId)
    .update("\0")
    .update(content)
    .digest();
}

/**
 * Server-only issuer. R2c-02B MUST authenticate the actor, confirm the actor
 * participates in this listing conversation and issue ONLY on an explicit
 * chat -> listing navigation. This does not query the DB by itself.
 * The token never embeds the user ID or raw chat content; signature binds actor.
 */
export function mintOrderOriginToken(input: {
  actorId: string;
  conversationId: string;
  listingId: string;
  listingType: AttributedOrderType;
  now?: Date;
}): string | null {
  if (!orderAttributionEnabled() || !validId(input.actorId) ||
      !validId(input.conversationId) || !validId(input.listingId) ||
      !VALID_TYPES.has(input.listingType)) return null;
  const time = (input.now ?? new Date()).getTime();
  if (!Number.isSafeInteger(time) || time <= 0) return null;
  const payload: OrderOrigin = {
    version: 1, conversationId: input.conversationId,
    listingId: input.listingId, listingType: input.listingType,
    issuedAtMs: time,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const key = secret();
  if (!key) return null;
  return body + "." + mac(body, input.actorId, key).toString("base64url");
}

export function verifyOrderOriginToken(input: {
  token: string | null | undefined;
  actorId: string;
  asOf: Date;
}): OrderOrigin | null {
  if (!orderAttributionEnabled() || !input.token || input.token.length > 1024 ||
      !validId(input.actorId)) return null;
  const parts = input.token.split(".");
  if (parts.length !== 2 || !SIGNATURE.test(parts[0]!) ||
      !SIGNATURE.test(parts[1]!)) return null;
  const key = secret();
  if (!key) return null;
  const provided = Buffer.from(parts[1]!, "base64url");
  const expected = mac(parts[0]!, input.actorId, key);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")); }
  catch { return null; }
  if (!validOrigin(decoded)) return null;
  const asOfMs = input.asOf.getTime();
  if (!Number.isSafeInteger(asOfMs) || asOfMs < decoded.issuedAtMs ||
      asOfMs - decoded.issuedAtMs > TOKEN_LIFETIME_MS) return null;
  return decoded;
}

type AttributionResult = "DISABLED" | "INELIGIBLE" | "RECORDED" | "DUPLICATE";

/**
 * The order must already exist in this SAME canonical order-create transaction,
 * after participant governance locks and listing FOR UPDATE checks. This read
 * revalidates order authority, two exact participants, the original R2b event,
 * campus, listing and 7d chronology. Never guess from shared listing history.
 *
 * Invalid/missing tokens are un-attributed, NOT order failures. If the feature
 * is enabled and the trusted ledger writer fails, the outer transaction must
 * roll back BOTH order and attribution.
 */
export async function recordAttributedOrderIfEligibleTx(
  tx: Prisma.TransactionClient,
  input: {
    sourceToken?: string | null;
    orderId: string;
    orderType: AttributedOrderType;
    actorUserId: string;
  },
): Promise<AttributionResult> {
  if (!orderAttributionEnabled()) return "DISABLED";
  if (!validId(input.orderId) || !validId(input.actorUserId) ||
      !VALID_TYPES.has(input.orderType)) return "INELIGIBLE";

  const order = input.orderType === "RENTAL"
    ? await tx.rentalOrder.findUnique({
        where: { id: input.orderId },
        select: {
          id: true, createdAt: true, renterId: true, ownerId: true,
          rentalListingId: true, rentalListing: { select: { campusId: true } },
        },
      })
    : await tx.order.findUnique({
        where: { id: input.orderId },
        select: {
          id: true, createdAt: true, type: true, buyerId: true,
          sellerId: true, productId: true, serviceListingId: true,
          product: { select: { campusId: true } },
          serviceListing: { select: { campusId: true } },
        },
      });
  if (!order) return "INELIGIBLE";

  // Narrow the two authoritative order domains before resolving the listing.
  const isRental = "renterId" in order;
  const time = order.createdAt;
  const intent = verifyOrderOriginToken({
    token: input.sourceToken, actorId: input.actorUserId, asOf: time,
  });
  if (!intent || intent.listingType !== input.orderType) return "INELIGIBLE";

  let listingId: string;
  let campusId: string;
  let buyerId: string;
  let sellerId: string;
  if (isRental) {
    const rental = order;
    listingId = rental.rentalListingId;
    campusId = rental.rentalListing.campusId;
    buyerId = rental.renterId;
    sellerId = rental.ownerId;
  } else {
    const standard = order;
    if (standard.type !== input.orderType) return "INELIGIBLE";
    if (input.orderType === "PRODUCT") {
      if (!standard.productId || standard.serviceListingId || !standard.product) return "INELIGIBLE";
      listingId = standard.productId;
      campusId = standard.product.campusId;
    } else {
      if (!standard.serviceListingId || standard.productId || !standard.serviceListing) return "INELIGIBLE";
      listingId = standard.serviceListingId;
      campusId = standard.serviceListing.campusId;
    }
    buyerId = standard.buyerId;
    sellerId = standard.sellerId;
  }
  if (buyerId !== input.actorUserId || buyerId === sellerId ||
      listingId !== intent.listingId || !validId(campusId)) return "INELIGIBLE";

  const conversation = await tx.conversation.findUnique({
    where: { id: intent.conversationId },
    select: {
      id: true, createdAt: true, productId: true, serviceListingId: true,
      rentalListingId: true, errandTaskId: true, orderId: true,
      rentalOrderId: true, participants: { select: { userId: true } },
    },
  });
  if (!conversation || conversation.errandTaskId || conversation.orderId ||
      conversation.rentalOrderId || conversation.participants.length !== 2) return "INELIGIBLE";
  const ids = conversation.participants.map(p => p.userId);
  if (new Set(ids).size !== 2 || !ids.includes(buyerId) || !ids.includes(sellerId)) return "INELIGIBLE";
  const sourceLinks = [conversation.productId, conversation.serviceListingId,
    conversation.rentalListingId].filter(Boolean);
  const correctLink = input.orderType === "PRODUCT" ? conversation.productId
    : input.orderType === "SERVICE" ? conversation.serviceListingId : conversation.rentalListingId;
  if (sourceLinks.length !== 1 || correctLink !== listingId) return "INELIGIBLE";

  const diff = time.getTime() - conversation.createdAt.getTime();
  if (diff < 0 || diff > CONVERSION_WINDOW_MS ||
      intent.issuedAtMs < conversation.createdAt.getTime()) return "INELIGIBLE";
  const origin = await tx.domainEvent.findUnique({
    where: { occurrenceKey: LISTING_CONVERSATION_CREATED_EVENT_TYPE + ":" + conversation.id },
    select: {
      eventType: true, schemaVersion: true, aggregateType: true, aggregateId: true,
      campusId: true, occurredAt: true, payload: true,
    },
  });
  if (!origin || origin.eventType !== LISTING_CONVERSATION_CREATED_EVENT_TYPE ||
      origin.schemaVersion !== 1 || origin.aggregateType !== "CONVERSATION" ||
      origin.aggregateId !== conversation.id || origin.campusId !== campusId ||
      origin.occurredAt.getTime() !== conversation.createdAt.getTime()) return "INELIGIBLE";
  const facts = origin.payload;
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return "INELIGIBLE";
  const values = facts as Record<string, unknown>;
  if (Object.keys(values).sort().join(",") !== "conversationId,listingId,listingType" ||
      values.conversationId !== conversation.id || values.listingId !== listingId ||
      values.listingType !== input.orderType) return "INELIGIBLE";

  // Real pre-order conversation: original DIRECT message must be authored by
  // the buyer before the canonical order creation, not a system/order message.
  const firstDirect = await tx.message.findFirst({
    where: { conversationId: conversation.id, type: "DIRECT" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { senderId: true, createdAt: true },
  });
  if (!firstDirect || firstDirect.senderId !== buyerId ||
      firstDirect.createdAt.getTime() > time.getTime()) return "INELIGIBLE";

  const result = await recordDomainEventTx(tx, {
    eventType: LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_TYPE,
    schemaVersion: LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_SCHEMA_VERSION,
    aggregateType: LISTING_CONVERSATION_ORDER_ATTRIBUTED_AGGREGATE_TYPE,
    aggregateId: input.orderId, campusId, occurredAt: time,
    payload: {
      conversationId: conversation.id, orderId: input.orderId,
      listingId, listingType: input.orderType,
    },
  });
  return result.recorded ? "RECORDED" : "DUPLICATE";
}
