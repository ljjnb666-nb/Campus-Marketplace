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
  createNotification,
  transactionMock,
  txReviewCreate,
} = vi.hoisted(() => {
  const txReviewCreate = vi.fn();
  const transactionClient = {
    review: {
      create: txReviewCreate,
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
    createNotification: vi.fn(),
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txReviewCreate,
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
    $transaction: transactionMock,
  },
}));

import { createReport, createReview } from "@/actions/trust";

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
    createNotification.mockReset();
    transactionMock.mockClear();
    txReviewCreate.mockReset();

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
});
