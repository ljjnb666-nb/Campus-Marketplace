import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { createNotifications, checkTimeConflict } = vi.hoisted(() => ({
  createNotifications: vi.fn(),
  checkTimeConflict: vi.fn(),
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotifications,
}));

vi.mock("@/repositories/rental-order-repository", () => ({
  checkTimeConflict,
}));

import {
  approveRentalOrderTx,
  canCancelRentalOrder,
  counterpartyId,
  depositStatusAfterCompletion,
  incrementRentalCompletionCounters,
  isDisputableStatus,
  isRentalOrderRoleParticipant,
  recomputeRentalPositiveRate,
  respondDamageClaimTx,
  writeStatusLog,
} from "@/lib/rental-order-machine";

function buildTx() {
  return {
    rentalOrder: { findFirst: vi.fn(), update: vi.fn() },
    rentalOrderStatusLog: { create: vi.fn() },
    rentalDamageClaim: { findFirst: vi.fn(), update: vi.fn() },
    rentalReview: { count: vi.fn() },
    user: { update: vi.fn() },
  };
}

// 测试里用纯 mock 对象充当事务客户端，调用领域函数时再断言为 TransactionClient
function asTx(tx: ReturnType<typeof buildTx>): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

describe("rental-order-machine", () => {
  beforeEach(() => {
    createNotifications.mockReset();
    checkTimeConflict.mockReset();
    createNotifications.mockResolvedValue(undefined);
  });

  it("writes the status log with from/to/operator/note", async () => {
    const tx = buildTx();
    await writeStatusLog(asTx(tx), {
      orderId: "order-1",
      fromStatus: "PENDING_APPROVAL",
      toStatus: "PENDING_PICKUP",
      operatorId: "user-owner",
      note: "出租者同意租赁",
    });

    expect(tx.rentalOrderStatusLog.create).toHaveBeenCalledWith({
      data: {
        orderId: "order-1",
        fromStatus: "PENDING_APPROVAL",
        toStatus: "PENDING_PICKUP",
        operatorId: "user-owner",
        note: "出租者同意租赁",
      },
    });
  });

  it("accepts the matching party for a role", () => {
    const order = { ownerId: "user-owner", renterId: "user-renter" };
    expect(isRentalOrderRoleParticipant(order, "owner", "user-owner")).toBe(true);
    expect(isRentalOrderRoleParticipant(order, "renter", "user-renter")).toBe(true);
  });

  it("rejects mismatched roles and strangers", () => {
    const order = { ownerId: "user-owner", renterId: "user-renter" };
    expect(isRentalOrderRoleParticipant(order, "owner", "user-renter")).toBe(false);
    expect(isRentalOrderRoleParticipant(order, "renter", "user-owner")).toBe(false);
    expect(isRentalOrderRoleParticipant(order, "owner", "user-stranger")).toBe(false);
  });

  it("allows renter cancel while pending approval and either party while pending pickup", () => {
    const order = { ownerId: "user-owner", renterId: "user-renter" };
    expect(canCancelRentalOrder({ ...order, status: "PENDING_APPROVAL" }, "user-renter")).toBe(true);
    expect(canCancelRentalOrder({ ...order, status: "PENDING_APPROVAL" }, "user-owner")).toBe(false);
    expect(canCancelRentalOrder({ ...order, status: "PENDING_PICKUP" }, "user-owner")).toBe(true);
    expect(canCancelRentalOrder({ ...order, status: "PENDING_PICKUP" }, "user-renter")).toBe(true);
    expect(canCancelRentalOrder({ ...order, status: "IN_RENTAL" }, "user-renter")).toBe(false);
  });

  it("resolves the counterparty for owner and renter", () => {
    const order = { ownerId: "user-owner", renterId: "user-renter" };
    expect(counterpartyId(order, "user-owner")).toBe("user-renter");
    expect(counterpartyId(order, "user-renter")).toBe("user-owner");
  });

  it("moves paid deposits to PENDING_REFUND on completion and keeps zero deposits as-is", () => {
    expect(
      depositStatusAfterCompletion({ depositAmount: new Prisma.Decimal("50"), depositStatus: "PAID" }),
    ).toBe("PENDING_REFUND");
    expect(
      depositStatusAfterCompletion({ depositAmount: new Prisma.Decimal("0"), depositStatus: "NOT_REQUIRED" }),
    ).toBe("NOT_REQUIRED");
  });

  it("only allows disputes in rent-active or later statuses", () => {
    expect(isDisputableStatus("IN_RENTAL")).toBe(true);
    expect(isDisputableStatus("PENDING_INSPECTION")).toBe(true);
    expect(isDisputableStatus("COMPLETED")).toBe(true);
    expect(isDisputableStatus("PENDING_APPROVAL")).toBe(false);
    expect(isDisputableStatus("CANCELLED")).toBe(false);
  });

  it("increments rental completion counters for both parties", async () => {
    const tx = buildTx();
    await incrementRentalCompletionCounters(asTx(tx), { ownerId: "user-owner", renterId: "user-renter" });

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-owner" },
      data: { rentalOwnerCount: { increment: 1 } },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-renter" },
      data: { rentalRenterCount: { increment: 1 } },
    });
  });

  it("recomputes the positive rate as a 0..1 ratio", async () => {
    const tx = buildTx();
    // 4 条评价中 1 条好评（overallRating >= 4） => 比率 0.25
    tx.rentalReview.count.mockImplementation(({ where }: { where?: { overallRating?: unknown } }) =>
      Promise.resolve(where?.overallRating ? 1 : 4),
    );

    await recomputeRentalPositiveRate(asTx(tx), "user-owner");

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-owner" },
      data: { rentalPositiveRate: 0.25 },
    });
  });

  it("falls back to 0 when the target has no reviews", async () => {
    const tx = buildTx();
    tx.rentalReview.count.mockResolvedValue(0);

    await recomputeRentalPositiveRate(asTx(tx), "user-owner");

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-owner" },
      data: { rentalPositiveRate: 0 },
    });
  });

  it("approves an order and writes the transition log plus notification", async () => {
    const tx = buildTx();
    tx.rentalOrder.findFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_APPROVAL",
      ownerId: "user-owner",
      renterId: "user-renter",
    });
    tx.rentalOrder.update.mockResolvedValue({});

    const result = await approveRentalOrderTx(asTx(tx), { orderId: "order-1", userId: "user-owner" });

    expect(result).toEqual({ success: true });
    expect(tx.rentalOrder.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "PENDING_PICKUP" },
    });
    expect(tx.rentalOrderStatusLog.create).toHaveBeenCalledWith({
      data: {
        orderId: "order-1",
        fromStatus: "PENDING_APPROVAL",
        toStatus: "PENDING_PICKUP",
        operatorId: "user-owner",
        note: "出租者同意租赁",
      },
    });
    expect(createNotifications).toHaveBeenCalledWith(
      asTx(tx),
      [expect.objectContaining({ userId: "user-renter", title: "租赁申请已通过" })],
    );
  });

  it("returns the domain error when the order is not approvable", async () => {
    const tx = buildTx();
    tx.rentalOrder.findFirst.mockResolvedValue(null);

    const result = await approveRentalOrderTx(asTx(tx), { orderId: "order-1", userId: "user-owner" });

    expect(result).toEqual({ error: "订单不存在或状态不允许" });
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("completes the order without deduction when the renter rejects the claim", async () => {
    const tx = buildTx();
    tx.rentalDamageClaim.findFirst.mockResolvedValue({
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
    });

    const result = await respondDamageClaimTx(asTx(tx), {
      claimId: "claim-1",
      userId: "user-renter",
      agreed: false,
    });

    expect(result).toEqual({ success: true });
    expect(tx.rentalDamageClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "claim-1" },
        data: expect.objectContaining({ renterAgreed: false }),
      }),
    );
    expect(tx.rentalOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED", depositStatus: "PENDING_REFUND" }),
      }),
    );
    expect(tx.rentalOrderStatusLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromStatus: "PENDING_INSPECTION",
          toStatus: "COMPLETED",
          note: "租客拒绝损坏索赔，订单完成",
        }),
      }),
    );
    expect(tx.user.update).toHaveBeenCalledTimes(2);
  });

  it("returns the domain error when the claim responder is not the renter", async () => {
    const tx = buildTx();
    tx.rentalDamageClaim.findFirst.mockResolvedValue({
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
    });

    const result = await respondDamageClaimTx(asTx(tx), {
      claimId: "claim-1",
      userId: "user-owner",
      agreed: true,
    });

    expect(result).toEqual({ error: "无效请求" });
    expect(tx.rentalDamageClaim.update).not.toHaveBeenCalled();
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
  });
});
