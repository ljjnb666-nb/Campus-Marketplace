import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics/liquidity-domain-events", () => ({
  recordLiquidityListingCreatedTx: vi.fn().mockResolvedValue({ recorded: true }),
  recordLiquidityDemandCreatedTx: vi.fn().mockResolvedValue({ recorded: true }),
  recordLiquidityTransactionCompletedTx: vi.fn().mockResolvedValue({ recorded: true }),
  recordLiquidityTransactionCompletionFactsTx: vi.fn().mockResolvedValue({
    completion: { recorded: true },
    value: { recorded: true },
  }),
}));

const {
  revalidatePath,
  requireUser,
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
  txExecuteRaw,
  txUserFindMany,
  txOrderFindFirst,
  txErrandTaskUpdateMany,
  txAsyncJobCreateMany,
  txNotificationCreateMany,
  txNotificationFindUnique,
  setProductLockRow,
  errandLockRowHolder,
  orderLockRowHolder,
} = vi.hoisted(() => {
  const txExecuteRaw = vi.fn();
  const txUserFindMany = vi.fn();
  const txOrderCreate = vi.fn();
  const txOrderUpdate = vi.fn();
  const txOrderUpdateMany = vi.fn();
  const txOrderFindFirst = vi.fn();
  const txProductUpdate = vi.fn();
  const txProductUpdateMany = vi.fn();
  const txServiceListingUpdate = vi.fn();
  const txUserUpdate = vi.fn();
  const txErrandTaskUpdateMany = vi.fn();
  // Phase 9A：createProductOrderTx 在同事务写入 expiry durable intent
  const txAsyncJobCreateMany = vi.fn();
  // Phase 9B：canonical notification emit（emitNotificationTx 写边界）
  const txNotificationCreateMany = vi.fn();
  const txNotificationFindUnique = vi.fn();
  const orderFindUnique = vi.fn();
  // Product 行锁返回行（默认 = 创建路径的 ACTIVE 行；取消路径测试
  // 通过 setProductLockRow 切换为 RESERVED 投影行）
  const defaultProductLockRow = {
    id: "product-1",
    campusId: "campus-1",
    status: "ACTIVE",
    price: "100",
    sellerId: "seller-1",
    deletedAt: null,
  };
  let productLockRow: Record<string, unknown> = defaultProductLockRow;
  const setProductLockRow = (row: Record<string, unknown>) => {
    productLockRow = row;
  };
  // AUDIT2-RB02：ERRAND 订单中心委派的行权威（ErrandTask FOR UPDATE /
  // active Order FOR UPDATE），由用例按需覆写
  const errandLockRowHolder = { row: null as Record<string, unknown> | null };
  const orderLockRowHolder = {
    row: {
      id: "order-1",
      type: "PRODUCT",
      status: "PENDING",
      buyerId: "user-1",
      sellerId: "seller-1",
      productId: "product-1",
      // Phase 8B-01：accept 权威的锁内 fresh deadline 谓词
      productReservationExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } as Record<string, unknown> | Record<string, unknown>[],
  };
  const transactionClient = {
    // AUDIT2-RB02：ERRAND 委派路径的 Task 写（applyErrandStartWrites）
    errandTask: {
      updateMany: txErrandTaskUpdateMany,
    },
    order: {
      create: txOrderCreate,
      // RB-03 REVIEW FIX：updateOrderStatusTx 的 fresh read 在 tx 内
      findUnique: orderFindUnique,
      update: txOrderUpdate,
      updateMany: txOrderUpdateMany,
      // AUDIT2-RB01：cancellation 投影的 other-active-order 防御读取
      findFirst: txOrderFindFirst,
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
      findMany: txUserFindMany,
    },
    // Phase 9A：reservation expiry durable intent（Order 同事务原子落盘）
    asyncJob: {
      createMany: txAsyncJobCreateMany,
    },
    campusMembership: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] }; campusId: string } }) =>
        where.userId.in.map((userId: string) => ({ userId })),
      ),
    },
    $executeRaw: txExecuteRaw,
    // Phase 7C：listing 行锁（FOR UPDATE）；AUDIT2-RB01：Order/Product
    // 行锁——按锁内 SELECT 的目标表分流返回行
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join("|") : String(strings);
      if (sql.includes('FROM "ErrandTask"')) {
        return errandLockRowHolder.row ? [errandLockRowHolder.row] : [];
      }
      if (sql.includes('FROM "Order"')) {
        return Array.isArray(orderLockRowHolder.row)
          ? orderLockRowHolder.row
          : [orderLockRowHolder.row];
      }
      if (sql.includes('FROM "Product"')) {
        return [productLockRow];
      }
      if (sql.includes("ServiceListing")) {
        return [
          {
            id: "service-1",
            campusId: "campus-1",
            status: "ACTIVE",
            price: "50",
            providerId: "provider-1",
            deletedAt: null,
          },
        ];
      }
      return [
        {
          id: "product-1",
          campusId: "campus-1",
          status: "ACTIVE",
          price: "100",
          sellerId: "seller-1",
          deletedAt: null,
        },
      ];
    }),
    listingModeration: {
      findFirst: vi.fn(async () => null),
    },
    // Phase 9B：emitNotificationTx 内部写入（createMany + dedupe winner 读回）
    notification: {
      createMany: txNotificationCreateMany,
      findUnique: txNotificationFindUnique,
    },
  };

  return {
    revalidatePath: vi.fn(),
    requireUser: vi.fn(),
    productFindFirst: vi.fn(),
    serviceListingFindFirst: vi.fn(),
    orderFindFirst: vi.fn(),
    orderFindUnique,
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txOrderCreate,
    txOrderUpdate,
    txOrderUpdateMany,
    txOrderFindFirst,
    txProductUpdate,
    txProductUpdateMany,
    txServiceListingUpdate,
    txUserUpdate,
    txExecuteRaw,
    txUserFindMany,
    txErrandTaskUpdateMany,
    txAsyncJobCreateMany,
    txNotificationCreateMany,
    txNotificationFindUnique,
    setProductLockRow,
    errandLockRowHolder,
    orderLockRowHolder,
  };
});

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

const { completeErrandOrderTxMock } = vi.hoisted(() => ({
  completeErrandOrderTxMock: vi.fn(),
}));

vi.mock("@/lib/governance/active-account-mutation", () => ({
  prepareActiveAccountMutation: vi.fn().mockResolvedValue(undefined),
  assertActiveAccountMutationAllowed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/errand-completion", () => ({
  completeErrandOrderTx: completeErrandOrderTxMock,
}));

vi.mock("@/lib/enforcement/capability-gate", () => ({
  requireMarketplaceCapability: vi.fn().mockResolvedValue(undefined),
  requireParticipantsMarketplaceEligible: vi.fn().mockResolvedValue(undefined),
  marketplaceObligationValidator: vi.fn(() => async () => undefined),
  // AUDIT2-RB01：cancellation 投影的 checks-only 能力判定（默认放行）
  evaluateMarketplaceCapability: vi.fn().mockResolvedValue({ allowed: true }),
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
    productFindFirst.mockReset();
    serviceListingFindFirst.mockReset();
    orderFindFirst.mockReset();
    orderFindUnique.mockReset();
    transactionMock.mockClear();
    txOrderCreate.mockReset();
    txOrderUpdate.mockReset();
    txOrderUpdateMany.mockReset();
    txOrderFindFirst.mockReset().mockResolvedValue(null);
    txProductUpdate.mockReset().mockResolvedValue({ campusId: "campus-1" });
    setProductLockRow({
      id: "product-1",
      campusId: "campus-1",
      status: "ACTIVE",
      price: "100",
      sellerId: "seller-1",
      deletedAt: null,
    });
    errandLockRowHolder.row = null;
    orderLockRowHolder.row = {
      id: "order-1",
      type: "PRODUCT",
      status: "PENDING",
      buyerId: "user-1",
      sellerId: "seller-1",
      productId: "product-1",
      // Phase 8B-01：cancellation 权威的锁内 fresh deadline 谓词
      productReservationExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
    txProductUpdateMany.mockReset();
    txServiceListingUpdate.mockReset().mockResolvedValue({ campusId: "campus-1" });
    txUserUpdate.mockReset();
    txErrandTaskUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    txAsyncJobCreateMany.mockReset().mockResolvedValue({ count: 1 });
    // Phase 9B：emitNotificationTx 写边界（createMany + dedupe winner 读回）
    txNotificationCreateMany.mockReset().mockResolvedValue({ count: 1 });
    txNotificationFindUnique.mockReset().mockResolvedValue({ id: "notification-1" });

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    txProductUpdateMany.mockResolvedValue({ count: 1 });
    txOrderUpdateMany.mockResolvedValue({ count: 1 });
    txUserUpdate.mockResolvedValue({});
    txOrderCreate.mockResolvedValue({ id: "order-new" });

    // participant governance guard 默认全绿（锁查询 + 全员 ACTIVE）
    txExecuteRaw.mockReset().mockResolvedValue(0);
    txUserFindMany.mockReset().mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id: string) => ({ id, status: "ACTIVE", deletedAt: null, erasedAt: null })),
    );
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
      campusId: "campus-1",
    });
    orderFindFirst.mockResolvedValue({ id: "order-1" });

    const result = await createProductOrder(
      { success: false, message: "" },
      buildProductOrderFormData(),
    );

    // 事务外 active-order 预检命中（orderFindFirst）→ 专用文案，
    // 不经过 tx-null 泛化路径
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
      campusId: "campus-1",
    });
    orderFindFirst.mockResolvedValue(null);
    txProductUpdateMany.mockResolvedValue({ count: 0 });

    const result = await createProductOrder(
      { success: false, message: "" },
      buildProductOrderFormData(),
    );

    // 事务外 active-order 预检命中（orderFindFirst）→ 专用文案，
    // 不经过 tx-null 泛化路径
    // Phase 7C FR-02：tx-null（含 updateMany 抢占失败）→ 统一 SAFE 文案
    expect(result).toEqual({
      success: false,
      message: "商品不存在或当前不可购买",
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
    expect(txNotificationCreateMany).not.toHaveBeenCalled();
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
    // AUDIT2-RB01：cancellation 投影读到的锁内 Product 行 = RESERVED
    setProductLockRow({
      id: "product-1",
      campusId: "campus-1",
      status: "RESERVED",
      sellerId: "seller-1",
      deletedAt: null,
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("status", "CANCELLED");

    await updateOrderStatus(formData);

    expect(txOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-1", status: "PENDING" },
        data: expect.objectContaining({
          status: "CANCELLED",
          completedAt: null,
          cancelReason: "用户主动取消",
          // PHASE 8B-01：期限内取消记录 CANCELLED resolution（可审计的关闭原因）
          productReservationResolution: "CANCELLED",
        }),
      }),
    );
    expect(txProductUpdate).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { status: "ACTIVE" },
    });
    // Phase 9B：canonical CANCELLED 通知 = buyer + seller 各一条 ORDER_STATUS_CHANGED
    expect(txNotificationCreateMany).toHaveBeenCalledTimes(2);
    expect(txNotificationCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      userId: "user-1",
      orderId: "order-1",
      type: "ORDER",
      title: "订单状态更新：已取消",
      dedupeKey: "ORDER_STATUS_CHANGED:order-1:CANCELLED:user-1",
      kind: "ORDER_STATUS_CHANGED",
    });
    expect(txNotificationCreateMany.mock.calls[1][0].data[0]).toMatchObject({
      userId: "seller-1",
      orderId: "order-1",
      dedupeKey: "ORDER_STATUS_CHANGED:order-1:CANCELLED:seller-1",
    });
    // canonical 参与方锁路径：buyer + seller 两把 sorted advisory 锁
    expect(txExecuteRaw).toHaveBeenCalledTimes(2);
    expect(revalidatePath).toHaveBeenCalledWith("/my/orders");
    expect(revalidatePath).toHaveBeenCalledWith("/products/product-1");
  });

  it("creates a product order, reserves the product and notifies both parties", async () => {
    productFindFirst.mockResolvedValue({
      id: "product-1",
      price: { toString: () => "30" },
      sellerId: "seller-1",
      campusId: "campus-1",
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
    // Phase 9B：canonical 通知 = buyer + seller 各一条 PRODUCT_ORDER_CREATED
    expect(txNotificationCreateMany).toHaveBeenCalledTimes(2);
    expect(txNotificationCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      userId: "user-1",
      orderId: "order-new",
      type: "ORDER",
      title: "购买申请已提交",
      content: "你的商品购买申请已提交，等待卖家确认。",
      dedupeKey: "PRODUCT_ORDER_CREATED:order-new:user-1",
      kind: "PRODUCT_ORDER_CREATED",
      payload: { orderId: "order-new", buyerId: "user-1", sellerId: "seller-1" },
    });
    expect(txNotificationCreateMany.mock.calls[1][0].data[0]).toMatchObject({
      userId: "seller-1",
      orderId: "order-new",
      type: "ORDER",
      title: "收到新的商品订单",
      content: "有同学提交了你的商品购买申请，请尽快确认订单状态。",
      dedupeKey: "PRODUCT_ORDER_CREATED:order-new:seller-1",
      kind: "PRODUCT_ORDER_CREATED",
    });
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
      campusId: "campus-1",
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
      campusId: "campus-1",
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
    // Phase 9B：canonical 通知 = buyer + provider 各一条 SERVICE_ORDER_CREATED
    expect(txNotificationCreateMany).toHaveBeenCalledTimes(2);
    expect(txNotificationCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      userId: "user-1",
      orderId: "order-new",
      type: "ORDER",
      title: "服务预约已提交",
      dedupeKey: "SERVICE_ORDER_CREATED:order-new:user-1",
      kind: "SERVICE_ORDER_CREATED",
    });
    expect(txNotificationCreateMany.mock.calls[1][0].data[0]).toMatchObject({
      userId: "provider-1",
      orderId: "order-new",
      title: "收到新的服务预约",
      dedupeKey: "SERVICE_ORDER_CREATED:order-new:provider-1",
      kind: "SERVICE_ORDER_CREATED",
    });
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
      // PHASE 8B-01：PRODUCT ACCEPTED 委派 acceptProductOrderTx——锁内
      // fresh Order 行（identity 与 orderFixture 一致 + 未来 deadline）
      orderLockRowHolder.row = {
        id: "order-1",
        type: "PRODUCT",
        status: "PENDING",
        buyerId: "buyer-1",
        sellerId: "user-1",
        productId: "product-1",
        productReservationExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };

      await updateOrderStatus(statusFormData("ACCEPTED"));

      // 写入由 canonical 权威完成（resolution ACCEPTED + 既有 accept 通知语义）
      expect(txOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "order-1", status: "PENDING" },
          data: expect.objectContaining({
            status: "ACCEPTED",
            completedAt: null,
            cancelReason: null,
            productReservationResolution: "ACCEPTED",
          }),
        }),
      );
      // Phase 9B：canonical ACCEPTED 通知 = buyer + seller 各一条 ORDER_STATUS_CHANGED
      expect(txNotificationCreateMany).toHaveBeenCalledTimes(2);
      expect(txNotificationCreateMany.mock.calls[0][0].data[0]).toMatchObject({
        userId: "buyer-1",
        orderId: "order-1",
        type: "ORDER",
        title: "订单状态更新：已接单",
        dedupeKey: "ORDER_STATUS_CHANGED:order-1:ACCEPTED:buyer-1",
        kind: "ORDER_STATUS_CHANGED",
      });
      expect(txNotificationCreateMany.mock.calls[1][0].data[0]).toMatchObject({
        userId: "user-1",
        orderId: "order-1",
        dedupeKey: "ORDER_STATUS_CHANGED:order-1:ACCEPTED:user-1",
      });
      // pair 锁 + Order 行锁 + deadline 内 accept（无 Product 写）
      expect(txExecuteRaw).toHaveBeenCalledTimes(2);
      expect(txProductUpdate).not.toHaveBeenCalled();
    });

    it("routes ERRAND completion through the canonical errand lifecycle delegation", async () => {
      completeErrandOrderTxMock.mockResolvedValue({ completed: true });
      const completeMock = completeErrandOrderTxMock;
      // 状态机：ERRAND COMPLETED 须 isBuyer（session user-1 = buyer）∧
      // Task PENDING_CONFIRMATION ∧ 恰 1 个 IN_PROGRESS active order
      orderFindUnique.mockResolvedValue(
        orderFixture({
          type: "ERRAND",
          status: "IN_PROGRESS",
          buyerId: "user-1",
          sellerId: "runner-1",
          productId: null,
          errandTaskId: "errand-1",
        }),
      );
      errandLockRowHolder.row = {
        id: "errand-1",
        campusId: "campus-1",
        status: "PENDING_CONFIRMATION",
        publisherId: "user-1",
        accepterId: "runner-1",
        deletedAt: null,
      };
      orderLockRowHolder.row = {
        id: "order-1",
        status: "IN_PROGRESS",
        buyerId: "user-1",
        sellerId: "runner-1",
      };

      await updateOrderStatus(statusFormData("COMPLETED"));

      expect(completeMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orderId: "order-1",
          errandTaskId: "errand-1",
          buyerId: "user-1",
          sellerId: "runner-1",
        }),
      );
      expect(revalidatePath).toHaveBeenCalledWith("/errands/errand-1");
    });

    it("silently skips side effects when errand completion reports not-completed", async () => {
      completeErrandOrderTxMock.mockResolvedValue({ completed: false });
      const completeMock = completeErrandOrderTxMock;
      orderFindUnique.mockResolvedValue(
        orderFixture({
          type: "ERRAND",
          status: "IN_PROGRESS",
          buyerId: "user-1",
          sellerId: "runner-1",
          productId: null,
          errandTaskId: "errand-1",
        }),
      );
      errandLockRowHolder.row = {
        id: "errand-1",
        campusId: "campus-1",
        status: "PENDING_CONFIRMATION",
        publisherId: "user-1",
        accepterId: "runner-1",
        deletedAt: null,
      };
      orderLockRowHolder.row = {
        id: "order-1",
        status: "IN_PROGRESS",
        buyerId: "user-1",
        sellerId: "runner-1",
      };

      await updateOrderStatus(statusFormData("COMPLETED"));

      expect(completeMock).toHaveBeenCalled();
      // completed=false → 无 revalidate、无后续乐观锁流转
      expect(txOrderUpdateMany).not.toHaveBeenCalled();
    });

    it("routes ERRAND start through the canonical errand lifecycle delegation", async () => {
      // 状态机：ERRAND IN_PROGRESS 须 isSeller（accepter）∧ Task CLAIMED ∧
      // 恰 1 个 ACCEPTED active order；Task + Order 同事务流转
      orderFindUnique.mockResolvedValue(
        orderFixture({
          type: "ERRAND",
          status: "ACCEPTED",
          buyerId: "buyer-1",
          sellerId: "user-1",
          productId: null,
          errandTaskId: "errand-1",
        }),
      );
      errandLockRowHolder.row = {
        id: "errand-1",
        campusId: "campus-1",
        status: "CLAIMED",
        publisherId: "buyer-1",
        accepterId: "user-1",
        deletedAt: null,
      };
      orderLockRowHolder.row = {
        id: "order-1",
        status: "ACCEPTED",
        buyerId: "buyer-1",
        sellerId: "user-1",
      };

      await updateOrderStatus(statusFormData("IN_PROGRESS"));

      expect(txErrandTaskUpdateMany).toHaveBeenCalledWith({
        where: { id: "errand-1", status: "CLAIMED" },
        data: { status: "IN_PROGRESS" },
      });
      expect(txOrderUpdateMany).toHaveBeenCalledWith({
        where: { id: "order-1", status: "ACCEPTED" },
        data: { status: "IN_PROGRESS" },
      });
      // canonical 通知（与详情页同集合，禁止入口路径依赖）
      // Phase 9B：canonical = publisher + accepter 各一条 ERRAND_TASK_STATUS_CHANGED
      expect(txNotificationCreateMany).toHaveBeenCalledTimes(2);
      expect(txNotificationCreateMany.mock.calls[0][0].data[0]).toMatchObject({
        userId: "buyer-1",
        orderId: "order-1",
        type: "ORDER",
        title: "跑腿任务状态更新：进行中",
        dedupeKey: "ERRAND_TASK_STATUS_CHANGED:order-1:IN_PROGRESS:buyer-1",
        kind: "ERRAND_TASK_STATUS_CHANGED",
      });
      expect(txNotificationCreateMany.mock.calls[1][0].data[0]).toMatchObject({
        userId: "user-1",
        orderId: "order-1",
        dedupeKey: "ERRAND_TASK_STATUS_CHANGED:order-1:IN_PROGRESS:user-1",
      });
      expect(revalidatePath).toHaveBeenCalledWith("/errands/errand-1");
    });

    it("marks the product as sold and bumps counters on completion", async () => {
      orderFindUnique.mockResolvedValue(
        orderFixture({ status: "ACCEPTED", buyerId: "user-1", sellerId: "seller-1" }),
      );

      await updateOrderStatus(statusFormData("COMPLETED"));

      expect(txProductUpdate).toHaveBeenCalledWith({
        where: { id: "product-1" },
        data: { status: "SOLD" },
        select: { campusId: true },
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
        select: { campusId: true },
      });
      expect(txProductUpdate).not.toHaveBeenCalled();
    });

    it("skips side effects when the optimistic-lock update wins nothing", async () => {
      orderFindUnique.mockResolvedValue(orderFixture({}));
      txOrderUpdateMany.mockResolvedValue({ count: 0 });

      await updateOrderStatus(statusFormData("ACCEPTED"));

      expect(txProductUpdate).not.toHaveBeenCalled();
      expect(txNotificationCreateMany).not.toHaveBeenCalled();
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
      // RB-03 REVIEW FIX：未知 order 仍在事务内 NO-OP（guard 先行），
      // 但不会产生任何 Order 写
      expect(transactionMock).toHaveBeenCalled();
      expect(txOrderUpdateMany).not.toHaveBeenCalled();

      const badFormData = new FormData();
      badFormData.set("orderId", "");
      await updateOrderStatus(badFormData);
      // PHASE 8B-01：ACCEPTED 委派新增锁键 pre-read（delegation candidate
      // 发现 + general fresh read），未知 order 共两次事务内点查、零 Order 写
      expect(orderFindUnique).toHaveBeenCalledTimes(2);
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
