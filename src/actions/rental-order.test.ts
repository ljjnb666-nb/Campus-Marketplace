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
} = vi.hoisted(() => {
  const txRentalListingFindFirst = vi.fn();
  const txRentalUnavailableFindFirst = vi.fn();
  const txRentalOrderCreate = vi.fn();
  const txRentalOrderFindFirst = vi.fn();
  const txRentalOrderUpdate = vi.fn();
  const txRentalOrderStatusLogCreate = vi.fn();

  const transactionClient = {
    rentalListing: { findFirst: txRentalListingFindFirst },
    rentalUnavailablePeriod: { findFirst: txRentalUnavailableFindFirst },
    rentalOrder: {
      create: txRentalOrderCreate,
      findFirst: txRentalOrderFindFirst,
      update: txRentalOrderUpdate,
    },
    rentalOrderStatusLog: { create: txRentalOrderStatusLogCreate },
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
  cancelRentalOrder,
  createRentalOrder,
} from "@/actions/rental-order";

function buildCreateFormData(overrides: Record<string, string> = {}) {
  const formData = new FormData();
  formData.set("rentalListingId", overrides.rentalListingId ?? "listing-1");
  formData.set("startTime", overrides.startTime ?? "2026-08-01T10:00:00.000Z");
  formData.set("endTime", overrides.endTime ?? "2026-08-03T10:00:00.000Z");
  formData.set("quantity", overrides.quantity ?? "1");
  if (overrides.renterNote) formData.set("renterNote", overrides.renterNote);
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
    txRentalUnavailableFindFirst.mockReset();
    txRentalOrderCreate.mockReset();
    txRentalOrderFindFirst.mockReset();
    txRentalOrderUpdate.mockReset();
    txRentalOrderStatusLogCreate.mockReset();

    requireUser.mockResolvedValue({ id: "user-renter" });
    createNotifications.mockResolvedValue(undefined);
    checkTimeConflict.mockResolvedValue({ available: true });
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
});
