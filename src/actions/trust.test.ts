import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireUser,
  orderFindUnique,
  productFindFirst,
  errandTaskFindFirst,
  serviceListingFindFirst,
  userFindFirst,
  messageFindUnique,
  reportFindFirst,
  reviewAggregate,
  userUpdate,
  blockedUserUpsert,
  blockedUserDeleteMany,
  createNotification,
  transactionMock,
  txReviewCreate,
  txReportCreate,
} = vi.hoisted(() => {
  const txReviewCreate = vi.fn();
  const txReportCreate = vi.fn();
  const transactionClient = {
    review: {
      create: txReviewCreate,
    },
    report: {
      create: txReportCreate,
    },
  };

  return {
    revalidatePath: vi.fn(),
    requireUser: vi.fn(),
    orderFindUnique: vi.fn(),
    productFindFirst: vi.fn(),
    errandTaskFindFirst: vi.fn(),
    serviceListingFindFirst: vi.fn(),
    userFindFirst: vi.fn(),
    messageFindUnique: vi.fn(),
    reportFindFirst: vi.fn(),
    reviewAggregate: vi.fn(),
    userUpdate: vi.fn(),
    blockedUserUpsert: vi.fn(),
    blockedUserDeleteMany: vi.fn(),
    createNotification: vi.fn(),
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txReviewCreate,
    txReportCreate,
  };
});

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotification,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: {
      findUnique: orderFindUnique,
    },
    product: {
      findFirst: productFindFirst,
    },
    errandTask: {
      findFirst: errandTaskFindFirst,
    },
    serviceListing: {
      findFirst: serviceListingFindFirst,
    },
    user: {
      findFirst: userFindFirst,
      update: userUpdate,
    },
    message: {
      findUnique: messageFindUnique,
    },
    report: {
      findFirst: reportFindFirst,
    },
    review: {
      aggregate: reviewAggregate,
    },
    blockedUser: {
      upsert: blockedUserUpsert,
      deleteMany: blockedUserDeleteMany,
    },
    $transaction: transactionMock,
  },
  withTransaction: transactionMock,
}));

import { blockUser, createReport, createReview, unblockUser } from "@/actions/trust";

describe("trust actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireUser.mockReset();
    orderFindUnique.mockReset();
    productFindFirst.mockReset();
    errandTaskFindFirst.mockReset();
    serviceListingFindFirst.mockReset();
    userFindFirst.mockReset();
    messageFindUnique.mockReset();
    reportFindFirst.mockReset();
    reviewAggregate.mockReset();
    userUpdate.mockReset();
    blockedUserUpsert.mockReset();
    blockedUserDeleteMany.mockReset();
    createNotification.mockReset();
    transactionMock.mockClear();
    txReviewCreate.mockReset();
    txReportCreate.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT", name: "测试同学" });
    reportFindFirst.mockResolvedValue(null);
  });

  it("rejects a review when the target user does not match the completed order", async () => {
    orderFindUnique.mockResolvedValue({
      id: "order-1",
      status: "COMPLETED",
      buyerId: "user-1",
      sellerId: "seller-1",
      reviews: [],
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("targetUserId", "wrong-user");
    formData.set("rating", "5");
    formData.set("content", "沟通顺畅");
    formData.set("tags", "守时,效率高");

    const result = await createReview({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "评价对象不正确",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("rejects a duplicate review from the same author for one order", async () => {
    orderFindUnique.mockResolvedValue({
      id: "order-1",
      status: "COMPLETED",
      buyerId: "user-1",
      sellerId: "seller-1",
      reviews: [{ id: "review-1" }],
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("targetUserId", "seller-1");
    formData.set("rating", "5");
    formData.set("content", "体验很好");
    formData.set("tags", "守时,效率高");

    const result = await createReview({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "你已经评价过该订单",
    });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(reviewAggregate).not.toHaveBeenCalled();
  });

  it("creates a review, sends a notification, and refreshes the target rating", async () => {
    orderFindUnique.mockResolvedValue({
      id: "order-1",
      status: "COMPLETED",
      buyerId: "user-1",
      sellerId: "seller-1",
      reviews: [],
    });
    reviewAggregate.mockResolvedValue({
      _avg: { rating: 4 },
      _count: { rating: 2 },
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("targetUserId", "seller-1");
    formData.set("rating", "5");
    formData.set("content", "沟通顺畅，按时完成");
    formData.set("tags", "守时,效率高");

    const result = await createReview({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: true,
      message: "评价已提交",
      redirectTo: "/my/orders",
    });
    expect(txReviewCreate).toHaveBeenCalledWith({
      data: {
        orderId: "order-1",
        authorId: "user-1",
        targetUserId: "seller-1",
        rating: 5,
        content: "沟通顺畅，按时完成",
        tags: ["守时", "效率高"],
      },
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        userId: "seller-1",
        orderId: "order-1",
        type: "REVIEW",
        title: "收到新的订单评价",
      }),
    );
    expect(reviewAggregate).toHaveBeenCalledWith({
      where: { targetUserId: "seller-1" },
      _avg: { rating: true },
      _count: { rating: true },
    });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "seller-1" },
      data: {
        positiveReviewRate: 0.8,
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/my/orders");
    expect(revalidatePath).toHaveBeenCalledWith("/my/reviews");
    expect(revalidatePath).toHaveBeenCalledWith("/profile");
    expect(revalidatePath).toHaveBeenCalledWith("/notifications");
  });

  it("rejects a report when the target resource does not exist", async () => {
    productFindFirst.mockResolvedValue(null);

    const formData = new FormData();
    formData.set("targetType", "PRODUCT");
    formData.set("reason", "FAKE_INFO");
    formData.set("detail", "商品描述与实际不符");
    formData.set("productId", "missing-product");
    formData.set("errandTaskId", "");
    formData.set("serviceListingId", "");
    formData.set("targetUserId", "");
    formData.set("messageId", "");

    const result = await createReport({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "举报目标不存在",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a report for the user's own profile", async () => {
    userFindFirst.mockResolvedValue({ id: "user-1" });

    const formData = new FormData();
    formData.set("targetType", "USER");
    formData.set("reason", "HARASSMENT");
    formData.set("detail", "测试");
    formData.set("productId", "");
    formData.set("errandTaskId", "");
    formData.set("serviceListingId", "");
    formData.set("targetUserId", "user-1");
    formData.set("messageId", "");

    const result = await createReport({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "不能举报自己发布或发送的内容",
    });
    expect(reportFindFirst).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("rejects a duplicate open report for the same target", async () => {
    productFindFirst.mockResolvedValue({ id: "product-1", sellerId: "seller-1" });
    reportFindFirst.mockResolvedValue({ id: "report-1" });

    const formData = new FormData();
    formData.set("targetType", "PRODUCT");
    formData.set("reason", "FAKE_INFO");
    formData.set("detail", "重复提交");
    formData.set("productId", "product-1");
    formData.set("errandTaskId", "");
    formData.set("serviceListingId", "");
    formData.set("targetUserId", "");
    formData.set("messageId", "");

    const result = await createReport({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "该目标已有待处理举报，请勿重复提交",
    });
    expect(reportFindFirst).toHaveBeenCalledWith({
      where: {
        reporterId: "user-1",
        targetType: "PRODUCT",
        status: {
          in: ["OPEN", "IN_REVIEW"],
        },
        productId: "product-1",
      },
      select: {
        id: true,
      },
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("submits a product report and notifies the reporter", async () => {
    productFindFirst.mockResolvedValue({ id: "product-1", sellerId: "seller-1" });
    txReportCreate.mockResolvedValue({ id: "report-abcdef12345678" });

    const formData = new FormData();
    formData.set("targetType", "PRODUCT");
    formData.set("reason", "FAKE_INFO");
    formData.set("detail", "商品描述与实际不符");
    formData.set("productId", "product-1");
    formData.set("errandTaskId", "");
    formData.set("serviceListingId", "");
    formData.set("targetUserId", "");
    formData.set("messageId", "");

    const result = await createReport({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: true,
      message: "举报已提交，客服人员会尽快审核处理",
    });
    expect(txReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reporterId: "user-1",
        targetType: "PRODUCT",
        reason: "FAKE_INFO",
        productId: "product-1",
      }),
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1", type: "REPORT" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/reports");
  });

  it("submits a message report against another sender", async () => {
    messageFindUnique.mockResolvedValue({ id: "message-1", senderId: "sender-1" });
    txReportCreate.mockResolvedValue({ id: "report-1" });

    const formData = new FormData();
    formData.set("targetType", "MESSAGE");
    formData.set("reason", "HARASSMENT");
    formData.set("detail", "骚扰消息");
    formData.set("productId", "");
    formData.set("errandTaskId", "");
    formData.set("serviceListingId", "");
    formData.set("targetUserId", "");
    formData.set("messageId", "message-1");

    const result = await createReport({ success: false, message: "" }, formData);

    expect(result.success).toBe(true);
    expect(txReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ messageId: "message-1" }),
    });
  });

  it("blocks another user with an optional reason", async () => {
    blockedUserUpsert.mockResolvedValue({ id: "block-1" });

    const formData = new FormData();
    formData.set("targetUserId", "user-2");
    formData.set("reason", "恶意骚扰");

    const result = await blockUser({ success: false, message: "" }, formData);

    expect(result).toEqual({ success: true, message: "已成功拉黑该用户" });
    expect(blockedUserUpsert).toHaveBeenCalledWith({
      where: {
        blockerId_blockedUserId: { blockerId: "user-1", blockedUserId: "user-2" },
      },
      create: expect.objectContaining({ reason: "恶意骚扰" }),
      update: { reason: "恶意骚扰" },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
  });

  it("refuses to block yourself or a missing target", async () => {
    let formData = new FormData();
    formData.set("targetUserId", "user-1");
    let result = await blockUser({ success: false, message: "" }, formData);
    expect(result).toEqual({ success: false, message: "无效的拉黑目标" });

    formData = new FormData();
    result = await blockUser({ success: false, message: "" }, formData);
    expect(result).toEqual({ success: false, message: "无效的拉黑目标" });
    expect(blockedUserUpsert).not.toHaveBeenCalled();
  });

  it("unblocks a previously blocked user", async () => {
    blockedUserDeleteMany.mockResolvedValue({ count: 1 });

    const formData = new FormData();
    formData.set("targetUserId", "user-2");

    const result = await unblockUser({ success: false, message: "" }, formData);

    expect(result).toEqual({ success: true, message: "已解除拉黑" });
    expect(blockedUserDeleteMany).toHaveBeenCalledWith({
      where: { blockerId: "user-1", blockedUserId: "user-2" },
    });
  });

  it("requires a target when unblocking", async () => {
    const result = await unblockUser({ success: false, message: "" }, new FormData());

    expect(result).toEqual({ success: false, message: "参数缺失" });
    expect(blockedUserDeleteMany).not.toHaveBeenCalled();
  });

  it("submits reports against errand tasks and service listings", async () => {
    errandTaskFindFirst.mockResolvedValue({ id: "errand-1", publisherId: "publisher-1" });
    txReportCreate.mockResolvedValue({ id: "report-1" });

    let formData = new FormData();
    formData.set("targetType", "ERRAND_TASK");
    formData.set("reason", "FAKE_INFO");
    formData.set("detail", "任务描述不实");
    formData.set("productId", "");
    formData.set("errandTaskId", "errand-1");
    formData.set("serviceListingId", "");
    formData.set("targetUserId", "");
    formData.set("messageId", "");

    let result = await createReport({ success: false, message: "" }, formData);
    expect(result.success).toBe(true);
    expect(txReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ errandTaskId: "errand-1" }),
    });

    serviceListingFindFirst.mockResolvedValue({ id: "service-1", providerId: "provider-1" });
    formData = new FormData();
    formData.set("targetType", "SERVICE_LISTING");
    formData.set("reason", "HARASSMENT");
    formData.set("detail", "服务内容不当");
    formData.set("productId", "");
    formData.set("errandTaskId", "");
    formData.set("serviceListingId", "service-1");
    formData.set("targetUserId", "");
    formData.set("messageId", "");

    result = await createReport({ success: false, message: "" }, formData);
    expect(result.success).toBe(true);
    expect(txReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ serviceListingId: "service-1" }),
    });
  });

  it("returns a friendly message when report submission fails", async () => {
    productFindFirst.mockResolvedValue({ id: "product-1", sellerId: "seller-1" });
    transactionMock.mockRejectedValue(new Error("db down"));

    const formData = new FormData();
    formData.set("targetType", "PRODUCT");
    formData.set("reason", "FAKE_INFO");
    formData.set("detail", "描述不实");
    formData.set("productId", "product-1");
    formData.set("errandTaskId", "");
    formData.set("serviceListingId", "");
    formData.set("targetUserId", "");
    formData.set("messageId", "");

    const result = await createReport({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it("returns a friendly message when blocking fails", async () => {
    blockedUserUpsert.mockRejectedValue(new Error("db down"));

    const formData = new FormData();
    formData.set("targetUserId", "user-2");

    const result = await blockUser({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it("returns a friendly message when the review transaction fails", async () => {
    orderFindUnique.mockResolvedValue({
      id: "order-1",
      status: "COMPLETED",
      buyerId: "user-1",
      sellerId: "seller-1",
      reviews: [],
    });
    transactionMock.mockRejectedValue(new Error("db down"));

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("rating", "5");
    formData.set("content", "很好");
    formData.set("targetUserId", "seller-1");

    const result = await createReview({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });
});
