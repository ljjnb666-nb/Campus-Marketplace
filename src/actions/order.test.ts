import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireUser,
  createNotifications,
  productFindFirst,
  orderFindFirst,
  orderFindUnique,
  transactionMock,
  txOrderCreate,
  txOrderUpdate,
  txProductUpdate,
  txProductUpdateMany,
  txServiceListingUpdate,
  txUserUpdate,
} = vi.hoisted(() => {
  const txOrderCreate = vi.fn();
  const txOrderUpdate = vi.fn();
  const txProductUpdate = vi.fn();
  const txProductUpdateMany = vi.fn();
  const txServiceListingUpdate = vi.fn();
  const txUserUpdate = vi.fn();
  const transactionClient = {
    order: {
      create: txOrderCreate,
      update: txOrderUpdate,
    },
    product: {
      update: txProductUpdate,
      updateMany: txProductUpdateMany,
    },
    serviceListing: {
      update: txServiceListingUpdate,
    },
    user: {
      update: txUserUpdate,
    },
  };

  return {
    revalidatePath: vi.fn(),
    requireUser: vi.fn(),
    createNotifications: vi.fn(),
    productFindFirst: vi.fn(),
    orderFindFirst: vi.fn(),
    orderFindUnique: vi.fn(),
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txOrderCreate,
    txOrderUpdate,
    txProductUpdate,
    txProductUpdateMany,
    txServiceListingUpdate,
    txUserUpdate,
  };
});

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotifications,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: {
      findFirst: productFindFirst,
    },
    order: {
      findFirst: orderFindFirst,
      findUnique: orderFindUnique,
    },
    $transaction: transactionMock,
  },
}));

import { createProductOrder, updateOrderStatus } from "@/actions/order";

function buildProductOrderFormData() {
  const formData = new FormData();
  formData.set("productId", "product-1");
  formData.set("meetingLocation", "图书馆门口");
  formData.set("note", "今晚 8 点前可以面交");
  return formData;
}

describe("order actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireUser.mockReset();
    createNotifications.mockReset();
    productFindFirst.mockReset();
    orderFindFirst.mockReset();
    orderFindUnique.mockReset();
    transactionMock.mockClear();
    txOrderCreate.mockReset();
    txOrderUpdate.mockReset();
    txProductUpdate.mockReset();
    txProductUpdateMany.mockReset();
    txServiceListingUpdate.mockReset();
    txUserUpdate.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    txProductUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("rejects product orders for the current user's own listing", async () => {
    productFindFirst.mockResolvedValue({
      id: "product-1",
      price: { toString: () => "30" },
      sellerId: "user-1",
    });

    const result = await createProductOrder(
      { success: false, message: "" },
      buildProductOrderFormData(),
    );

    expect(result).toEqual({
      success: false,
      message: "不能购买自己发布的商品",
    });
    expect(orderFindFirst).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("rejects product orders when an active order already exists", async () => {
    productFindFirst.mockResolvedValue({
      id: "product-1",
      price: { toString: () => "30" },
      sellerId: "seller-1",
    });
    orderFindFirst.mockResolvedValue({ id: "order-1" });

    const result = await createProductOrder(
      { success: false, message: "" },
      buildProductOrderFormData(),
    );

    expect(result).toEqual({
      success: false,
      message: "该商品已有进行中的订单",
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("does not create a duplicate order when another request reserves the product first", async () => {
    productFindFirst.mockResolvedValue({
      id: "product-1",
      price: { toString: () => "30" },
      sellerId: "seller-1",
    });
    orderFindFirst.mockResolvedValue(null);
    txProductUpdateMany.mockResolvedValue({ count: 0 });

    const result = await createProductOrder(
      { success: false, message: "" },
      buildProductOrderFormData(),
    );

    expect(result).toEqual({
      success: false,
      message: "该商品已有进行中的订单",
    });
    expect(txProductUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "product-1",
        status: "ACTIVE",
        deletedAt: null,
      },
      data: { status: "RESERVED" },
    });
    expect(txOrderCreate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("cancels a pending product order and restores the product status", async () => {
    orderFindUnique.mockResolvedValue({
      id: "order-1",
      type: "PRODUCT",
      status: "PENDING",
      buyerId: "user-1",
      sellerId: "seller-1",
      productId: "product-1",
      errandTaskId: null,
      serviceListingId: null,
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("status", "CANCELLED");

    await updateOrderStatus(formData);

    expect(txOrderUpdate).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: {
        status: "CANCELLED",
        completedAt: null,
        cancelReason: "用户主动取消",
      },
    });
    expect(txProductUpdate).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { status: "ACTIVE" },
    });
    expect(createNotifications).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/my/orders");
    expect(revalidatePath).toHaveBeenCalledWith("/products/product-1");
  });
});
