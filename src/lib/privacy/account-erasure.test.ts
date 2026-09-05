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
  },
  rentalOrder: {
    count: vi.fn(),
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

import { ERASED_USER_DISPLAY_NAME, eraseAccount } from "@/lib/privacy/account-erasure";

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

    // 认证材料清理 + 敏感资产到期（由既有 storage:cleanup 物理删除）
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
          category: { in: ["VERIFICATION", "HANDOVER", "RETURN", "REPORT"] },
        }),
        data: { expiresAt: expect.any(Date) },
      }),
    );
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
