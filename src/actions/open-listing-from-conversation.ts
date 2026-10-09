"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import {
  mintOrderOriginToken,
  orderAttributionEnabled,
  type AttributedOrderType,
} from "@/lib/analytics/order-conversation-attribution";
import { setOrderOriginCookie } from "@/lib/analytics/order-origin-cookie";
import { LISTING_CONVERSATION_CREATED_EVENT_TYPE } from "@/lib/domain-events/domain-event-registry";

const ID = /^[A-Za-z0-9_-]{1,191}$/;

type Source = { type: AttributedOrderType; listingId: string; url: string };

function sourceForConversation(conv: {
  productId: string | null;
  serviceListingId: string | null;
  rentalListingId: string | null;
  errandTaskId: string | null;
  orderId: string | null;
  rentalOrderId: string | null;
}): Source | null {
  if (conv.errandTaskId || conv.orderId || conv.rentalOrderId) return null;
  const entries: Source[] = [];
  if (conv.productId) entries.push({
    type: "PRODUCT", listingId: conv.productId, url: `/products/${conv.productId}`,
  });
  if (conv.serviceListingId) entries.push({
    type: "SERVICE", listingId: conv.serviceListingId, url: `/services/${conv.serviceListingId}`,
  });
  if (conv.rentalListingId) entries.push({
    type: "RENTAL", listingId: conv.rentalListingId, url: `/rentals/${conv.rentalListingId}`,
  });
  const source = entries.length === 1 ? entries[0] : null;
  return source && ID.test(source.listingId) ? source : null;
}

/**
 * The real chat header uses POST/Server Action, not a speculative GET/link.
 * Only the authenticated conversation participant can request this transition.
 * A read does not grant business privileges; canonical order creation will
 * separately re-check the order and conversation within its own transaction.
 */
export async function openListingFromConversation(formData: FormData): Promise<never> {
  const user = await requireUser();
  const candidate = formData.get("conversationId");
  if (typeof candidate !== "string" || !ID.test(candidate)) redirect("/messages");

  const conv = await prisma.conversation.findFirst({
    where: { id: candidate, participants: { some: { userId: user.id } } },
    select: {
      id: true, createdAt: true, productId: true, serviceListingId: true,
      rentalListingId: true, errandTaskId: true, orderId: true,
      rentalOrderId: true, participants: { select: { userId: true } },
      messages: {
        where: { type: "DIRECT" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 1, select: { senderId: true, createdAt: true },
      },
    },
  });
  if (!conv) redirect("/messages");
  const source = sourceForConversation(conv);
  if (!source) redirect("/messages");

  let token: string | null = null;
  if (orderAttributionEnabled() && conv.participants.length === 2 &&
      new Set(conv.participants.map(p => p.userId)).size === 2 &&
      conv.messages[0]?.senderId === user.id &&
      conv.messages[0].createdAt.getTime() >= conv.createdAt.getTime()) {
    const listing = source.type === "PRODUCT"
      ? await prisma.product.findUnique({
          where: { id: source.listingId },
          select: { campusId: true, sellerId: true, deletedAt: true },
        })
      : source.type === "SERVICE"
        ? await prisma.serviceListing.findUnique({
            where: { id: source.listingId },
            select: { campusId: true, providerId: true, deletedAt: true },
          })
        : await prisma.rentalListing.findUnique({
            where: { id: source.listingId },
            select: { campusId: true, ownerId: true, deletedAt: true },
          });
    const otherUserId = !listing ? null :
      "sellerId" in listing ? listing.sellerId :
      "providerId" in listing ? listing.providerId : listing.ownerId;
    if (listing && listing.deletedAt === null && otherUserId !== user.id &&
        conv.participants.some(p => p.userId === otherUserId)) {
      const event = await prisma.domainEvent.findUnique({
        where: { occurrenceKey: LISTING_CONVERSATION_CREATED_EVENT_TYPE + ":" + conv.id },
        select: {
          eventType: true, schemaVersion: true, aggregateType: true,
          aggregateId: true, campusId: true, occurredAt: true, payload: true,
        },
      });
      const fact = event?.payload;
      if (event && event.eventType === LISTING_CONVERSATION_CREATED_EVENT_TYPE &&
          event.schemaVersion === 1 && event.aggregateType === "CONVERSATION" &&
          event.aggregateId === conv.id && event.campusId === listing.campusId &&
          event.occurredAt.getTime() === conv.createdAt.getTime() &&
          fact && typeof fact === "object" && !Array.isArray(fact)) {
        const data = fact as Record<string, unknown>;
        if (Object.keys(data).sort().join(",") === "conversationId,listingId,listingType" &&
            data.conversationId === conv.id &&
            data.listingId === source.listingId && data.listingType === source.type) {
          token = mintOrderOriginToken({
            actorId: user.id, conversationId: conv.id,
            listingId: source.listingId, listingType: source.type,
          });
        }
      }
    }
  }

  // Any new explicit chat->listing navigation invalidates stale origin,
  // even when the feature is off or this conversation is ineligible.
  await setOrderOriginCookie(token);
  redirect(source.url);
}
