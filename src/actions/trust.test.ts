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
  assertActiveAccountMutationAllowed: vi.fn().mockResolvedValue(undefined),
}));

// 8A-03：block/unblock 走 sorted participant pair USER 治理锁
vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks: vi.fn().mockResolvedValue(undefined),
}));

// Phase 8E：createReview 收敛为 submitOrderReviewTx 薄适配——action 测试只
// 验证适配合同（身份来自 session、FormData 不再携带 targetUserId authority、
// 服务 { error } → 安全文案、revalidate 扇出），域裁决由服务单测/集成测试覆盖
const reviewService = vi.hoisted(() => ({
  submitOrderReviewTx: vi.fn(),
}));

vi.mock("@/lib/reviews/order-review-service", () => ({
  submitOrderReviewTx: reviewService.submitOrderReviewTx,
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
  assertReportTargetAccessibleToReporter: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/enforcement/report-projection", () => ({
  resolveReportTargetContext: reportProjection.resolveReportTargetContext,
  reconcileReportRiskProjection: reportProjection.reconcileReportRiskProjection,
  assertReportTargetAccessibleToReporter: reportProjection.assertReportTargetAccessibleToReporter,
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
    reviewService.submitOrderReviewTx.mockReset();

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
              messageConversationId: row?.conversationId ?? null,
            };
          }
          default:
            return missing;
        }
      },
    );
    reportProjection.reconcileReportRiskProjection.mockReset().mockResolvedValue(null);
    // Phase 8A-01：action 级授权断言默认放行（真实 participant 判定由
    // report-projection 单测 + 真实 PG 集成测试覆盖）
    reportProjection.assertReportTargetAccessibleToReporter.mockReset().mockResolvedValue(true);
  });

  it("ACT-01/02：身份来自 session，FormData 注入 targetUserId 完全无效（§13）", async () => {
    reviewService.submitOrderReviewTx.mockResolvedValue({
      success: true,
      targetUserId: "seller-1",
      published: false,
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("targetUserId", "forged-user");
    formData.set("authorId", "forged-author");
    formData.set("rating", "5");
    formData.set("content", "沟通顺畅");
    formData.set("tags", "守时,效率高");

    const result = await createReview({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: true,
      message: "评价已提交",
      redirectTo: "/my/orders",
    });
    // 只透传 orderId/rating/content/tags——forged targetUserId/authorId 不进入服务
    expect(reviewService.submitOrderReviewTx).toHaveBeenCalledTimes(1);
    const [, serviceInput] = reviewService.submitOrderReviewTx.mock.calls[0]!;
    expect(serviceInput).toEqual({
      orderId: "order-1",
      userId: "user-1",
      rating: 5,
      content: "沟通顺畅",
      tags: ["守时", "效率高"],
    });
    expect(revalidatePath).toHaveBeenCalledWith("/my/orders");
    expect(revalidatePath).toHaveBeenCalledWith("/my/reviews");
    expect(revalidatePath).toHaveBeenCalledWith("/profile");
    expect(revalidatePath).toHaveBeenCalledWith("/notifications");
    // /users/[target] 由服务端推导的 targetUserId 决定（非客户端输入）
    expect(revalidatePath).toHaveBeenCalledWith("/users/seller-1");
  });

  it("ACT-04：非法 rating → schema 拒绝，服务零调用", async () => {
    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("rating", "6");

    const result = await createReview({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "评分必须在 1 到 5 之间",
    });
    expect(reviewService.submitOrderReviewTx).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("ACT-05：duplicate → 服务稳定 { error } 直接映射安全文案", async () => {
    reviewService.submitOrderReviewTx.mockResolvedValue({ error: "你已经评价过该订单" });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("rating", "5");
    formData.set("content", "体验很好");
    formData.set("tags", "守时,效率高");

    const result = await createReview({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "你已经评价过该订单",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("ACT-29：tags 超过 6 个 → schema 拒绝（防逗号异常列表）", async () => {
    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("rating", "5");
    formData.set("content", "正常内容");
    formData.set("tags", "a,b,c,d,e,f,g");

    const result = await createReview({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toContain("标签最多 6 个");
    expect(reviewService.submitOrderReviewTx).not.toHaveBeenCalled();
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
    messageFindUnique.mockResolvedValue({ id: "message-1", senderId: "sender-1", conversationId: "conv-1" });
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

  it("8A-01：MESSAGE 授权 helper 收到 resolver 解析的 conversationId（服务端权威）", async () => {
    messageFindUnique.mockResolvedValue({ id: "message-1", senderId: "sender-1", conversationId: "conv-1" });
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

    await createReport({ success: false, message: "" }, formData);

    expect(reportProjection.assertReportTargetAccessibleToReporter).toHaveBeenCalledWith(
      expect.anything(),
      {
        reporterId: "user-1",
        targetType: "MESSAGE",
        targetContext: expect.objectContaining({ messageConversationId: "conv-1" }),
      },
    );
  });

  it("8A-01：MESSAGE non-participant → 与'目标不存在'同类 fail-closed，零写入", async () => {
    messageFindUnique.mockResolvedValue({ id: "message-1", senderId: "sender-1", conversationId: "conv-1" });
    reportProjection.assertReportTargetAccessibleToReporter.mockResolvedValue(false);

    const formData = new FormData();
    formData.set("targetType", "MESSAGE");
    formData.set("reason", "HARASSMENT");
    formData.set("detail", "越权举报他人私信");
    formData.set("productId", "");
    formData.set("errandTaskId", "");
    formData.set("serviceListingId", "");
    formData.set("targetUserId", "");
    formData.set("messageId", "message-1");

    const result = await createReport({ success: false, message: "" }, formData);

    expect(result).toEqual({ success: false, message: "举报目标不存在" });
    // ZERO DURABLE SIDE EFFECT：授权拒绝发生在任何写入之前
    expect(txReportFindFirst).not.toHaveBeenCalled();
    expect(txReportCreate).not.toHaveBeenCalled();
    expect(txCaseCreate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("8A-01：participant 举报自己的 MESSAGE → 既有 self-report 保护保持", async () => {
    messageFindUnique.mockResolvedValue({ id: "message-1", senderId: "user-1", conversationId: "conv-1" });

    const formData = new FormData();
    formData.set("targetType", "MESSAGE");
    formData.set("reason", "HARASSMENT");
    formData.set("detail", "自举报");
    formData.set("productId", "");
    formData.set("errandTaskId", "");
    formData.set("serviceListingId", "");
    formData.set("targetUserId", "");
    formData.set("messageId", "message-1");

    const result = await createReport({ success: false, message: "" }, formData);

    expect(result).toEqual({ success: false, message: "不能举报自己发布或发送的内容" });
    expect(txReportCreate).not.toHaveBeenCalled();
    expect(txCaseCreate).not.toHaveBeenCalled();
  });

  it("blocks another user with an optional reason", async () => {
    transactionMock.mockImplementation((async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        blockedUser: { upsert: blockedUserUpsert, deleteMany: blockedUserDeleteMany },
        // 保持后续 report 测试依赖的泄漏链兼容（tx.report / tx.moderationCase）
        report: { findFirst: txReportFindFirst, create: txReportCreate },
        moderationCase: { create: txCaseCreate },
      } as never)) as never);
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
    transactionMock.mockImplementation((async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        blockedUser: { upsert: blockedUserUpsert, deleteMany: blockedUserDeleteMany },
        // 保持后续 report 测试依赖的泄漏链兼容（tx.report / tx.moderationCase）
        report: { findFirst: txReportFindFirst, create: txReportCreate },
        moderationCase: { create: txCaseCreate },
      } as never)) as never);
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

  it("ACT-07：unknown infra error → safe mapping（不泄漏 raw Prisma error）", async () => {
    reviewService.submitOrderReviewTx.mockRejectedValue(new Error("db down"));

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("rating", "5");
    formData.set("content", "很好");

    const result = await createReview({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it("BLOCK-02：SUSPENDED actor → DENY，零 block 行（RB-03 guard）", async () => {
    const { RbacError } = await import("@/lib/rbac/errors");
    const { assertActiveAccountMutationAllowed } = await import(
      "@/lib/governance/active-account-mutation"
    );
    (assertActiveAccountMutationAllowed as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RbacError("AUTH_ACCOUNT_INACTIVE", "账号当前不可用"),
    );

    const formData = new FormData();
    formData.set("targetUserId", "user-2");

    const result = await blockUser({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(blockedUserUpsert).not.toHaveBeenCalled();
  });

  it("UNBLOCK-02：SUSPENDED actor → DENY，行保留（RB-03 guard）", async () => {
    const { RbacError } = await import("@/lib/rbac/errors");
    const { assertActiveAccountMutationAllowed } = await import(
      "@/lib/governance/active-account-mutation"
    );
    (assertActiveAccountMutationAllowed as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RbacError("AUTH_ACCOUNT_INACTIVE", "账号当前不可用"),
    );

    const formData = new FormData();
    formData.set("targetUserId", "user-2");

    const result = await unblockUser({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(blockedUserDeleteMany).not.toHaveBeenCalled();
  });
});
