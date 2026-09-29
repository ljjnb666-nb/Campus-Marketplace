import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommunicationPolicyReader } from "@/lib/trust/communication-policy";

/**
 * Phase 8A-03（P8-B03）：中央沟通政策 resolver 单元测试。
 *
 * BLOCK-POLICY-01..03：pair block 双向派生（任意单向行 ⇒ pairBlocked，
 * 无需镜像行）。
 * OBLIGATION 矩阵：Order / RentalOrder / ErrandTask / Service listing 反查
 * / Product listing 反查 / Rental listing 反查的 active vs terminal，以及
 * wrong counterpart / wrong listing 必须 false（exact pair，历史订单不是
 * 永久 bypass token）。
 */

const A = "user-a";
const B = "user-b";
const OTHER = "user-other";

type BlockedRow = { blockerId: string; blockedUserId: string };

function makeReader(rows: {
  blocked?: BlockedRow[];
  order?: Record<string, unknown> | null;
  rentalOrder?: Record<string, unknown> | null;
  errandTask?: Record<string, unknown> | null;
  serviceOrders?: Array<Record<string, unknown>>;
  productOrders?: Array<Record<string, unknown>>;
  listingRentalOrders?: Array<Record<string, unknown>>;
}): CommunicationPolicyReader & {
  __calls: { findFirst: Array<Record<string, unknown>> };
} {
  const findFirstCalls: Array<Record<string, unknown>> = [];
  return {
    __calls: { findFirst: findFirstCalls },
    blockedUser: {
      findUnique: async (args: { where: { blockerId_blockedUserId: { blockerId: string; blockedUserId: string } } }) =>
        (rows.blocked ?? []).find(
          (row) =>
            row.blockerId === args.where.blockerId_blockedUserId.blockerId &&
            row.blockedUserId === args.where.blockerId_blockedUserId.blockedUserId,
        ) ?? null,
    },
    order: {
      findUnique: async () => (rows.order ?? null) as never,
      findFirst: async (args: Record<string, unknown>) => {
        findFirstCalls.push(args);
        return (rows.serviceOrders?.[0] ?? rows.productOrders?.[0] ?? null) as never;
      },
    },
    rentalOrder: {
      findUnique: async () => (rows.rentalOrder ?? null) as never,
      findFirst: async (args: Record<string, unknown>) => {
        findFirstCalls.push(args);
        return (rows.listingRentalOrders?.[0] ?? null) as never;
      },
    },
    errandTask: {
      findUnique: async () => (rows.errandTask ?? null) as never,
    },
  } as CommunicationPolicyReader & { __calls: { findFirst: Array<Record<string, unknown>> } };
}

import {
  hasActiveErrandObligationTx,
  hasActiveOrderObligationTx,
  hasActiveProductListingObligationTx,
  hasActiveRentalListingObligationTx,
  hasActiveRentalOrderObligationTx,
  hasActiveServiceObligationTx,
  resolveActiveConversationObligationTx,
  resolveConversationCommunicationPolicyTx,
  resolvePairBlockStateTx,
} from "@/lib/trust/communication-policy";

describe("resolvePairBlockStateTx（BLOCK-POLICY-01..03）", () => {
  it("BLOCK-POLICY-01：no block → pairBlocked=false", async () => {
    const reader = makeReader({ blocked: [] });
    const state = await resolvePairBlockStateTx(reader, A, B);
    expect(state.pairBlocked).toBe(false);
    expect(state.aBlocksB).toBe(false);
    expect(state.bBlocksA).toBe(false);
  });

  it("BLOCK-POLICY-02：A blocks B（单行）→ pairBlocked=true（无需镜像行）", async () => {
    const reader = makeReader({ blocked: [{ blockerId: A, blockedUserId: B }] });
    const state = await resolvePairBlockStateTx(reader, A, B);
    expect(state.pairBlocked).toBe(true);
    expect(state.aBlocksB).toBe(true);
    expect(state.bBlocksA).toBe(false);
  });

  it("BLOCK-POLICY-03：B blocks A（反向单行）→ pairBlocked=true", async () => {
    const reader = makeReader({ blocked: [{ blockerId: A, blockedUserId: B }] });
    const state = await resolvePairBlockStateTx(reader, B, A);
    expect(state.pairBlocked).toBe(true);
    expect(state.bBlocksA).toBe(true);
    expect(state.aBlocksB).toBe(false);
  });
});

describe("obligation resolvers（exact pair / canonical state）", () => {
  let reader: ReturnType<typeof makeReader>;

  beforeEach(() => {
    reader = makeReader({});
  });

  it("PRODUCT_ORDER active（PENDING/ACCEPTED/IN_PROGRESS）→ true", async () => {
    for (const status of ["PENDING", "ACCEPTED", "IN_PROGRESS"]) {
      reader = makeReader({ order: { buyerId: A, sellerId: B, status } });
      expect(await hasActiveOrderObligationTx(reader, "order-1", [A, B])).toBe(true);
    }
  });

  it("PRODUCT_ORDER terminal（COMPLETED/CANCELLED/REFUNDED）→ false", async () => {
    for (const status of ["COMPLETED", "CANCELLED", "REFUNDED"]) {
      reader = makeReader({ order: { buyerId: A, sellerId: B, status } });
      expect(await hasActiveOrderObligationTx(reader, "order-1", [A, B])).toBe(false);
    }
  });

  it("PRODUCT_ORDER wrong counterpart → false（历史订单不是 bypass token）", async () => {
    reader = makeReader({ order: { buyerId: A, sellerId: OTHER, status: "PENDING" } });
    expect(await hasActiveOrderObligationTx(reader, "order-1", [A, B])).toBe(false);
  });

  it("RENTAL_ORDER active（IN_RENTAL 等）→ true；terminal（COMPLETED/REJECTED/CANCELLED/CLOSED）→ false", async () => {
    for (const status of [
      "PENDING_APPROVAL",
      "PENDING_PAYMENT",
      "PENDING_PICKUP",
      "PICKED_UP",
      "IN_RENTAL",
      "PENDING_RETURN",
      "PENDING_INSPECTION",
      "OVERDUE",
      "IN_DISPUTE",
    ]) {
      reader = makeReader({ rentalOrder: { ownerId: A, renterId: B, status } });
      expect(await hasActiveRentalOrderObligationTx(reader, "ro-1", [A, B])).toBe(true);
    }
    for (const status of ["COMPLETED", "REJECTED", "CANCELLED", "CLOSED"]) {
      reader = makeReader({ rentalOrder: { ownerId: A, renterId: B, status } });
      expect(await hasActiveRentalOrderObligationTx(reader, "ro-1", [A, B])).toBe(false);
    }
  });

  it("RENTAL_ORDER wrong pair → false", async () => {
    reader = makeReader({ rentalOrder: { ownerId: A, renterId: OTHER, status: "IN_RENTAL" } });
    expect(await hasActiveRentalOrderObligationTx(reader, "ro-1", [A, B])).toBe(false);
  });

  it("SERVICE listing + active exact-pair SERVICE Order → true；no order → false", async () => {
    reader = makeReader({ serviceOrders: [{ id: "order-s1" }] });
    expect(await hasActiveServiceObligationTx(reader, "service-1", [A, B])).toBe(true);

    reader = makeReader({ serviceOrders: [] });
    expect(await hasActiveServiceObligationTx(reader, "service-1", [A, B])).toBe(false);
  });

  it("SERVICE listing 查询绑定 exact buyer/seller pair", async () => {
    reader = makeReader({ serviceOrders: [] });
    await hasActiveServiceObligationTx(reader, "service-1", [A, B]);

    const where = reader.__calls.findFirst[0]?.where as Record<string, unknown>;
    expect(where).toMatchObject({ type: "SERVICE", serviceListingId: "service-1" });
    const or = where.OR as Array<Record<string, string>>;
    expect(or).toContainEqual({ buyerId: A, sellerId: B });
    expect(or).toContainEqual({ buyerId: B, sellerId: A });
  });

  it("ERRAND active（CLAIMED/IN_PROGRESS/PENDING_CONFIRMATION/DISPUTED）exact pair → true", async () => {
    for (const status of ["CLAIMED", "IN_PROGRESS", "PENDING_CONFIRMATION", "DISPUTED"]) {
      reader = makeReader({ errandTask: { publisherId: A, accepterId: B, status } });
      expect(await hasActiveErrandObligationTx(reader, "errand-1", [A, B])).toBe(true);
    }
  });

  it("ERRAND OPEN/COMPLETED/CANCELLED → false", async () => {
    for (const status of ["OPEN", "COMPLETED", "CANCELLED"]) {
      reader = makeReader({ errandTask: { publisherId: A, accepterId: B, status } });
      expect(await hasActiveErrandObligationTx(reader, "errand-1", [A, B])).toBe(false);
    }
  });

  it("ERRAND 未被认领（accepter null）或 pair 不符 → false", async () => {
    reader = makeReader({ errandTask: { publisherId: A, accepterId: null, status: "OPEN" } });
    expect(await hasActiveErrandObligationTx(reader, "errand-1", [A, B])).toBe(false);

    reader = makeReader({ errandTask: { publisherId: A, accepterId: OTHER, status: "IN_PROGRESS" } });
    expect(await hasActiveErrandObligationTx(reader, "errand-1", [A, B])).toBe(false);
  });

  it("PRODUCT listing 反查：active PRODUCT Order → true；wrong listing → false", async () => {
    reader = makeReader({ productOrders: [{ id: "order-p1" }] });
    expect(await hasActiveProductListingObligationTx(reader, "product-1", [A, B])).toBe(true);

    reader = makeReader({ productOrders: [] });
    expect(await hasActiveProductListingObligationTx(reader, "product-1", [A, B])).toBe(false);

    const where = reader.__calls.findFirst[0]?.where as Record<string, unknown>;
    expect(where).toMatchObject({ type: "PRODUCT", productId: "product-1" });
  });

  it("RENTAL listing 反查：active RentalOrder → true；terminal only → false", async () => {
    reader = makeReader({ listingRentalOrders: [{ id: "ro-1" }] });
    expect(await hasActiveRentalListingObligationTx(reader, "rental-1", [A, B])).toBe(true);

    reader = makeReader({ listingRentalOrders: [] });
    expect(await hasActiveRentalListingObligationTx(reader, "rental-1", [A, B])).toBe(false);

    const where = reader.__calls.findFirst[0]?.where as Record<string, unknown>;
    expect(where).toMatchObject({ rentalListingId: "rental-1" });
    expect((where.status as Record<string, unknown>).notIn).toContain("CLOSED");
  });
});

describe("resolveActiveConversationObligationTx（refs 组合）", () => {
  it("refs 全空 → false", async () => {
    const reader = makeReader({});
    expect(await resolveActiveConversationObligationTx(reader, {}, [A, B])).toBe(false);
  });

  it("orderId 直连 active → true", async () => {
    const reader = makeReader({ order: { buyerId: A, sellerId: B, status: "PENDING" } });
    expect(await resolveActiveConversationObligationTx(reader, { orderId: "order-1" }, [A, B])).toBe(
      true,
    );
  });
});

describe("resolveConversationCommunicationPolicyTx（mode 派生）", () => {
  it("未 block → NORMAL / canSendMessage=true", async () => {
    const reader = makeReader({});
    const policy = await resolveConversationCommunicationPolicyTx(reader, {}, A, B);
    expect(policy).toEqual({
      pairBlocked: false,
      activeObligation: false,
      canSendMessage: true,
      mode: "NORMAL",
    });
  });

  it("blocked + 无 obligation → BLOCKED / 双向 DENY", async () => {
    const reader = makeReader({ blocked: [{ blockerId: A, blockedUserId: B }] });
    const fromA = await resolveConversationCommunicationPolicyTx(reader, {}, A, B);
    const fromB = await resolveConversationCommunicationPolicyTx(reader, {}, B, A);
    for (const policy of [fromA, fromB]) {
      expect(policy).toEqual({
        pairBlocked: true,
        activeObligation: false,
        canSendMessage: false,
        mode: "BLOCKED",
      });
    }
  });

  it("blocked + active obligation → EXISTING_OBLIGATION_OVERRIDE / 双向 ALLOW", async () => {
    const reader = makeReader({
      blocked: [{ blockerId: A, blockedUserId: B }],
      order: { buyerId: A, sellerId: B, status: "ACCEPTED" },
    });
    const fromA = await resolveConversationCommunicationPolicyTx(
      reader,
      { orderId: "order-1" },
      A,
      B,
    );
    const fromB = await resolveConversationCommunicationPolicyTx(
      reader,
      { orderId: "order-1" },
      B,
      A,
    );
    for (const policy of [fromA, fromB]) {
      expect(policy).toEqual({
        pairBlocked: true,
        activeObligation: true,
        canSendMessage: true,
        mode: "EXISTING_OBLIGATION_OVERRIDE",
      });
    }
  });
});
