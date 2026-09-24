import { beforeEach, describe, expect, it, vi } from "vitest";

const txStub = {
  $executeRaw: vi.fn().mockResolvedValue(0),
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  userVerification: {
    updateMany: vi.fn(),
  },
  uploadedAsset: {
    updateMany: vi.fn(),
  },
  product: {
    updateMany: vi.fn(),
  },
  errandTask: {
    updateMany: vi.fn(),
  },
  serviceListing: {
    updateMany: vi.fn(),
  },
  rentalListing: {
    updateMany: vi.fn(),
  },
  campusMembership: {
    updateMany: vi.fn(),
  },
  session: {
    deleteMany: vi.fn(),
  },
  order: {
    count: vi.fn(),
    updateMany: vi.fn(),
  },
  rentalOrder: {
    count: vi.fn(),
    updateMany: vi.fn(),
  },
  supportTicket: {
    count: vi.fn(),
    updateMany: vi.fn(),
  },
  notification: {
    deleteMany: vi.fn(),
  },
  message: {
    updateMany: vi.fn(),
  },
  review: {
    updateMany: vi.fn(),
  },
  rentalReview: {
    updateMany: vi.fn(),
  },
  report: {
    updateMany: vi.fn(),
  },
  appeal: {
    updateMany: vi.fn(),
  },
  rentalOrderStatusLog: {
    updateMany: vi.fn(),
  },
  rentalDispute: {
    updateMany: vi.fn(),
  },
  dataHold: {
    findMany: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub)),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  ERASED_SUPPORT_TICKET_TEXT_MARKER,
  ERASED_USER_DISPLAY_NAME,
  eraseAccount,
} from "@/lib/privacy/account-erasure";

const ACTIVE_USER = {
  id: "user-1",
  erasedAt: null,
  deletedAt: null,
  status: "ACTIVE",
};

beforeEach(() => {
  for (const [key, model] of Object.entries(txStub)) {
    if (key === "$executeRaw") {
      continue;
    }

    for (const fn of Object.values(model)) {
      fn.mockReset();
    }
  }

  // subject 治理锁（advisory xact lock）查询
  txStub.$executeRaw.mockReset().mockResolvedValue(0);
  txStub.user.findUnique.mockResolvedValue({ ...ACTIVE_USER });
  txStub.user.update.mockResolvedValue({});
  txStub.userVerification.updateMany.mockResolvedValue({ count: 1 });
  txStub.uploadedAsset.updateMany.mockResolvedValue({ count: 2 });
  txStub.product.updateMany.mockResolvedValue({ count: 1 });
  txStub.errandTask.updateMany.mockResolvedValue({ count: 0 });
  txStub.serviceListing.updateMany.mockResolvedValue({ count: 0 });
  txStub.rentalListing.updateMany.mockResolvedValue({ count: 0 });
  txStub.campusMembership.updateMany.mockResolvedValue({ count: 1 });
  txStub.session.deleteMany.mockResolvedValue({ count: 0 });
  txStub.order.count.mockResolvedValue(0);
  txStub.rentalOrder.count.mockResolvedValue(0);
  txStub.supportTicket.count.mockResolvedValue(0);
  txStub.supportTicket.updateMany.mockResolvedValue({ count: 0 });
  txStub.notification.deleteMany.mockResolvedValue({ count: 3 });
  txStub.message.updateMany.mockResolvedValue({ count: 2 });
  txStub.review.updateMany.mockResolvedValue({ count: 1 });
  txStub.rentalReview.updateMany.mockResolvedValue({ count: 1 });
  txStub.report.updateMany.mockResolvedValue({ count: 1 });
  txStub.appeal.updateMany.mockResolvedValue({ count: 1 });
  txStub.order.updateMany.mockResolvedValue({ count: 1 });
  txStub.rentalOrder.updateMany.mockResolvedValue({ count: 1 });
  txStub.rentalOrderStatusLog.updateMany.mockResolvedValue({ count: 1 });
  txStub.rentalDispute.updateMany.mockResolvedValue({ count: 1 });
  txStub.dataHold.findMany.mockResolvedValue([]);
});

describe("eraseAccount（ANONYMIZATION / FAIL_CLOSED / LISTINGS / RELATIONAL HISTORY）", () => {
  it("anonymizes PII with a non-reversible surrogate and invalidates credentials", async () => {
    await eraseAccount("user-1");

    expect(txStub.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({
        erasedAt: expect.any(Date),
        name: ERASED_USER_DISPLAY_NAME,
        // 匿名 email surrogate：随机 + .invalid，绝不从原始 PII 派生
        email: expect.stringMatching(/^erased-[0-9a-f-]+@erased\.invalid$/),
        passwordHash: expect.stringMatching(/^\$2[aby]\$/),
        avatarUrl: null,
        bio: null,
        phone: null,
        studentIdLast4: null,
        lastLoginAt: null,
      }),
    });

    // 认证材料清理 + 敏感资产进入 durable deletion queue（PENDING_DELETE，
    // 由既有 storage:cleanup 物理删除；头像已纳入，UPLOADING 保持 TTL 合同）
    expect(txStub.userVerification.updateMany).toHaveBeenCalled();
    // Phase 6A：成员关系闭环为 LEFT
    expect(txStub.campusMembership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", status: { not: "LEFT" } },
        data: { status: "LEFT" },
      }),
    );
    expect(txStub.uploadedAsset.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerId: "user-1",
          category: { in: ["AVATAR", "VERIFICATION", "HANDOVER", "RETURN", "REPORT"] },
          status: { in: ["UPLOADED", "ATTACHED"] },
        }),
        data: { status: "PENDING_DELETE" },
      }),
    );
    // originalFileName 是潜在 PII：本人全部资产（任意状态）清空
    expect(txStub.uploadedAsset.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: "user-1", originalFileName: { not: null } },
        data: { originalFileName: null },
      }),
    );
  });

  it("Repair 4：Notification 是 derived ephemeral inbox——注销时整表删除", async () => {
    await eraseAccount("user-1");

    expect(txStub.notification.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
  });

  it("Repair 4：Message 保留行（关系历史），free text → 哨兵标记 + senderId 置空", async () => {
    await eraseAccount("user-1");

    expect(txStub.message.updateMany).toHaveBeenCalledWith({
      where: { senderId: "user-1" },
      data: { content: ERASED_SUPPORT_TICKET_TEXT_MARKER, senderId: null },
    });
  });

  it("Repair 4：Review / RentalReview 保留结构（rating/order/target），文本与标签清空", async () => {
    await eraseAccount("user-1");

    expect(txStub.review.updateMany).toHaveBeenCalledWith({
      where: { authorId: "user-1" },
      data: { content: null, tags: [] },
    });
    expect(txStub.rentalReview.updateMany).toHaveBeenCalledWith({
      where: { authorId: "user-1" },
      data: { content: null, tags: [] },
    });
  });

  it("Repair 4：Report detail 清空；handledNote（operator/governance）不清", async () => {
    await eraseAccount("user-1");

    expect(txStub.report.updateMany).toHaveBeenCalledWith({
      where: { reporterId: "user-1" },
      data: { detail: null },
    });
  });

  it("Repair 4：本人 appellant 的 Appeal statement → 哨兵标记（enforcement target 归属）", async () => {
    await eraseAccount("user-1");

    expect(txStub.appeal.updateMany).toHaveBeenCalledWith({
      where: { enforcementAction: { targetId: "user-1" } },
      data: { statement: ERASED_SUPPORT_TICKET_TEXT_MARKER },
    });
  });

  it("Repair 4：Order 参与者任一方注销即清歧义 free text（note/cancelReason）", async () => {
    await eraseAccount("user-1");

    expect(txStub.order.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ buyerId: "user-1" }, { sellerId: "user-1" }] },
      data: { note: null, cancelReason: null },
    });
  });

  it("Repair 4：RentalOrder free text 按精确作者归属清理；cancellationReason 枚举保留", async () => {
    await eraseAccount("user-1");

    expect(txStub.rentalOrder.updateMany).toHaveBeenCalledWith({
      where: { renterId: "user-1", renterNote: { not: null } },
      data: { renterNote: null },
    });
    expect(txStub.rentalOrder.updateMany).toHaveBeenCalledWith({
      where: { cancelledById: "user-1", cancellationNote: { not: null } },
      data: { cancellationNote: null },
    });
  });

  it("Repair 4：本人 operator 的 status log note 清空；dispute reason/evidence 清理", async () => {
    await eraseAccount("user-1");

    expect(txStub.rentalOrderStatusLog.updateMany).toHaveBeenCalledWith({
      where: { operatorId: "user-1", note: { not: null } },
      data: { note: null },
    });
    expect(txStub.rentalDispute.updateMany).toHaveBeenCalledWith({
      where: { initiatorId: "user-1" },
      data: { reason: ERASED_SUPPORT_TICKET_TEXT_MARKER, evidencePhotos: [] },
    });
  });

  it("deactivates all tradeable listings at completion (ACCOUNT_DELETION_DEACTIVATES_LISTINGS)", async () => {
    const result = await eraseAccount("user-1");

    expect(txStub.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sellerId: "user-1" }),
        data: { status: "OFFLINE" },
      }),
    );
    expect(txStub.errandTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "CANCELLED" },
      }),
    );
    expect(txStub.serviceListing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "OFFLINE" } }),
    );
    expect(txStub.rentalListing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "OFFLINE" } }),
    );
    expect(result.deactivatedListings.products).toBe(1);
  });

  it("never physically deletes the user row (relational history preserved)", async () => {
    await eraseAccount("user-1");

    // 全程没有任何 delete/update 触及 user 行的删除——只允许 anonymize update
    expect(txStub.user.update).toHaveBeenCalledTimes(1);
    expect(txStub.user.update.mock.calls[0][0].data).not.toHaveProperty("deletedAt");
  });

  it("refuses a second erasure of the same account (ACCOUNT_ALREADY_DELETED)", async () => {
    txStub.user.findUnique.mockResolvedValue({ ...ACTIVE_USER, erasedAt: new Date() });

    await expect(eraseAccount("user-1")).rejects.toMatchObject({
      code: "ACCOUNT_ALREADY_DELETED",
    });
    expect(txStub.user.update).not.toHaveBeenCalled();
  });

  it("Phase 7G：active 支持工单阻断注销（ACTIVE_SUPPORT_TICKET，零写回滚）", async () => {
    txStub.supportTicket.count.mockResolvedValue(2);

    await expect(eraseAccount("user-1")).rejects.toMatchObject({
      code: "ACTIVE_SUPPORT_TICKET",
    });
    expect(txStub.user.update).not.toHaveBeenCalled();
  });

  it("Phase 7G：terminal 工单不阻断；注销清理 user free text（subject/description → 标记，message/note → null）", async () => {
    await eraseAccount("user-1");

    expect(txStub.supportTicket.count).toHaveBeenCalledWith({
      where: { requesterId: "user-1", status: { in: ["OPEN", "IN_PROGRESS"] } },
    });
    expect(txStub.supportTicket.updateMany).toHaveBeenCalledWith({
      where: { requesterId: "user-1" },
      data: {
        subject: ERASED_SUPPORT_TICKET_TEXT_MARKER,
        description: ERASED_SUPPORT_TICKET_TEXT_MARKER,
        resolutionMessage: null,
        internalNote: null,
      },
    });
  });

  it("blocks without any write while a hold is active (HOLD_BLOCKS_ERASURE)", async () => {
    txStub.dataHold.findMany.mockResolvedValue([
      { id: "hold-1", status: "ACTIVE" },
    ]);

    await expect(eraseAccount("user-1")).rejects.toMatchObject({
      code: "ACTIVE_DATA_HOLD",
    });

    // 前置检查全部只读：阻断路径零写操作（无部分擦除）
    expect(txStub.user.update).not.toHaveBeenCalled();
    expect(txStub.product.updateMany).not.toHaveBeenCalled();
  });

  it("blocks while an active order exists (ACTIVE_TRANSACTION_BLOCK)", async () => {
    txStub.order.count.mockResolvedValue(1);

    await expect(eraseAccount("user-1")).rejects.toMatchObject({
      code: "ACTIVE_TRANSACTION_BLOCK",
    });
    expect(txStub.user.update).not.toHaveBeenCalled();
  });

  it("blocks while an active rental order exists", async () => {
    txStub.rentalOrder.count.mockResolvedValue(2);

    await expect(eraseAccount("user-1")).rejects.toMatchObject({
      code: "ACTIVE_TRANSACTION_BLOCK",
    });
    expect(txStub.rentalListing.updateMany).not.toHaveBeenCalled();
  });
});
