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
  txReportFindFirst,
  txCaseCreate,
} = vi.hoisted(() => {
  const txReviewCreate = vi.fn();
  const txReportCreate = vi.fn();
  const txReportFindFirst = vi.fn();
  const txCaseCreate = vi.fn();
  const transactionClient = {
    review: {
      create: txReviewCreate,
    },
    report: {
      create: txReportCreate,
      findFirst: txReportFindFirst,
    },
    moderationCase: {
      create: txCaseCreate,
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
    txReportFindFirst,
    txCaseCreate,
  };
});

vi.mock("@/lib/governance/active-account-mutation", () => ({
  prepareActiveAccountMutation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotification,
}));

const reportProjection = vi.hoisted(() => ({
  resolveReportTargetContext: vi.fn(),
  reconcileReportRiskProjection: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/enforcement/report-projection", () => ({
  resolveReportTargetContext: reportProjection.resolveReportTargetContext,
  reconcileReportRiskProjection: reportProjection.reconcileReportRiskProjection,
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
    txReportFindFirst.mockReset();
    txCaseCreate.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT", name: "测试同学" });
    reportFindFirst.mockResolvedValue(null);
    txReportFindFirst.mockResolvedValue(null);
    txCaseCreate.mockResolvedValue({ id: "case-1" });

    // Repair 2：createReport 走 resolveReportTargetContext 单源解析；
    // mock 与生产 resolver 同一归属语义，数据来自各 fixture find mocks
    reportProjection.resolveReportTargetContext.mockReset();
    reportProjection.resolveReportTargetContext.mockImplementation(
      async (
        _tx,
        {
          targetType,
        productId,
        errandTaskId,
        serviceListingId,
        targetUserId,
        messageId,
      }: {
        targetType: string;
        productId?: string | null;
        errandTaskId?: string | null;
        serviceListingId?: string | null;
        targetUserId?: string | null;
        messageId?: string | null;
      }) => {
        const missing = { ownerUserId: null, campusId: null, targetExists: false };
        switch (targetType) {
          case "PRODUCT": {
            if (!productId) return missing;
            const row = await productFindFirst({ where: { id: productId, deletedAt: null } });
            return {
              ownerUserId: row?.sellerId ?? null,
              campusId: row?.campusId ?? null,
              targetExists: Boolean(row),
            };
          }
          case "ERRAND_TASK": {
            if (!errandTaskId) return missing;
            const row = await errandTaskFindFirst({ where: { id: errandTaskId, deletedAt: null } });
            return {
              ownerUserId: row?.publisherId ?? null,
              campusId: row?.campusId ?? null,
              targetExists: Boolean(row),
            };
          }
          case "SERVICE_LISTING": {
            if (!serviceListingId) return missing;
            const row = await serviceListingFindFirst({
              where: { id: serviceListingId, deletedAt: null },
            });
            return {
              ownerUserId: row?.providerId ?? null,
              campusId: row?.campusId ?? null,
              targetExists: Boolean(row),
            };
          }
          case "USER": {
            if (!targetUserId) return missing;
            const row = await userFindFirst({ where: { id: targetUserId, deletedAt: null } });
            return {
              ownerUserId: row?.id ?? null,
              campusId: null,
              targetExists: Boolean(row),
            };
          }
          case "MESSAGE": {
            if (!messageId) return missing;
            const row = await messageFindUnique({ where: { id: messageId } });
            return {
              ownerUserId: row?.senderId ?? null,
              campusId: null,
              targetExists: Boolean(row),
            };
          }
          default:
            return missing;
        }
      },
    );
    reportProjection.reconcileReportRiskProjection.mockReset().mockResolvedValue(null);
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
    expect(txReportFindFirst).not.toHaveBeenCalled();
    expect(txReportCreate).not.toHaveBeenCalled();
  });

  it("rejects a duplicate open report for the same target", async () => {
    productFindFirst.mockResolvedValue({ id: "product-1", sellerId: "seller-1", campusId: "campus-1" });
    txReportFindFirst.mockResolvedValue({ id: "report-1" });

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
    expect(txReportFindFirst).toHaveBeenCalledWith({
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
    expect(txReportCreate).not.toHaveBeenCalled();
    expect(txCaseCreate).not.toHaveBeenCalled();
  });

  it("submits a product report with campus scope snapshot + case and notifies the reporter", async () => {
    productFindFirst.mockResolvedValue({ id: "product-1", sellerId: "seller-1", campusId: "campus-1" });
    txReportCreate.mockResolvedValue({ id: "report-abcdef12345678", createdAt: new Date("2026-09-16T00:00:00.000Z") });

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
    // Phase 7E：immutable scope 快照随创建写入
    expect(txReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reporterId: "user-1",
        targetType: "PRODUCT",
        reason: "FAKE_INFO",
        productId: "product-1",
        campusId: "campus-1",
        scopeKey: "CAMPUS:campus-1",
      }),
    });
    // Phase 7E：1:1 ModerationCase（openedAt = report.createdAt，SLA 起点）
    expect(txCaseCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reportId: "report-abcdef12345678",
          campusId: "campus-1",
          scopeKey: "CAMPUS:campus-1",
          openedAt: new Date("2026-09-16T00:00:00.000Z"),
          dueAt: new Date("2026-09-18T00:00:00.000Z"),
        }),
      }),
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1", type: "REPORT" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/reports");
  });

  it("submits a message report as UNSCOPED（campusId=null）", async () => {
    messageFindUnique.mockResolvedValue({ id: "message-1", senderId: "sender-1" });
    txReportCreate.mockResolvedValue({ id: "report-1", createdAt: new Date("2026-09-16T00:00:00.000Z") });

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
      data: expect.objectContaining({
        messageId: "message-1",
        campusId: null,
        scopeKey: "UNSCOPED",
      }),
    });
    expect(txCaseCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          campusId: null,
          scopeKey: "UNSCOPED",
        }),
      }),
    );
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
    errandTaskFindFirst.mockResolvedValue({ id: "errand-1", publisherId: "publisher-1", campusId: "campus-2" });
    txReportCreate.mockResolvedValue({ id: "report-1", createdAt: new Date("2026-09-16T00:00:00.000Z") });

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
      data: expect.objectContaining({
        errandTaskId: "errand-1",
        campusId: "campus-2",
        scopeKey: "CAMPUS:campus-2",
      }),
    });

    serviceListingFindFirst.mockResolvedValue({ id: "service-1", providerId: "provider-1", campusId: "campus-3" });
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
      data: expect.objectContaining({
        serviceListingId: "service-1",
        campusId: "campus-3",
        scopeKey: "CAMPUS:campus-3",
      }),
    });
  });

  it("submits a rental listing report with campus scope snapshot（7E rental repair）", async () => {
    txReportCreate.mockResolvedValue({ id: "report-rental-1", createdAt: new Date("2026-09-16T00:00:00.000Z") });

    // rentalListingId 未在 mock resolver 中单列：与生产同构，走 default 之外的
    // RENTAL_LISTING 分支——此处直接以 resolver mock 的 RENTAL_LISTING 语义覆盖
    reportProjection.resolveReportTargetContext.mockImplementation(
      async (_tx, ref: { targetType: string; rentalListingId?: string | null }) => {
        if (ref.targetType === "RENTAL_LISTING" && ref.rentalListingId === "rental-1") {
          return { ownerUserId: "owner-1", campusId: "campus-9", targetExists: true };
        }
        return { ownerUserId: null, campusId: null, targetExists: false };
      },
    );

    const formData = new FormData();
    formData.set("targetType", "RENTAL_LISTING");
    formData.set("reason", "SCAM_RISK");
    formData.set("detail", "租赁物品与描述不符");
    formData.set("productId", "");
    formData.set("errandTaskId", "");
    formData.set("serviceListingId", "");
    formData.set("rentalListingId", "rental-1");
    formData.set("targetUserId", "");
    formData.set("messageId", "");

    const result = await createReport({ success: false, message: "" }, formData);

    expect(result.success).toBe(true);
    expect(txReportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        targetType: "RENTAL_LISTING",
        rentalListingId: "rental-1",
        campusId: "campus-9",
        scopeKey: "CAMPUS:campus-9",
      }),
    });
    expect(txCaseCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ campusId: "campus-9", scopeKey: "CAMPUS:campus-9" }),
      }),
    );
    // 不能举报自己的租赁物品
    reportProjection.resolveReportTargetContext.mockImplementation(
      async () => ({ ownerUserId: "user-1", campusId: "campus-9", targetExists: true }),
    );
    const selfFormData = new FormData();
    selfFormData.set("targetType", "RENTAL_LISTING");
    selfFormData.set("reason", "SCAM_RISK");
    selfFormData.set("detail", "");
    selfFormData.set("productId", "");
    selfFormData.set("errandTaskId", "");
    selfFormData.set("serviceListingId", "");
    selfFormData.set("rentalListingId", "rental-1");
    selfFormData.set("targetUserId", "");
    selfFormData.set("messageId", "");

    const selfResult = await createReport({ success: false, message: "" }, selfFormData);
    expect(selfResult).toEqual({
      success: false,
      message: "不能举报自己发布或发送的内容",
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
