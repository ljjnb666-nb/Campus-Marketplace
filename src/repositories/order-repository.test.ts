import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  orderFindMany,
} = vi.hoisted(() => ({
  orderFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: {
      findMany: orderFindMany,
    },
  },
}));

import { getMyOrders, getOrdersInvolvingUser } from "@/repositories/order-repository";

describe("order repository", () => {
  beforeEach(() => {
    orderFindMany.mockReset();
  });

  it("returns buyer and seller orders with linked targets and reviews", async () => {
    orderFindMany
      .mockResolvedValueOnce([{ id: "buyer-order-1" }])
      .mockResolvedValueOnce([{ id: "seller-order-1" }]);

    const result = await getMyOrders("user-1");

    expect(orderFindMany).toHaveBeenNthCalledWith(1, {
      where: { buyerId: "user-1" },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        buyer: { select: { id: true, name: true } },
        seller: { select: { id: true, name: true } },
        product: { select: { id: true, title: true } },
        errandTask: { select: { id: true, title: true } },
        serviceListing: { select: { id: true, title: true } },
        reviews: {
          select: {
            id: true,
            authorId: true,
            targetUserId: true,
            rating: true,
          },
        },
      },
    });
    expect(orderFindMany).toHaveBeenNthCalledWith(2, {
      where: { sellerId: "user-1" },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        buyer: { select: { id: true, name: true } },
        seller: { select: { id: true, name: true } },
        product: { select: { id: true, title: true } },
        errandTask: { select: { id: true, title: true } },
        serviceListing: { select: { id: true, title: true } },
        reviews: {
          select: {
            id: true,
            authorId: true,
            targetUserId: true,
            rating: true,
          },
        },
      },
    });
    expect(result).toEqual({
      buyerOrders: [{ id: "buyer-order-1" }],
      sellerOrders: [{ id: "seller-order-1" }],
    });
  });

  it("returns orders where the user is buyer or seller for the unified order center", async () => {
    orderFindMany.mockResolvedValueOnce([{ id: "order-1" }]);

    const result = await getOrdersInvolvingUser("user-1");

    expect(orderFindMany).toHaveBeenCalledWith({
      where: {
        OR: [{ buyerId: "user-1" }, { sellerId: "user-1" }],
      },
      include: {
        buyer: { select: { id: true, name: true, avatarUrl: true, schoolName: true } },
        seller: { select: { id: true, name: true, avatarUrl: true, schoolName: true } },
        product: { select: { id: true, title: true, images: { take: 1 } } },
        errandTask: { select: { id: true, title: true, status: true } },
        serviceListing: { select: { id: true, title: true, coverImageUrl: true } },
        reviews: { select: { authorId: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(result).toEqual([{ id: "order-1" }]);
  });
});
