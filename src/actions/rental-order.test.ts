import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const {
  revalidatePath,
  requireUser,
  createNotifications,
  checkTimeConflict,
  transactionMock,
  txRentalListingFindFirst,
  txRentalUnavailableFindFirst,
  txQueryRaw,
  txExecuteRaw,
  txUserFindMany,
  txRentalOrderCreate,
  txRentalOrderFindFirst,
  txRentalOrderUpdate,
  txRentalOrderStatusLogCreate,
  txRentalHandoverUpsert,
  txRentalReturnUpsert,
  txRentalDamageClaimFindFirst,
  txRentalDamageClaimUpdate,
  txRentalReviewFindFirst,
  txRentalReviewCreate,
  txRentalReviewCount,
  txUserUpdate,
  txExtensionRequestFindFirst,
  txExtensionRequestCreate,
  txExtensionRequestUpdate,
  txDamageClaimCreate,
  txDisputeCreate,
} = vi.hoisted(() => {
  const txExecuteRaw = vi.fn();
  const txUserFindMany = vi.fn();
  const txRentalListingFindFirst = vi.fn();
  const txRentalUnavailableFindFirst = vi.fn();
  const txQueryRaw = vi.fn();
  const txRentalOrderCreate = vi.fn();
  const txRentalOrderFindFirst = vi.fn();
  const txRentalOrderUpdate = vi.fn();
  const txRentalOrderStatusLogCreate = vi.fn();
  const txRentalHandoverUpsert = vi.fn();
  const txRentalReturnUpsert = vi.fn();
  const txRentalDamageClaimFindFirst = vi.fn();
  const txRentalDamageClaimUpdate = vi.fn();
  const txRentalReviewFindFirst = vi.fn();
  const txRentalReviewCreate = vi.fn();
  const txRentalReviewCount = vi.fn();
  const txUserUpdate = vi.fn();
  const txExtensionRequestFindFirst = vi.fn();
  const txExtensionRequestCreate = vi.fn();
  const txExtensionRequestUpdate = vi.fn();
  const txDamageClaimCreate = vi.fn();
  const txDisputeCreate = vi.fn();

  const transactionClient = {
    $queryRaw: txQueryRaw,
    $executeRaw: txExecuteRaw,
    user: { findMany: txUserFindMany, update: txUserUpdate },
    rentalListing: { findFirst: txRentalListingFindFirst },
    rentalUnavailablePeriod: { findFirst: txRentalUnavailableFindFirst },
    rentalOrder: {
      create: txRentalOrderCreate,
      findFirst: txRentalOrderFindFirst,
      update: txRentalOrderUpdate,
    },
    rentalOrderStatusLog: { create: txRentalOrderStatusLogCreate },
    rentalHandoverRecord: { upsert: txRentalHandoverUpsert },
    rentalReturnRecord: { upsert: txRentalReturnUpsert },
    rentalDamageClaim: {
      findFirst: txRentalDamageClaimFindFirst,
      update: txRentalDamageClaimUpdate,
      create: txDamageClaimCreate,
    },
    rentalExtensionRequest: {
      findFirst: txExtensionRequestFindFirst,
      create: txExtensionRequestCreate,
      update: txExtensionRequestUpdate,
    },
    rentalDispute: { create: txDisputeCreate },
    rentalReview: {
      findFirst: txRentalReviewFindFirst,
      create: txRentalReviewCreate,
      count: txRentalReviewCount,
    },
  };

  return {
    revalidatePath: vi.fn(),
    requireUser: vi.fn(),
    createNotifications: vi.fn(),
    checkTimeConflict: vi.fn(),
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txRentalListingFindFirst,
    txRentalUnavailableFindFirst,
    txQueryRaw,
    txExecuteRaw,
    txUserFindMany,
    txRentalOrderCreate,
    txRentalOrderFindFirst,
    txRentalOrderUpdate,
    txRentalOrderStatusLogCreate,
    txRentalHandoverUpsert,
    txRentalReturnUpsert,
    txRentalDamageClaimFindFirst,
    txRentalDamageClaimUpdate,
    txRentalReviewFindFirst,
    txRentalReviewCreate,
    txRentalReviewCount,
    txUserUpdate,
    txExtensionRequestFindFirst,
    txExtensionRequestCreate,
    txExtensionRequestUpdate,
    txDamageClaimCreate,
    txDisputeCreate,
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

vi.mock("@/repositories/rental-order-repository", () => ({
  checkTimeConflict,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: transactionMock,
    rentalHandoverRecord: { findUnique: prismaHandoverFindUnique },
    rentalReturnRecord: { findUnique: prismaReturnFindUnique },
  },
  withTransaction: transactionMock,
}));

import {
  approveExtension,
  approveRentalOrder,
  cancelRentalOrder,
  confirmPickup,
  confirmReturn,
  createRentalOrder,
  initiateDispute,
  rejectExtension,
  rejectRentalOrder,
  requestExtension,
  requestReturn,
  respondDamageClaim,
  submitDamageClaim,
  submitRentalReview,
} from "@/actions/rental-order";

const {
  uploadImageAsset,
  attachAssetsToEntity,
  markAssetsForValuesPendingDelete,
  prismaHandoverFindUnique,
  prismaReturnFindUnique,
} = vi.hoisted(() => ({
  uploadImageAsset: vi.fn(),
  attachAssetsToEntity: vi.fn(),
  markAssetsForValuesPendingDelete: vi.fn(),
  prismaHandoverFindUnique: vi.fn(),
  prismaReturnFindUnique: vi.fn(),
}));

vi.mock("@/lib/upload", () => ({
  uploadImageAsset,
  attachAssetsToEntity,
  markAssetsForValuesPendingDelete,
  buildAssetReference: (assetId: string) => `asset:${assetId}`,
  parseAssetReference: (value: string) =>
    value.startsWith("asset:") ? value.slice("asset:".length) : null,
  asAssetTx: (client: unknown) => client,
  isImageValidationError: () => false,
  AssetServiceError: class AssetServiceError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  UPLOAD_LIMITS: {
    handover: { maxSize: 10 * 1024 * 1024, maxCount: 5, allowedTypes: ["image/jpeg", "image/png", "image/webp"] },
    return: { maxSize: 10 * 1024 * 1024, maxCount: 5, allowedTypes: ["image/jpeg", "image/png", "image/webp"] },
    report: { maxSize: 10 * 1024 * 1024, maxCount: 5, allowedTypes: ["image/jpeg", "image/png", "image/webp"] },
  },
}));

function buildCreateFormData(overrides: Record<string, string> = {}) {
  const formData = new FormData();
  formData.set("rentalListingId", overrides.rentalListingId ?? "listing-1");
  formData.set("startTime", overrides.startTime ?? "2026-08-01T10:00:00.000Z");
  formData.set("endTime", overrides.endTime ?? "2026-08-03T10:00:00.000Z");
  formData.set("quantity", overrides.quantity ?? "1");
  if (overrides.renterNote !== undefined) formData.set("renterNote", overrides.renterNote);
  return formData;
}

function buildPickupFormData(overrides: Record<string, string> = {}) {
  const formData = new FormData();
  formData.set("orderId", overrides.orderId ?? "order-1");
  formData.set("role", overrides.role ?? "owner");
  if (overrides.currentCondition !== undefined) {
    formData.set("currentCondition", overrides.currentCondition);
  }
  return formData;
}

function buildClaimFormData(overrides: Record<string, string> = {}) {
  const formData = new FormData();
  formData.set("claimId", overrides.claimId ?? "claim-1");
  formData.set("agreed", overrides.agreed ?? "false");
  if (overrides.renterNote !== undefined) formData.set("renterNote", overrides.renterNote);
  return formData;
}

const pendingPickupOrder = {
  id: "order-1",
  status: "PENDING_PICKUP",
  ownerId: "user-owner",
  renterId: "user-renter",
  handoverRecord: null,
};

const pendingInspectionClaim = {
  id: "claim-1",
  orderId: "order-1",
  requestedDeduction: new Prisma.Decimal("30"),
  order: {
    id: "order-1",
    status: "PENDING_INSPECTION",
    ownerId: "user-owner",
    renterId: "user-renter",
    depositAmount: new Prisma.Decimal("50"),
    depositStatus: "PAID",
  },
};

function buildSimpleFormData(pairs: string[]) {
  const formData = new FormData();
  for (let i = 0; i < pairs.length; i += 2) {
    formData.set(pairs[i], pairs[i + 1]);
  }
  return formData;
}

describe("rental-order actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireUser.mockReset();
    createNotifications.mockReset();
    checkTimeConflict.mockReset();
    transactionMock.mockClear();
    txRentalListingFindFirst.mockReset();
    txQueryRaw.mockReset();
    txRentalUnavailableFindFirst.mockReset();
    txRentalOrderCreate.mockReset();
    txRentalOrderFindFirst.mockReset();
    txRentalOrderUpdate.mockReset();
    txRentalOrderStatusLogCreate.mockReset();
    txRentalHandoverUpsert.mockReset();
    txRentalReturnUpsert.mockReset();
    txRentalDamageClaimFindFirst.mockReset();
    txRentalDamageClaimUpdate.mockReset();
    txRentalReviewFindFirst.mockReset();
    txRentalReviewCreate.mockReset();
    txRentalReviewCount.mockReset();
    txUserUpdate.mockReset();
    txExtensionRequestFindFirst.mockReset();
    txExtensionRequestCreate.mockReset();
    txExtensionRequestUpdate.mockReset();
    txDamageClaimCreate.mockReset();
    txDisputeCreate.mockReset();
    uploadImageAsset.mockReset();
    uploadImageAsset.mockResolvedValue({
      assetId: "asset-1",
      access: "PRIVATE",
      url: null,
      mimeType: "image/webp",
      sizeBytes: 1024,
    });
    attachAssetsToEntity.mockReset().mockResolvedValue(1);
    markAssetsForValuesPendingDelete.mockReset().mockResolvedValue(0);
    prismaHandoverFindUnique.mockReset().mockResolvedValue(null);
    prismaReturnFindUnique.mockReset().mockResolvedValue(null);

    requireUser.mockResolvedValue({ id: "user-renter" });
    createNotifications.mockResolvedValue(undefined);
    checkTimeConflict.mockResolvedValue({ available: true });
    txRentalOrderUpdate.mockResolvedValue({});
    txRentalOrderStatusLogCreate.mockResolvedValue({});
    txUserUpdate.mockResolvedValue({});
    txRentalDamageClaimUpdate.mockResolvedValue({});
    txExtensionRequestCreate.mockResolvedValue({});
    txExtensionRequestUpdate.mockResolvedValue({});
    txDamageClaimCreate.mockResolvedValue({});
    txDisputeCreate.mockResolvedValue({});

    // participant governance guard 默认全绿（锁查询 + 全员 ACTIVE）
    txExecuteRaw.mockReset().mockResolvedValue(0);
    txUserFindMany.mockReset().mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id: string) => ({ id, status: "ACTIVE", deletedAt: null, erasedAt: null })),
    );
  });

  it("rejects create when the time strings cannot be parsed", async () => {
    const result = await createRentalOrder(
      { success: false, message: "" },
      buildCreateFormData({ startTime: "not-a-date", endTime: "also-bad" }),
    );

    expect(result).toEqual({ success: false, message: "时间格式不正确" });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("rejects create when the form payload is invalid", async () => {
    const formData = new FormData();
    formData.set("rentalListingId", "");
    formData.set("startTime", "2026-08-01T10:00:00.000Z");
    formData.set("endTime", "2026-08-03T10:00:00.000Z");

    const result = await createRentalOrder({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("rejects create when end time is not after start time", async () => {
    const result = await createRentalOrder(
      { success: false, message: "" },
      buildCreateFormData({
        startTime: "2026-08-03T10:00:00.000Z",
        endTime: "2026-08-01T10:00:00.000Z",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("开始时间");
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("rejects renting your own listing", async () => {
    txQueryRaw.mockResolvedValue([{
      id: "listing-1",
      ownerId: "user-renter",
      totalQuantity: 1,
      pricingUnit: "PER_DAY",
      minimumDuration: 1,
      maximumDuration: 30,
      price: "20",
      depositAmount: "50",
      requiresApproval: true,
      pickupLocation: "南门",
      returnLocation: "南门",
      title: "相机",
      status: "AVAILABLE",
      deletedAt: null,
    }]);

    const result = await createRentalOrder(
      { success: false, message: "" },
      buildCreateFormData(),
    );

    expect(result).toEqual({
      success: false,
      message: "不能租用自己的物品",
    });
  });

  it("accepts an explicitly empty renter note from the form helper", async () => {
    txQueryRaw.mockResolvedValue([{
      id: "listing-1",
      ownerId: "user-renter",
      totalQuantity: 1,
      pricingUnit: "PER_DAY",
      minimumDuration: 1,
      maximumDuration: 30,
      price: "20",
      depositAmount: "50",
      requiresApproval: true,
      pickupLocation: "南门",
      returnLocation: "南门",
      title: "相机",
      status: "AVAILABLE",
      deletedAt: null,
    }]);

    const result = await createRentalOrder(
      { success: false, message: "" },
      buildCreateFormData({ renterNote: "" }),
    );

    // 空备注应通过 zod 校验并进入业务逻辑，而不是被参数错误拦截
    expect(result).toEqual({
      success: false,
      message: "不能租用自己的物品",
    });
  });

  it("creates a pending-approval order for approval listings", async () => {
    txQueryRaw.mockResolvedValue([{
      id: "listing-1",
      ownerId: "user-owner",
      totalQuantity: 2,
      pricingUnit: "PER_DAY",
      minimumDuration: 1,
      maximumDuration: 30,
      price: "20",
      depositAmount: "50",
      requiresApproval: true,
      pickupLocation: "南门",
      returnLocation: "南门",
      title: "相机",
      status: "AVAILABLE",
      deletedAt: null,
    }]);
    txRentalUnavailableFindFirst.mockResolvedValue(null);
    txRentalOrderCreate.mockResolvedValue({ id: "order-1" });
    txRentalOrderStatusLogCreate.mockResolvedValue({});

    const result = await createRentalOrder(
      { success: false, message: "" },
      buildCreateFormData(),
    );

    expect(result.success).toBe(true);
    expect(result.redirectTo).toBe("/rental-orders/order-1");
    expect(txRentalOrderCreate).toHaveBeenCalled();
    expect(createNotifications).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/my/rental-orders");
  });

  it("blocks cancel when caller is not allowed for current status", async () => {
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "IN_RENTAL",
      ownerId: "user-owner",
      renterId: "user-renter",
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("cancellationReason", "OTHER");

    const result = await cancelRentalOrder(formData);

    expect(result).toEqual({
      success: false,
      message: "当前状态不允许取消",
    });
    expect(txRentalOrderUpdate).not.toHaveBeenCalled();
  });

  it("allows renter to cancel while pending approval", async () => {
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_APPROVAL",
      ownerId: "user-owner",
      renterId: "user-renter",
    });
    txRentalOrderUpdate.mockResolvedValue({});
    txRentalOrderStatusLogCreate.mockResolvedValue({});

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("cancellationReason", "RENTER_CHANGED_PLAN");
    formData.set("cancellationNote", "行程变了");

    const result = await cancelRentalOrder(formData);

    expect(result.success).toBe(true);
    expect(txRentalOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-1" },
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/rental-orders/order-1");
  });

  it("rejects cancel with an unknown cancellation reason", async () => {
    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("cancellationReason", "NOT_A_REASON");

    const result = await cancelRentalOrder(formData);

    expect(result.success).toBe(false);
    expect(result.message).toBe("取消原因不正确");
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("rejects approve with a missing orderId", async () => {
    const result = await approveRentalOrder(new FormData());

    expect(result.success).toBe(false);
    expect(result.message).toBe("订单不存在");
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns an error state and logs when the approve transaction fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_APPROVAL",
      ownerId: "user-owner",
      renterId: "user-renter",
    });
    txRentalOrderUpdate.mockRejectedValueOnce(new Error("db down"));

    const formData = new FormData();
    formData.set("orderId", "order-1");

    const result = await approveRentalOrder(formData);

    expect(result.success).toBe(false);
    expect(result.message).toBe("操作失败，请稍后重试");
    expect(consoleError).toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("approves a pending order for the owner", async () => {
    requireUser.mockResolvedValue({ id: "user-owner" });
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_APPROVAL",
      ownerId: "user-owner",
      renterId: "user-renter",
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");

    const result = await approveRentalOrder(formData);

    expect(result.success).toBe(true);
    expect(txRentalOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-1" },
        data: expect.objectContaining({ status: "PENDING_PICKUP" }),
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/rental-orders/order-1");
  });

  it("rejects confirmPickup when the role is not owner or renter", async () => {
    const result = await confirmPickup(buildPickupFormData({ role: "admin" }));

    expect(result).toEqual({ success: false, message: "无权操作" });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(txRentalHandoverUpsert).not.toHaveBeenCalled();
  });

  it("rejects confirmPickup when the caller is not the order owner", async () => {
    requireUser.mockResolvedValue({ id: "user-stranger" });
    txRentalOrderFindFirst.mockResolvedValue(pendingPickupOrder);

    const result = await confirmPickup(buildPickupFormData({ role: "owner" }));

    expect(result).toEqual({ success: false, message: "无权操作" });
    expect(txRentalHandoverUpsert).not.toHaveBeenCalled();
  });

  it("lets the owner confirm pickup and upserts the handover record", async () => {
    requireUser.mockResolvedValue({ id: "user-owner" });
    txRentalOrderFindFirst.mockResolvedValue({
      ...pendingPickupOrder,
      handoverRecord: { ownerConfirmed: false, renterConfirmed: true },
    });
    txRentalHandoverUpsert.mockResolvedValue({ ownerConfirmed: true, renterConfirmed: true });

    const result = await confirmPickup(buildPickupFormData({ role: "owner" }));

    expect(result.success).toBe(true);
    expect(txRentalHandoverUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: "order-1" },
        update: expect.objectContaining({ ownerConfirmed: true }),
      }),
    );
  });

  it("rejects confirmReturn when the caller is not the order renter", async () => {
    requireUser.mockResolvedValue({ id: "user-stranger" });
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_RETURN",
      ownerId: "user-owner",
      renterId: "user-renter",
      returnRecord: null,
      depositAmount: new Prisma.Decimal("50"),
      depositStatus: "PAID",
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("role", "renter");

    const result = await confirmReturn(formData);

    expect(result).toEqual({ success: false, message: "无权操作" });
    expect(txRentalReturnUpsert).not.toHaveBeenCalled();
  });

  it("rejects a damage claim response when the caller is not the renter", async () => {
    requireUser.mockResolvedValue({ id: "user-owner" });
    txRentalDamageClaimFindFirst.mockResolvedValue(pendingInspectionClaim);

    const result = await respondDamageClaim(buildClaimFormData());

    expect(result).toEqual({ success: false, message: "无效请求" });
    expect(txRentalOrderUpdate).not.toHaveBeenCalled();
  });

  it("moves the order to COMPLETED when the renter rejects the damage claim", async () => {
    txRentalDamageClaimFindFirst.mockResolvedValue(pendingInspectionClaim);

    const result = await respondDamageClaim(buildClaimFormData({ agreed: "false" }));

    // 拒绝索赔的出口：PENDING_INSPECTION -> COMPLETED（押金不扣除、进入退回流程），
    // 出租者若不认可仍可在 COMPLETED 状态发起纠纷。
    expect(result.success).toBe(true);
    expect(txRentalOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-1" },
        data: expect.objectContaining({
          status: "COMPLETED",
          depositStatus: "PENDING_REFUND",
        }),
      }),
    );
    expect(txRentalOrderStatusLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromStatus: "PENDING_INSPECTION",
          toStatus: "COMPLETED",
        }),
      }),
    );
    expect(createNotifications).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ title: "索赔被拒绝" })],
    );
    expect(txUserUpdate).toHaveBeenCalledTimes(2);
  });

  it("completes the order with deduction when the renter agrees to the damage claim", async () => {
    txRentalDamageClaimFindFirst.mockResolvedValue(pendingInspectionClaim);

    const result = await respondDamageClaim(buildClaimFormData({ agreed: "true" }));

    expect(result.success).toBe(true);
    expect(txRentalOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-1" },
        data: expect.objectContaining({
          status: "COMPLETED",
          depositStatus: "PARTIALLY_REFUNDED",
          depositDeduction: new Prisma.Decimal("30"),
        }),
      }),
    );
  });

  it("recomputes rentalPositiveRate as a ratio when a review is submitted", async () => {
    requireUser.mockResolvedValue({ id: "user-renter" });
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "COMPLETED",
      ownerId: "user-owner",
      renterId: "user-renter",
    });
    txRentalReviewFindFirst.mockResolvedValue(null);
    txRentalReviewCreate.mockResolvedValue({});
    // 2 条评价中 1 条好评（overallRating >= 4） => 比率 0.5
    txRentalReviewCount.mockImplementation(
      ({ where }: { where?: { overallRating?: unknown } }) =>
        Promise.resolve(where?.overallRating ? 1 : 2),
    );

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("overallRating", "3");
    formData.set("content", "物品还行");

    const result = await submitRentalReview(formData);

    expect(result.success).toBe(true);
    expect(txRentalReviewCreate).toHaveBeenCalled();
    // rentalPositiveRate 是 0..1 的比率（好评数/总评价数），而不是计数器自增
    expect(txUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-owner" },
        data: { rentalPositiveRate: 0.5 },
      }),
    );
    expect(JSON.stringify(txUserUpdate.mock.calls)).not.toContain("increment");
  });

  it("blocks a duplicate review", async () => {
    requireUser.mockResolvedValue({ id: "user-renter" });
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "COMPLETED",
      ownerId: "user-owner",
      renterId: "user-renter",
    });
    txRentalReviewFindFirst.mockResolvedValue({ id: "review-1" });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("overallRating", "5");

    const result = await submitRentalReview(formData);

    expect(result).toEqual({ success: false, message: "已经评价过" });
    expect(txRentalReviewCreate).not.toHaveBeenCalled();
    expect(txUserUpdate).not.toHaveBeenCalled();
  });

  it("rejects a pending approval order as the owner with a reason", async () => {
    requireUser.mockResolvedValue({ id: "user-owner" });
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_APPROVAL",
      ownerId: "user-owner",
      renterId: "user-renter",
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("rejectReason", "物品已损坏");

    const result = await rejectRentalOrder(formData);

    expect(result).toEqual({ success: true, message: "已拒绝租赁申请" });
    expect(txRentalOrderUpdate).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: expect.objectContaining({
        status: "REJECTED",
        cancellationNote: "物品已损坏",
      }),
    });
    expect(createNotifications).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/rental-orders/order-1");
  });

  it("rejects order rejection when the order is not pending approval", async () => {
    requireUser.mockResolvedValue({ id: "user-owner" });
    txRentalOrderFindFirst.mockResolvedValue(null);

    const formData = new FormData();
    formData.set("orderId", "order-1");

    const result = await rejectRentalOrder(formData);

    expect(result).toEqual({ success: false, message: "订单不存在或状态不允许" });
    expect(txRentalOrderUpdate).not.toHaveBeenCalled();
  });

  it("lets the renter request a return from an in-rental order", async () => {
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "IN_RENTAL",
      ownerId: "user-owner",
      renterId: "user-renter",
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");

    const result = await requestReturn(formData);

    expect(result).toEqual({ success: true, message: "已提交归还请求" });
    expect(txRentalOrderUpdate).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "PENDING_RETURN" },
    });
    expect(createNotifications).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ userId: "user-owner" })]),
    );
  });

  it("rejects return requests from users outside the order", async () => {
    txRentalOrderFindFirst.mockResolvedValue(null);

    const formData = new FormData();
    formData.set("orderId", "order-1");

    const result = await requestReturn(formData);

    expect(result).toEqual({ success: false, message: "订单状态错误" });
  });

  it("submits an extension request for an in-rental order", async () => {
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "IN_RENTAL",
      ownerId: "user-owner",
      renterId: "user-renter",
      rentalListingId: "listing-1",
      quantity: 1,
      endTime: new Date("2026-08-10T10:00:00.000Z"),
      unitPriceSnapshot: new Prisma.Decimal("20"),
      pricingUnitSnapshot: "PER_DAY",
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("newEndTime", "2026-08-12T10:00:00.000Z");

    const result = await requestExtension(formData);

    expect(result).toEqual({ success: true, message: "已发送续租请求" });
    expect(txExtensionRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order-1",
        requesterId: "user-renter",
        status: "PENDING",
      }),
    });
    expect(checkTimeConflict).toHaveBeenCalled();
  });

  it("rejects an extension that does not extend the end time", async () => {
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "IN_RENTAL",
      endTime: new Date("2026-08-12T10:00:00.000Z"),
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("newEndTime", "2026-08-11T10:00:00.000Z");

    const result = await requestExtension(formData);

    expect(result).toEqual({ success: false, message: "新结束时间必须晚于当前结束时间" });
    expect(txExtensionRequestCreate).not.toHaveBeenCalled();
  });

  it("rejects extension requests when the slot is unavailable", async () => {
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "IN_RENTAL",
      endTime: new Date("2026-08-10T10:00:00.000Z"),
    });
    checkTimeConflict.mockResolvedValue({ available: false });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("newEndTime", "2026-08-12T10:00:00.000Z");

    const result = await requestExtension(formData);

    expect(result).toEqual({ success: false, message: "续租时间段库存不足" });
  });

  it("approves a pending extension as the owner and extends the order", async () => {
    requireUser.mockResolvedValue({ id: "user-owner" });
    txExtensionRequestFindFirst.mockResolvedValue({
      id: "ext-1",
      orderId: "order-1",
      newEndTime: new Date("2026-08-12T10:00:00.000Z"),
      additionalFee: new Prisma.Decimal("40"),
      order: {
        id: "order-1",
        status: "IN_RENTAL",
        ownerId: "user-owner",
        renterId: "user-renter",
        rentalListingId: "listing-1",
        quantity: 1,
        endTime: new Date("2026-08-10T10:00:00.000Z"),
      },
    });

    const formData = new FormData();
    formData.set("extensionRequestId", "ext-1");

    const result = await approveExtension(formData);

    expect(result).toEqual({ success: true, message: "已同意续租请求" });
    expect(txExtensionRequestUpdate).toHaveBeenCalledWith({
      where: { id: "ext-1" },
      data: { status: "APPROVED" },
    });
    expect(txRentalOrderUpdate).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: {
        endTime: new Date("2026-08-12T10:00:00.000Z"),
        finalAmount: { increment: new Prisma.Decimal("40") },
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/rental-orders");
  });

  it("rejects approving an extension from someone other than the owner", async () => {
    requireUser.mockResolvedValue({ id: "user-owner" });
    txExtensionRequestFindFirst.mockResolvedValue(null);

    const formData = new FormData();
    formData.set("extensionRequestId", "ext-1");

    const result = await approveExtension(formData);

    expect(result).toEqual({ success: false, message: "无效请求" });
    expect(txExtensionRequestUpdate).not.toHaveBeenCalled();
  });

  it("rejects a pending extension as the owner", async () => {
    requireUser.mockResolvedValue({ id: "user-owner" });
    txExtensionRequestFindFirst.mockResolvedValue({
      id: "ext-1",
      orderId: "order-1",
      order: {
        id: "order-1",
        ownerId: "user-owner",
        renterId: "user-renter",
      },
    });

    const formData = new FormData();
    formData.set("extensionRequestId", "ext-1");

    const result = await rejectExtension(formData);

    expect(result).toEqual({ success: true, message: "已拒绝续租请求" });
    expect(txExtensionRequestUpdate).toHaveBeenCalledWith({
      where: { id: "ext-1" },
      data: { status: "REJECTED" },
    });
    expect(createNotifications).toHaveBeenCalled();
  });

  it("submits a damage claim for a pending-inspection order", async () => {
    requireUser.mockResolvedValue({ id: "user-owner" });
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_INSPECTION",
      ownerId: "user-owner",
      renterId: "user-renter",
      depositAmount: new Prisma.Decimal("200"),
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("damageDescription", "屏幕出现裂痕需要维修");
    formData.set("requestedDeduction", "80");

    const result = await submitDamageClaim(formData);

    expect(result).toEqual({ success: true, message: "已提交索赔" });
    expect(txDamageClaimCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order-1",
        submittedById: "user-owner",
        requestedDeduction: new Prisma.Decimal("80"),
      }),
    });
    expect(createNotifications).toHaveBeenCalled();
  });

  it("rejects damage claims larger than the deposit", async () => {
    requireUser.mockResolvedValue({ id: "user-owner" });
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_INSPECTION",
      ownerId: "user-owner",
      renterId: "user-renter",
      depositAmount: new Prisma.Decimal("50"),
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("damageDescription", "屏幕出现裂痕需要维修");
    formData.set("requestedDeduction", "80");

    const result = await submitDamageClaim(formData);

    expect(result).toEqual({ success: false, message: "索赔金额不能大于押金" });
    expect(txDamageClaimCreate).not.toHaveBeenCalled();
  });

  it("initiates a dispute on a completed order and flips its status", async () => {
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "COMPLETED",
      ownerId: "user-owner",
      renterId: "user-renter",
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("reason", "归还物品与约定不符");

    const result = await initiateDispute(formData);

    expect(result).toEqual({ success: true, message: "已发起纠纷" });
    expect(txDisputeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order-1",
        initiatorId: "user-renter",
        status: "OPEN",
      }),
    });
    expect(txRentalOrderUpdate).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "IN_DISPUTE" },
    });
  });

  it("rejects disputes in non-disputable states", async () => {
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_APPROVAL",
      ownerId: "user-owner",
      renterId: "user-renter",
    });

    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("reason", "归还物品与约定不符");

    const result = await initiateDispute(formData);

    expect(result).toEqual({ success: false, message: "状态不允许纠纷" });
    expect(txDisputeCreate).not.toHaveBeenCalled();
  });

  it("uploads handover photos and stores them on the record", async () => {
    requireUser.mockResolvedValue({ id: "user-owner" });
    txRentalOrderFindFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_PICKUP",
      ownerId: "user-owner",
      renterId: "user-renter",
      handoverRecord: null,
    });
    txRentalHandoverUpsert.mockResolvedValue({
      ownerConfirmed: true,
      renterConfirmed: false,
    });

    const formData = buildPickupFormData();
    formData.append("photos", new File(["x"], "photo.png", { type: "image/png" }));

    const result = await confirmPickup(formData);

    expect(result).toEqual({ success: true, message: "已确认取货" });
    expect(uploadImageAsset).toHaveBeenCalledWith({
      userId: "user-owner",
      category: "handover",
      file: expect.any(File),
    });
    // 私有照片以 asset: 引用落库，事务成功后绑定订单
    expect(txRentalHandoverUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          photos: ["asset:asset-1"],
          ownerConfirmed: true,
        }),
      }),
    );
    expect(attachAssetsToEntity).toHaveBeenCalledWith(
      expect.anything(),
      { ownerId: "user-owner", assetIds: ["asset-1"], target: { type: "rentalOrder", id: "order-1" } },
    );
  });

  it("rejects a friendly retry message when the transaction throws", async () => {    transactionMock.mockRejectedValue(new Error("db down"));

    const approveResult = await rejectRentalOrder(
      buildSimpleFormData(["orderId", "order-1"]),
    );
    expect(approveResult.success).toBe(false);
    expect(approveResult.message).toContain("稍后重试");

    const returnResult = await requestReturn(buildSimpleFormData(["orderId", "order-1"]));
    expect(returnResult.success).toBe(false);

    const cancelResult = await cancelRentalOrder(
      buildSimpleFormData(["orderId", "order-1", "cancellationReason", "OTHER"]),
    );
    expect(cancelResult.success).toBe(false);
    expect(cancelResult.message).toContain("取消订单失败");

    const extensionResult = await requestExtension(
      buildSimpleFormData(["orderId", "order-1", "newEndTime", "2026-08-30T10:00"]),
    );
    expect(extensionResult.success).toBe(false);
    expect(extensionResult.message).toContain("续租请求");

    const approveExtResult = await approveExtension(
      buildSimpleFormData(["extensionRequestId", "ext-1"]),
    );
    expect(approveExtResult.success).toBe(false);

    const rejectExtResult = await rejectExtension(
      buildSimpleFormData(["extensionRequestId", "ext-1"]),
    );
    expect(rejectExtResult.success).toBe(false);

    const claimResult = await submitDamageClaim(
      buildSimpleFormData([
        "orderId",
        "order-1",
        "damageDescription",
        "屏幕出现裂痕",
        "requestedDeduction",
        "10",
      ]),
    );
    expect(claimResult.success).toBe(false);
    expect(claimResult.message).toContain("索赔");

    const respondResult = await respondDamageClaim(
      buildSimpleFormData(["claimId", "claim-1", "agreed", "true"]),
    );
    expect(respondResult.success).toBe(false);

    const disputeResult = await initiateDispute(
      buildSimpleFormData(["orderId", "order-1", "reason", "归还物品与约定不符"]),
    );
    expect(disputeResult.success).toBe(false);
    expect(disputeResult.message).toContain("纠纷");

    const reviewResult = await submitRentalReview(
      buildSimpleFormData(["orderId", "order-1", "overallRating", "5"]),
    );
    expect(reviewResult.success).toBe(false);
    expect(reviewResult.message).toContain("评价");
  });
});
