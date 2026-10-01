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
 * RB-03 REVIEW FIX + Phase 8F：listing status tx authority 单元合同。
 * lifecycle guard 恒先行；三域 fresh 读全部为行级 FOR UPDATE；运行时目标
 * 白名单 fail closed；EXPOSURE_INCREASING 目标追加 marketplace capability；
 * wind-down 目标不要求 capability；fresh row 缺失/非本人 → NO-OP 零写。
 * Phase 8F 核心收紧：RESERVED + active order → 任何 seller target DENY；
 * stale RESERVED 只保留 RESERVED → ACTIVE 唯一恢复路径。
 */

const actor = "user-1";

const lockedProductRow = {
  id: "product-1",
  campusId: "campus-1",
  sellerId: actor,
  status: "ACTIVE",
  deletedAt: null,
};

const lockedServiceRow = {
  id: "service-1",
  campusId: "campus-1",
  ownerId: actor,
  status: "ACTIVE",
  deletedAt: null,
};

const lockedRentalRow = {
  id: "listing-1",
  campusId: "campus-1",
  ownerId: actor,
  status: "AVAILABLE",
  deletedAt: null,
};

function makeTx(options: {
  productRow?: unknown;
  serviceRow?: unknown;
  rentalRow?: unknown;
  activeOrder?: { id: string } | null;
} = {}) {
  return {
    product: {
      update: vi.fn().mockResolvedValue({}),
    },
    serviceListing: {
      update: vi.fn().mockResolvedValue({}),
    },
    rentalListing: {
      update: vi.fn().mockResolvedValue({}),
    },
    order: {
      // ACTIVE 目标 / RESERVED fresh 态的 active PRODUCT order 防御读取
      findFirst: vi.fn().mockResolvedValue(options.activeOrder ?? null),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join("|") : String(strings);
      if (sql.includes('FROM "Product"')) {
        return [options.productRow === undefined ? lockedProductRow : options.productRow];
      }
      if (sql.includes('FROM "ServiceListing"')) {
        return [options.serviceRow === undefined ? lockedServiceRow : options.serviceRow];
      }
      if (sql.includes('FROM "RentalListing"')) {
        return [options.rentalRow === undefined ? lockedRentalRow : options.rentalRow];
      }
      return [];
    }),
  } as unknown as Prisma.TransactionClient & {
    product: { update: ReturnType<typeof vi.fn> };
    serviceListing: { update: ReturnType<typeof vi.fn> };
    rentalListing: { update: ReturnType<typeof vi.fn> };
    order: { findFirst: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  prepareActiveAccountMutation.mockReset().mockResolvedValue(undefined);
  requireMarketplaceCapability.mockReset().mockResolvedValue(undefined);
});

describe("updateProductStatusTx（PSTATUS，8A-02 system-owned 权威 + 8F RESERVED 收紧）", () => {
  it("PSTATUS-01：ACTIVE 目标 → guard + marketplace capability + write", async () => {
    const tx = makeTx({ productRow: { ...lockedProductRow, status: "OFFLINE" } });

    const ok = await updateProductStatusTx(tx, actor, "product-1", "ACTIVE");

    expect(ok).toBe(true);
    expect(prepareActiveAccountMutation).toHaveBeenCalledWith(tx, actor, undefined);
    expect(requireMarketplaceCapability).toHaveBeenCalledWith(tx, actor, "campus-1");
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { status: "ACTIVE" },
    });
  });

  it("PSTATUS-02（8A-02）：RESERVED 目标 → 运行时 DENY，零锁零读零写", async () => {
    const tx = makeTx();

    // 绕过 TS 类型（模拟 as never 直调）也必须在守卫处拒绝
    expect(
      await updateProductStatusTx(tx, actor, "product-1", "RESERVED" as never),
    ).toBe(false);

    expect(prepareActiveAccountMutation).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("PSTATUS-03（8A-02）：SOLD 目标 → 运行时 DENY，零写", async () => {
    const tx = makeTx();

    expect(
      await updateProductStatusTx(tx, actor, "product-1", "SOLD" as never),
    ).toBe(false);

    expect(prepareActiveAccountMutation).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("PSTATUS-04：OFFLINE 目标 → guard，无 capability", async () => {
    const tx = makeTx();

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
      const tx = makeTx({ productRow });

      expect(await updateProductStatusTx(tx, actor, "product-1", "OFFLINE")).toBe(false);
      expect(tx.product.update).not.toHaveBeenCalled();
    }
  });

  it("PSTATUS-06（8A-02）：fresh SOLD → 任何 seller 目标都 DENY（seller-terminal）", async () => {
    // SYSTEM 已完成交易（Product = SOLD）：
    // SOLD→ACTIVE 不得复活已完成交易
    const txActive = makeTx({ productRow: { ...lockedProductRow, status: "SOLD" } });
    expect(await updateProductStatusTx(txActive, actor, "product-1", "ACTIVE")).toBe(false);
    expect(txActive.product.update).not.toHaveBeenCalled();
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();

    // SOLD→OFFLINE 同样 DENY（terminal semantics）
    const txOffline = makeTx({ productRow: { ...lockedProductRow, status: "SOLD" } });
    expect(await updateProductStatusTx(txOffline, actor, "product-1", "OFFLINE")).toBe(false);
    expect(txOffline.product.update).not.toHaveBeenCalled();
  });

  it("PSTATUS-07（8F §4）：RESERVED + active PRODUCT order → ACTIVE 被阻止（安全 NO-OP）", async () => {
    const tx = makeTx({
      productRow: { ...lockedProductRow, status: "RESERVED" },
      activeOrder: { id: "order-1" },
    });

    expect(await updateProductStatusTx(tx, actor, "product-1", "ACTIVE")).toBe(false);
    expect(tx.order.findFirst).toHaveBeenCalledWith({
      where: {
        productId: "product-1",
        type: "PRODUCT",
        status: { in: ["PENDING", "ACCEPTED", "IN_DISPUTE"] },
      },
      select: { id: true },
    });
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("PSTATUS-08（8F §4 核心）：RESERVED + active order → OFFLINE DENY（seller 不可覆盖 system projection）", async () => {
    const tx = makeTx({
      productRow: { ...lockedProductRow, status: "RESERVED" },
      activeOrder: { id: "order-1" },
    });

    expect(await updateProductStatusTx(tx, actor, "product-1", "OFFLINE")).toBe(false);
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("PSTATUS-09（8A-02）：RESERVED + 无 active order → ACTIVE 恢复（stale RESERVED 唯一恢复路径）", async () => {
    const tx = makeTx({ productRow: { ...lockedProductRow, status: "RESERVED" } });

    expect(await updateProductStatusTx(tx, actor, "product-1", "ACTIVE")).toBe(true);
    expect(requireMarketplaceCapability).toHaveBeenCalledWith(tx, actor, "campus-1");
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { status: "ACTIVE" },
    });
  });

  it("PSTATUS-10（8F §4）：stale RESERVED（无 active order）→ OFFLINE DENY（恢复只能走 ACTIVE）", async () => {
    const tx = makeTx({ productRow: { ...lockedProductRow, status: "RESERVED" } });

    expect(await updateProductStatusTx(tx, actor, "product-1", "OFFLINE")).toBe(false);
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("PSTATUS-11：AUTH_ACCOUNT_INACTIVE → 零 product 写", async () => {
    prepareActiveAccountMutation.mockRejectedValue(
      Object.assign(new Error("账号当前不可用"), { code: "AUTH_ACCOUNT_INACTIVE" }),
    );
    const tx = makeTx();

    await expect(
      updateProductStatusTx(tx, actor, "product-1", "OFFLINE"),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("PSTATUS-12（8F §26）：PAUSED 目标（as never 绕过）→ 白名单 DENY", async () => {
    const tx = makeTx();

    expect(
      await updateProductStatusTx(tx, actor, "product-1", "PAUSED" as never),
    ).toBe(false);
    expect(tx.product.update).not.toHaveBeenCalled();
  });
});

describe("updateServiceStatusTx（SSTATUS，8F 行锁升级 + 运行时白名单）", () => {
  it("SSTATUS-01：ACTIVE 目标 → guard + marketplace capability + 行锁 fresh 写", async () => {
    const tx = makeTx({ serviceRow: { ...lockedServiceRow, status: "PAUSED" } });

    const ok = await updateServiceStatusTx(tx, actor, "service-1", "ACTIVE");

    expect(ok).toBe(true);
    expect(requireMarketplaceCapability).toHaveBeenCalledWith(tx, actor, "campus-1");
    expect(tx.serviceListing.update).toHaveBeenCalledWith({
      where: { id: "service-1" },
      data: { status: "ACTIVE" },
    });
  });

  it("SSTATUS-02：PAUSED / OFFLINE 目标 → guard，无 capability", async () => {
    for (const target of ["PAUSED", "OFFLINE"] as const) {
      const tx = makeTx();
      expect(await updateServiceStatusTx(tx, actor, "service-1", target)).toBe(true);
      expect(tx.serviceListing.update).toHaveBeenCalled();
      expect(requireMarketplaceCapability).not.toHaveBeenCalled();
    }
  });

  it("SSTATUS-03（8F §26）：RESERVED / SOLD 目标（as never 绕过）→ 白名单 DENY 零写", async () => {
    for (const target of ["RESERVED", "SOLD"] as const) {
      const tx = makeTx();
      expect(
        await updateServiceStatusTx(tx, actor, "service-1", target as never),
      ).toBe(false);
      expect(prepareActiveAccountMutation).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.serviceListing.update).not.toHaveBeenCalled();
    }
  });

  it("SSTATUS-04：fresh missing / 非本人 / 已删除 → NO-OP 零写", async () => {
    for (const serviceRow of [
      null,
      { ...lockedServiceRow, ownerId: "someone-else" },
      { ...lockedServiceRow, deletedAt: new Date("2026-01-01T00:00:00Z") },
    ]) {
      const tx = makeTx({ serviceRow });
      expect(await updateServiceStatusTx(tx, actor, "service-1", "PAUSED")).toBe(false);
      expect(tx.serviceListing.update).not.toHaveBeenCalled();
    }
  });
});

describe("updateRentalListingStatusTx（RSTATUS，8F 行锁升级 + legacy fail closed）", () => {
  it("RSTATUS-01：AVAILABLE 目标 → guard + marketplace capability", async () => {
    const tx = makeTx({ rentalRow: { ...lockedRentalRow, status: "PAUSED" } });

    const ok = await updateRentalListingStatusTx(tx, actor, "listing-1", "AVAILABLE");

    expect(ok).toBe(true);
    expect(requireMarketplaceCapability).toHaveBeenCalledWith(tx, actor, "campus-1");
    expect(tx.rentalListing.update).toHaveBeenCalledWith({
      where: { id: "listing-1" },
      data: { status: "AVAILABLE" },
    });
  });

  it("RSTATUS-02：PAUSED / OFFLINE 目标 → guard，无 capability", async () => {
    for (const target of ["PAUSED", "OFFLINE"] as const) {
      const tx = makeTx();
      expect(await updateRentalListingStatusTx(tx, actor, "listing-1", target)).toBe(true);
      expect(tx.rentalListing.update).toHaveBeenCalled();
      expect(requireMarketplaceCapability).not.toHaveBeenCalled();
    }
  });

  it("RSTATUS-03：fresh BANNED → NO-OP 零写（NOT_USER_SETTABLE）", async () => {
    const tx = makeTx({ rentalRow: { ...lockedRentalRow, status: "BANNED" } });

    expect(await updateRentalListingStatusTx(tx, actor, "listing-1", "PAUSED")).toBe(false);
    expect(tx.rentalListing.update).not.toHaveBeenCalled();
  });

  it("RSTATUS-04：fresh PENDING_REVIEW → NO-OP 零写", async () => {
    const tx = makeTx({ rentalRow: { ...lockedRentalRow, status: "PENDING_REVIEW" } });

    expect(await updateRentalListingStatusTx(tx, actor, "listing-1", "AVAILABLE")).toBe(false);
    expect(tx.rentalListing.update).not.toHaveBeenCalled();
  });

  it("RSTATUS-05（8F §25）：fresh FULLY_BOOKED（legacy）→ NO-OP 零写 fail closed", async () => {
    const tx = makeTx({ rentalRow: { ...lockedRentalRow, status: "FULLY_BOOKED" } });

    expect(await updateRentalListingStatusTx(tx, actor, "listing-1", "AVAILABLE")).toBe(false);
    expect(tx.rentalListing.update).not.toHaveBeenCalled();
  });

  it("RSTATUS-06（8F §26）：目标越界（as never 绕过）→ 白名单 DENY 零写", async () => {
    for (const target of ["FULLY_BOOKED", "BANNED", "PENDING_REVIEW"] as const) {
      const tx = makeTx();
      expect(
        await updateRentalListingStatusTx(tx, actor, "listing-1", target as never),
      ).toBe(false);
      expect(prepareActiveAccountMutation).not.toHaveBeenCalled();
      expect(tx.rentalListing.update).not.toHaveBeenCalled();
    }
  });

  it("RSTATUS-07：fresh missing / 非本人 / 已删除 → NO-OP 零写", async () => {
    for (const rentalRow of [
      null,
      { ...lockedRentalRow, ownerId: "someone-else" },
      { ...lockedRentalRow, deletedAt: new Date("2026-01-01T00:00:00Z") },
    ]) {
      const tx = makeTx({ rentalRow });
      expect(await updateRentalListingStatusTx(tx, actor, "listing-1", "PAUSED")).toBe(false);
      expect(tx.rentalListing.update).not.toHaveBeenCalled();
    }
  });
});
