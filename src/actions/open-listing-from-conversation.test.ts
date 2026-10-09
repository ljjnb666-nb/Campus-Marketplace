import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, conversationFindFirst, productFindUnique,
  serviceFindUnique, rentalFindUnique, eventFindUnique, issuer,
  enabled, setCookie, redirect } = vi.hoisted(() => ({
  requireUser: vi.fn(), conversationFindFirst: vi.fn(), productFindUnique: vi.fn(),
  serviceFindUnique: vi.fn(), rentalFindUnique: vi.fn(), eventFindUnique: vi.fn(),
  issuer: vi.fn(), enabled: vi.fn(), setCookie: vi.fn(),
  redirect: vi.fn((url: string) => { throw new Error("REDIRECT:" + url); }),
}));

vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findFirst: conversationFindFirst },
    product: { findUnique: productFindUnique },
    serviceListing: { findUnique: serviceFindUnique },
    rentalListing: { findUnique: rentalFindUnique },
    domainEvent: { findUnique: eventFindUnique },
  },
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/analytics/order-origin-cookie", () => ({ setOrderOriginCookie: setCookie }));
vi.mock("@/lib/analytics/order-conversation-attribution", () => ({
  mintOrderOriginToken: issuer,
  orderAttributionEnabled: enabled,
}));

import { openListingFromConversation } from "@/actions/open-listing-from-conversation";

const createdAt = new Date("2026-10-09T06:00:00.000Z");
function conv(type: "PRODUCT" | "SERVICE" | "RENTAL" = "PRODUCT") {
  return {
    id: "conv-1", createdAt,
    productId: type === "PRODUCT" ? "listing-1" : null,
    serviceListingId: type === "SERVICE" ? "listing-1" : null,
    rentalListingId: type === "RENTAL" ? "listing-1" : null,
    errandTaskId: null, orderId: null, rentalOrderId: null,
    participants: [{ userId: "buyer-1" }, { userId: "seller-1" }],
    messages: [{ senderId: "buyer-1", createdAt }],
  };
}
const req = () => {
  const data = new FormData();
  data.set("conversationId", "conv-1");
  return data;
};
function event(type: string) {
  return {
    eventType: "LISTING_CONVERSATION_CREATED", schemaVersion: 1,
    aggregateType: "CONVERSATION", aggregateId: "conv-1",
    campusId: "campus-1", occurredAt: createdAt,
    payload: { conversationId: "conv-1", listingId: "listing-1", listingType: type },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  requireUser.mockResolvedValue({ id: "buyer-1" });
  enabled.mockReturnValue(true);
  issuer.mockReturnValue("signed-token");
  setCookie.mockResolvedValue(undefined);
  conversationFindFirst.mockResolvedValue(conv());
  productFindUnique.mockResolvedValue({
    campusId: "campus-1", sellerId: "seller-1", deletedAt: null,
  });
  serviceFindUnique.mockResolvedValue({
    campusId: "campus-1", providerId: "seller-1", deletedAt: null,
  });
  rentalFindUnique.mockResolvedValue({
    campusId: "campus-1", ownerId: "seller-1", deletedAt: null,
  });
  eventFindUnique.mockResolvedValue(event("PRODUCT"));
});

describe("Phase 10K-R2c-02B authenticated conversation -> listing POST", () => {
  it.each([
    ["PRODUCT", "/products/listing-1"],
    ["SERVICE", "/services/listing-1"],
    ["RENTAL", "/rentals/listing-1"],
  ] as const)("issues explicit trusted origin for %s", async (type, url) => {
    conversationFindFirst.mockResolvedValue(conv(type));
    eventFindUnique.mockResolvedValue(event(type));
    await expect(openListingFromConversation(req())).rejects.toThrow("REDIRECT:" + url);
    expect(conversationFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "conv-1", participants: { some: { userId: "buyer-1" } } },
    }));
    expect(issuer).toHaveBeenCalledWith({
      actorId: "buyer-1", conversationId: "conv-1",
      listingId: "listing-1", listingType: type,
    });
    expect(setCookie).toHaveBeenCalledWith("signed-token");
  });

  it("disabled gate preserves normal navigation without minting", async () => {
    enabled.mockReturnValue(false);
    await expect(openListingFromConversation(req())).rejects.toThrow("REDIRECT:/products/listing-1");
    expect(issuer).not.toHaveBeenCalled();
    expect(productFindUnique).not.toHaveBeenCalled();
    expect(setCookie).toHaveBeenCalledWith(null);
  });

  it("nonparticipant and malformed IDs never issue a token or query other tenant data", async () => {
    conversationFindFirst.mockResolvedValue(null);
    await expect(openListingFromConversation(req())).rejects.toThrow("REDIRECT:/messages");
    expect(issuer).not.toHaveBeenCalled();
    expect(setCookie).not.toHaveBeenCalled();
    const bad = new FormData(); bad.set("conversationId", "../other");
    await expect(openListingFromConversation(bad)).rejects.toThrow("REDIRECT:/messages");
    expect(conversationFindFirst).toHaveBeenCalledTimes(1);
  });

  it.each(["sender-mismatch", "source-event-missing", "campus-mismatch",
    "multi-listing", "owner-is-buyer", "third-participant",
  ])("does not mint for %s (fail closed, normal listing navigation)", async reason => {
    if (reason === "sender-mismatch") conversationFindFirst.mockResolvedValue({
      ...conv(), messages: [{ senderId: "seller-1", createdAt }],
    });
    if (reason === "source-event-missing") eventFindUnique.mockResolvedValue(null);
    if (reason === "campus-mismatch") eventFindUnique.mockResolvedValue({
      ...event("PRODUCT"), campusId: "another-campus",
    });
    if (reason === "multi-listing") conversationFindFirst.mockResolvedValue({
      ...conv(), rentalListingId: "another-rental",
    });
    if (reason === "owner-is-buyer") productFindUnique.mockResolvedValue({
      campusId: "campus-1", sellerId: "buyer-1", deletedAt: null,
    });
    if (reason === "third-participant") conversationFindFirst.mockResolvedValue({
      ...conv(), participants: [...conv().participants, { userId: "third-1" }],
    });
    if (reason === "multi-listing") {
      await expect(openListingFromConversation(req())).rejects.toThrow("REDIRECT:/messages");
      expect(setCookie).not.toHaveBeenCalled();
    } else {
      await expect(openListingFromConversation(req())).rejects.toThrow("REDIRECT:/products/listing-1");
      expect(setCookie).toHaveBeenCalledWith(null);
    }
    expect(issuer).not.toHaveBeenCalled();
  });
});
