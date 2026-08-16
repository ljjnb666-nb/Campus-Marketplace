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
} = vi.hoisted(() => {
  const txRentalListingFindFirst = vi.fn();
  const txRentalUnavailableFindFirst = vi.fn();
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

  const transactionClient = {
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
    },
    rentalReview: {
      findFirst: txRentalReviewFindFirst,
      create: txRentalReviewCreate,
      count: txRentalReviewCount,
    },
    user: { update: txUserUpdate },
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
  },
}));

import {
  approveRentalOrder,
  cancelRentalOrder,
  confirmPickup,
  confirmReturn,
  createRentalOrder,
  respondDamageClaim,
  submitRentalReview,
} from "@/actions/rental-order";

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

describe("rental-order actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireUser.mockReset();
    createNotifications.mockReset();
    checkTimeConflict.mockReset();
    transactionMock.mockClear();
    txRentalListingFindFirst.mockReset();
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

    requireUser.mockResolvedValue({ id: "user-renter" });
    createNotifications.mockResolvedValue(undefined);
    checkTimeConflict.mockResolvedValue({ available: true });
    txRentalOrderUpdate.mockResolvedValue({});
    txRentalOrderStatusLogCreate.mockResolvedValue({});
    txUserUpdate.mockResolvedValue({});
    txRentalDamageClaimUpdate.mockResolvedValue({});
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
    txRentalListingFindFirst.mockResolvedValue({
      id: "listing-1",
      ownerId: "user-renter",
      totalQuantity: 1,
      pricingUnit: "PER_DAY",
      minimumDuration: 1,
      maximumDuration: 30,
      price: new Prisma.Decimal("20"),
      depositAmount: new Prisma.Decimal("50"),
      requiresApproval: true,
      pickupLocation: "南门",
      returnLocation: "南门",
      title: "相机",
    });

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
    txRentalListingFindFirst.mockResolvedValue({
      id: "listing-1",
      ownerId: "user-renter",
      totalQuantity: 1,
      pricingUnit: "PER_DAY",
      minimumDuration: 1,
      maximumDuration: 30,
      price: new Prisma.Decimal("20"),
      depositAmount: new Prisma.Decimal("50"),
      requiresApproval: true,
      pickupLocation: "南门",
      returnLocation: "南门",
      title: "相机",
    });

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
    txRentalListingFindFirst.mockResolvedValue({
      id: "listing-1",
      ownerId: "user-owner",
      totalQuantity: 2,
      pricingUnit: "PER_DAY",
      minimumDuration: 1,
      maximumDuration: 30,
      price: new Prisma.Decimal("20"),
      depositAmount: new Prisma.Decimal("50"),
      requiresApproval: true,
      pickupLocation: "南门",
      returnLocation: "南门",
      title: "相机",
    });
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
});
