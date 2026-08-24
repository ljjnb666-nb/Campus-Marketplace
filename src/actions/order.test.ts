import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireUser,
  createNotifications,
  productFindFirst,
  serviceListingFindFirst,
  orderFindFirst,
  orderFindUnique,
  transactionMock,
  txOrderCreate,
  txOrderUpdate,
  txOrderUpdateMany,
  txProductUpdate,
  txProductUpdateMany,
  txServiceListingUpdate,
  txUserUpdate,
} = vi.hoisted(() => {
  const txOrderCreate = vi.fn();
  const txOrderUpdate = vi.fn();
  const txOrderUpdateMany = vi.fn();
  const txProductUpdate = vi.fn();
  const txProductUpdateMany = vi.fn();
  const txServiceListingUpdate = vi.fn();
  const txUserUpdate = vi.fn();
  const transactionClient = {
    order: {
      create: txOrderCreate,
      update: txOrderUpdate,
      updateMany: txOrderUpdateMany,
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
    serviceListingFindFirst: vi.fn(),
    orderFindFirst: vi.fn(),
    orderFindUnique: vi.fn(),
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txOrderCreate,
    txOrderUpdate,
    txOrderUpdateMany,
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
    serviceListing: {
      findFirst: serviceListingFindFirst,
    },
    order: {
      findFirst: orderFindFirst,
      findUnique: orderFindUnique,
    },
    $transaction: transactionMock,
  },
  withTransaction: transactionMock,
}));

import { createOrderNo } from "@/lib/order-no";
import { createProductOrder, createServiceOrder, updateOrderStatus } from "@/actions/order";

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
    serviceListingFindFirst.mockReset();
    orderFindFirst.mockReset();
    orderFindUnique.mockReset();
    transactionMock.mockClear();
    txOrderCreate.mockReset();
    txOrderUpdate.mockReset();
    txOrderUpdateMany.mockReset();
    txProductUpdate.mockReset();
    txProductUpdateMany.mockReset();
    txServiceListingUpdate.mockReset();
    txUserUpdate.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    txProductUpdateMany.mockResolvedValue({ count: 1 });
    txOrderUpdateMany.mockResolvedValue({ count: 1 });
    txUserUpdate.mockResolvedValue({});
    txOrderCreate.mockResolvedValue({ id: "order-new" });
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

    expect(txOrderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
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

  it("creates a product order, reserves the product and notifies both parties", async () => {
    productFindFirst.mockResolvedValue({
      id: "product-1",
      price: { toString: () => "30" },
      sellerId: "seller-1",
    });
    orderFindFirst.mockResolvedValue(null);

    const result = await createProductOrder(
      { success: false, message: "" },
      buildProductOrderFormData(),
    );

    expect(result).toEqual({
      success: true,
      message: "购买申请已提交，等待卖家确认",
      redirectTo: "/my/orders",
    });
    expect(txOrderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "PRODUCT",
        orderNo: expect.stringMatching(/^CM\d{8}[0-9A-F]{8}$/),
        buyerId: "user-1",
        sellerId: "seller-1",
        productId: "product-1",
        paymentStatus: "OFFLINE_PENDING",
      }),
    });
    expect(createNotifications).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ userId: "user-1" }),
        expect.objectContaining({ userId: "seller-1" }),
      ]),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/products/product-1");
  });

  it("rejects product orders with invalid form data", async () => {
    const formData = new FormData();
    formData.set("productId", "product-1");
    formData.set("meetingLocation", "");

    const result = await createProductOrder({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(productFindFirst).not.toHaveBeenCalled();
  });

  it("rejects product orders for missing or inactive products", async () => {
    productFindFirst.mockResolvedValue(null);

    const result = await createProductOrder(
      { success: false, message: "" },
      buildProductOrderFormData(),
    );

    expect(result).toEqual({
      success: false,
      message: "商品不存在或当前不可购买",
    });
  });

  it("returns a friendly message when order creation fails", async () => {
    productFindFirst.mockResolvedValue({
      id: "product-1",
      price: { toString: () => "30" },
      sellerId: "seller-1",
    });
    orderFindFirst.mockResolvedValue(null);
    txProductUpdateMany.mockRejectedValue(new Error("db down"));

    const result = await createProductOrder(
      { success: false, message: "" },
      buildProductOrderFormData(),
    );

    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it("creates a service order and notifies both parties", async () => {
    serviceListingFindFirst.mockResolvedValue({
      id: "service-1",
      price: { toString: () => "50" },
      providerId: "provider-1",
    });

    const formData = new FormData();
    formData.set("serviceId", "service-1");
    formData.set("meetingLocation", "图书馆");
    formData.set("note", "周三下午");

    const result = await createServiceOrder({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: true,
      message: "预约已提交，等待服务提供者确认",
      redirectTo: "/my/orders",
    });
    expect(txOrderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "SERVICE",
        buyerId: "user-1",
        sellerId: "provider-1",
        serviceListingId: "service-1",
      }),
    });
    expect(createNotifications).toHaveBeenCalledTimes(1);
  });

  it("rejects service orders for missing services or own services", async () => {
    serviceListingFindFirst.mockResolvedValue(null);
    const formData = new FormData();
    formData.set("serviceId", "service-1");
    formData.set("meetingLocation", "图书馆");
    formData.set("note", "");

    let result = await createServiceOrder({ success: false, message: "" }, formData);
    expect(result).toEqual({ success: false, message: "服务不存在或当前不可预约" });

    serviceListingFindFirst.mockResolvedValue({
      id: "service-1",
      price: { toString: () => "50" },
      providerId: "user-1",
    });
    result = await createServiceOrder({ success: false, message: "" }, formData);
    expect(result).toEqual({ success: false, message: "不能预约自己发布的服务" });
  });

  describe("updateOrderStatus transitions", () => {
    function orderFixture(overrides: Record<string, unknown>) {
      return {
        id: "order-1",
        type: "PRODUCT",
        status: "PENDING",
        buyerId: "buyer-1",
        sellerId: "user-1",
        productId: "product-1",
        errandTaskId: null,
        serviceListingId: null,
        ...overrides,
      };
    }

    function statusFormData(status: string) {
      const formData = new FormData();
      formData.set("orderId", "order-1");
      formData.set("status", status);
      return formData;
    }

    it("lets the seller accept a pending product order", async () => {
      orderFindUnique.mockResolvedValue(orderFixture({}));

      await updateOrderStatus(statusFormData("ACCEPTED"));

      expect(txOrderUpdateMany).toHaveBeenCalledWith({
        where: { id: "order-1", status: "PENDING" },
        data: { status: "ACCEPTED", completedAt: null, cancelReason: null },
      });
      expect(createNotifications).toHaveBeenCalled();
    });

    it("marks the product as sold and bumps counters on completion", async () => {
      orderFindUnique.mockResolvedValue(
        orderFixture({ status: "ACCEPTED", buyerId: "user-1", sellerId: "seller-1" }),
      );

      await updateOrderStatus(statusFormData("COMPLETED"));

      expect(txProductUpdate).toHaveBeenCalledWith({
        where: { id: "product-1" },
        data: { status: "SOLD" },
      });
      expect(txUserUpdate).toHaveBeenCalledTimes(2);
      expect(txUserUpdate).toHaveBeenNthCalledWith(1, {
        where: { id: "user-1" },
        data: { completedOrdersCount: { increment: 1 } },
      });
      expect(txUserUpdate).toHaveBeenNthCalledWith(2, {
        where: { id: "seller-1" },
        data: { completedOrdersCount: { increment: 1 } },
      });
    });

    it("increments the service counter when a service order completes", async () => {
      orderFindUnique.mockResolvedValue(
        orderFixture({
          type: "SERVICE",
          status: "IN_PROGRESS",
          productId: null,
          serviceListingId: "service-1",
        }),
      );

      await updateOrderStatus(statusFormData("COMPLETED"));

      expect(txServiceListingUpdate).toHaveBeenCalledWith({
        where: { id: "service-1" },
        data: { completedOrderCount: { increment: 1 } },
      });
      expect(txProductUpdate).not.toHaveBeenCalled();
    });

    it("skips side effects when the optimistic-lock update wins nothing", async () => {
      orderFindUnique.mockResolvedValue(orderFixture({}));
      txOrderUpdateMany.mockResolvedValue({ count: 0 });

      await updateOrderStatus(statusFormData("ACCEPTED"));

      expect(txProductUpdate).not.toHaveBeenCalled();
      expect(createNotifications).not.toHaveBeenCalled();
    });

    it("ignores illegal transitions", async () => {
      // 买家不能接受自己的商品订单
      orderFindUnique.mockResolvedValue(orderFixture({ buyerId: "user-1", sellerId: "seller-1" }));

      await updateOrderStatus(statusFormData("ACCEPTED"));

      expect(txOrderUpdateMany).not.toHaveBeenCalled();
    });

    it("ignores unknown orders and invalid payloads", async () => {
      orderFindUnique.mockResolvedValue(null);
      await updateOrderStatus(statusFormData("ACCEPTED"));
      expect(transactionMock).not.toHaveBeenCalled();

      const badFormData = new FormData();
      badFormData.set("orderId", "");
      await updateOrderStatus(badFormData);
      expect(orderFindUnique).toHaveBeenCalledTimes(1);
    });
  });
});

describe("createOrderNo", () => {
  it("returns a CM order number with an 8-digit date and 8 hex chars, unique across calls", () => {
    const first = createOrderNo();
    const second = createOrderNo();

    expect(first).toMatch(/^CM\d{8}[0-9A-F]{8}$/);
    expect(second).toMatch(/^CM\d{8}[0-9A-F]{8}$/);
    expect(first).not.toBe(second);
  });
});
