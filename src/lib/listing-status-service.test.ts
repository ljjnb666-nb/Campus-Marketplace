import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const {
  prepareActiveAccountMutation,
  requireMarketplaceCapability,
} = vi.hoisted(() => ({
  prepareActiveAccountMutation: vi.fn(),
  requireMarketplaceCapability: vi.fn(),
}));

vi.mock("@/lib/governance/active-account-mutation", () => ({
  prepareActiveAccountMutation,
}));

vi.mock("@/lib/enforcement/capability-gate", () => ({
  requireMarketplaceCapability,
}));

import {
  updateProductStatusTx,
  updateServiceStatusTx,
  updateRentalListingStatusTx,
} from "@/lib/listing-status-service";

/**
 * RB-03 REVIEW FIX：listing status tx authority 单元合同。
 * lifecycle guard 恒先行；EXPOSURE_INCREASING 目标追加 marketplace
 * capability；wind-down 目标不要求 capability（ACTIVE but RESTRICTED
 * 仍可 wind-down）；fresh row 缺失/非本人 → NO-OP 零写。
 */

const actor = "user-1";

const lockedProductRow = {
  id: "product-1",
  campusId: "campus-1",
  sellerId: actor,
  status: "PAUSED",
  deletedAt: null,
};

function makeTx(
  fresh: unknown,
  options: { productRow?: unknown; activeOrder?: { id: string } | null } = {},
) {
  return {
    product: {
      findFirst: vi.fn().mockResolvedValue(fresh),
      update: vi.fn().mockResolvedValue({}),
    },
    serviceListing: {
      findFirst: vi.fn().mockResolvedValue(fresh),
      update: vi.fn().mockResolvedValue({}),
    },
    rentalListing: {
      findFirst: vi.fn().mockResolvedValue(fresh),
      update: vi.fn().mockResolvedValue({}),
    },
    order: {
      // AUDIT2-RB01：ACTIVE 目标的 active PRODUCT order 防御读取
      findFirst: vi.fn().mockResolvedValue(options.activeOrder ?? null),
    },
    // AUDIT2-RB01：Product fresh 读 = 行级 FOR UPDATE
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join("|") : String(strings);
      if (sql.includes('FROM "Product"')) {
        return [options.productRow === undefined ? lockedProductRow : options.productRow];
      }
      return [];
    }),
  } as unknown as Prisma.TransactionClient & {
    product: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    serviceListing: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    rentalListing: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    order: { findFirst: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  prepareActiveAccountMutation.mockReset().mockResolvedValue(undefined);
  requireMarketplaceCapability.mockReset().mockResolvedValue(undefined);
});

describe("updateProductStatusTx（PSTATUS）", () => {
  it("PSTATUS-01：ACTIVE 目标 → guard + marketplace capability + write", async () => {
    const tx = makeTx({ id: "product-1", campusId: "campus-1", status: "PAUSED" });

    const ok = await updateProductStatusTx(tx, actor, "product-1", "ACTIVE");

    expect(ok).toBe(true);
    expect(prepareActiveAccountMutation).toHaveBeenCalledWith(tx, actor, undefined);
    expect(requireMarketplaceCapability).toHaveBeenCalledWith(tx, actor, "campus-1");
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { status: "ACTIVE" },
    });
  });

  it("PSTATUS-02：RESERVED 目标 → guard，无 marketplace capability", async () => {
    const tx = makeTx({ id: "product-1", campusId: "campus-1", status: "ACTIVE" });

    await updateProductStatusTx(tx, actor, "product-1", "RESERVED");

    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { status: "RESERVED" },
    });
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("PSTATUS-03：SOLD 目标 → guard，无 capability", async () => {
    const tx = makeTx({ id: "product-1", campusId: "campus-1", status: "ACTIVE" });

    await updateProductStatusTx(tx, actor, "product-1", "SOLD");

    expect(tx.product.update).toHaveBeenCalled();
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("PSTATUS-04：OFFLINE 目标 → guard，无 capability", async () => {
    const tx = makeTx({ id: "product-1", campusId: "campus-1", status: "ACTIVE" });

    await updateProductStatusTx(tx, actor, "product-1", "OFFLINE");

    expect(tx.product.update).toHaveBeenCalled();
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("PSTATUS-05：行缺失 / 非本人 / 已删除 → NO-OP 零写", async () => {
    for (const productRow of [
      null,
      { ...lockedProductRow, sellerId: "someone-else" },
      { ...lockedProductRow, deletedAt: new Date("2026-01-01T00:00:00Z") },
    ]) {
      const tx = makeTx(null, { productRow });

      expect(await updateProductStatusTx(tx, actor, "product-1", "RESERVED")).toBe(false);
      expect(tx.product.update).not.toHaveBeenCalled();
    }
  });

  it("PSTATUS-07（AUDIT2-RB01）：RESERVED + active PRODUCT order → ACTIVE 被阻止（安全 NO-OP）", async () => {
    const tx = makeTx(null, {
      productRow: { ...lockedProductRow, status: "RESERVED" },
      activeOrder: { id: "order-1" },
    });

    expect(await updateProductStatusTx(tx, actor, "product-1", "ACTIVE")).toBe(false);
    expect(tx.order.findFirst).toHaveBeenCalledWith({
      where: {
        productId: "product-1",
        type: "PRODUCT",
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      select: { id: true },
    });
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("PSTATUS-08（AUDIT2-RB01）：无 active order → ACTIVE 放行", async () => {
    const tx = makeTx(null, {
      productRow: { ...lockedProductRow, status: "OFFLINE" },
    });

    expect(await updateProductStatusTx(tx, actor, "product-1", "ACTIVE")).toBe(true);
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { status: "ACTIVE" },
    });
  });

  it("PSTATUS-06：AUTH_ACCOUNT_INACTIVE → 零 product 写", async () => {
    prepareActiveAccountMutation.mockRejectedValue(
      Object.assign(new Error("账号当前不可用"), { code: "AUTH_ACCOUNT_INACTIVE" }),
    );
    const tx = makeTx(null);

    await expect(
      updateProductStatusTx(tx, actor, "product-1", "RESERVED"),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
    expect(tx.product.update).not.toHaveBeenCalled();
  });
});

describe("updateServiceStatusTx（SSTATUS）", () => {
  it("SSTATUS-01：ACTIVE 目标 → guard + marketplace capability", async () => {
    const tx = makeTx({ id: "service-1", campusId: "campus-1", status: "PAUSED" });

    await updateServiceStatusTx(tx, actor, "service-1", "ACTIVE");

    expect(requireMarketplaceCapability).toHaveBeenCalledWith(tx, actor, "campus-1");
    expect(tx.serviceListing.update).toHaveBeenCalled();
  });

  it("SSTATUS-02：PAUSED 目标 → guard，无 capability", async () => {
    const tx = makeTx({ id: "service-1", campusId: "campus-1", status: "ACTIVE" });

    await updateServiceStatusTx(tx, actor, "service-1", "PAUSED");

    expect(tx.serviceListing.update).toHaveBeenCalled();
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("SSTATUS-03：OFFLINE 目标 → guard，无 capability", async () => {
    const tx = makeTx({ id: "service-1", campusId: "campus-1", status: "ACTIVE" });

    await updateServiceStatusTx(tx, actor, "service-1", "OFFLINE");

    expect(tx.serviceListing.update).toHaveBeenCalled();
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("SSTATUS-04：fresh missing → NO-OP 零写", async () => {
    const tx = makeTx(null);

    expect(await updateServiceStatusTx(tx, actor, "service-1", "PAUSED")).toBe(false);
    expect(tx.serviceListing.update).not.toHaveBeenCalled();
  });
});

describe("updateRentalListingStatusTx（RSTATUS）", () => {
  it("RSTATUS-01：AVAILABLE 目标 → guard + marketplace capability", async () => {
    const tx = makeTx({ id: "listing-1", campusId: "campus-1", status: "PAUSED" });

    await updateRentalListingStatusTx(tx, actor, "listing-1", "AVAILABLE");

    expect(requireMarketplaceCapability).toHaveBeenCalledWith(tx, actor, "campus-1");
    expect(tx.rentalListing.update).toHaveBeenCalled();
  });

  it("RSTATUS-02：PAUSED 目标 → guard，无 capability", async () => {
    const tx = makeTx({ id: "listing-1", campusId: "campus-1", status: "AVAILABLE" });

    await updateRentalListingStatusTx(tx, actor, "listing-1", "PAUSED");

    expect(tx.rentalListing.update).toHaveBeenCalled();
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("RSTATUS-03：OFFLINE 目标 → guard，无 capability", async () => {
    const tx = makeTx({ id: "listing-1", campusId: "campus-1", status: "AVAILABLE" });

    await updateRentalListingStatusTx(tx, actor, "listing-1", "OFFLINE");

    expect(tx.rentalListing.update).toHaveBeenCalled();
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("RSTATUS-04：fresh BANNED → NO-OP 零写（NOT_USER_SETTABLE）", async () => {
    const tx = makeTx({ id: "listing-1", campusId: "campus-1", status: "BANNED" });

    expect(await updateRentalListingStatusTx(tx, actor, "listing-1", "PAUSED")).toBe(false);
    expect(tx.rentalListing.update).not.toHaveBeenCalled();
  });

  it("RSTATUS-05：fresh PENDING_REVIEW → NO-OP 零写", async () => {
    const tx = makeTx({ id: "listing-1", campusId: "campus-1", status: "PENDING_REVIEW" });

    expect(await updateRentalListingStatusTx(tx, actor, "listing-1", "AVAILABLE")).toBe(false);
    expect(tx.rentalListing.update).not.toHaveBeenCalled();
  });
});
