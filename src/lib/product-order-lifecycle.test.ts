import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const {
  assertActiveAccountMutationAllowed,
  evaluateMarketplaceCapability,
  createNotifications,
} = vi.hoisted(() => ({
  assertActiveAccountMutationAllowed: vi.fn(),
  evaluateMarketplaceCapability: vi.fn(),
  createNotifications: vi.fn(),
}));

vi.mock("@/lib/governance/active-account-mutation", () => ({
  assertActiveAccountMutationAllowed,
}));

vi.mock("@/lib/enforcement/capability-gate", () => ({
  evaluateMarketplaceCapability,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotifications,
}));

import {
  cancelProductOrderTx,
  ACTIVE_PRODUCT_ORDER_STATUSES,
} from "@/lib/product-order-lifecycle";

/**
 * AUDIT2-RB01：PRODUCT cancellation → listing 投影的唯一权威状态机单元合同。
 *
 * 冻结不变量：ORDER WIND-DOWN ≠ LISTING EXPOSURE AUTHORITY——
 * PENDING → CANCELLED 后 Product 只在「RESERVED + 未删除 + 无其它
 * active order + seller capability PASS」时 ACTIVE；卖家显式 OFFLINE /
 * 软删除 / 其它 active order / seller 不具备重新曝光资格时不得 ACTIVE。
 */

const buyerId = "buyer-1";
const sellerId = "seller-1";
const orderId = "order-1";
const productId = "product-1";
const candidate = { buyerId, sellerId, productId };

type TxMocks = {
  tx: Prisma.TransactionClient;
  executeRaw: ReturnType<typeof vi.fn>;
  queryRaw: ReturnType<typeof vi.fn>;
  orderUpdateMany: ReturnType<typeof vi.fn>;
  orderFindFirst: ReturnType<typeof vi.fn>;
  productUpdate: ReturnType<typeof vi.fn>;
};

function makeTx(input: {
  orderRow?: Record<string, unknown> | null;
  productRow?: Record<string, unknown> | null;
  otherActiveOrder?: { id: string } | null;
  transitionCount?: number;
}): TxMocks {
  const defaultOrderRow = {
    id: orderId,
    type: "PRODUCT",
    status: "PENDING",
    buyerId,
    sellerId,
    productId,
  };
  const orderRow =
    input.orderRow === undefined ? defaultOrderRow : input.orderRow;

  const executeRaw = vi.fn().mockResolvedValue(0);
  const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join("|") : String(strings);
    if (sql.includes('FROM "Order"')) {
      return orderRow ? [orderRow] : [];
    }
    if (sql.includes('FROM "Product"')) {
      return input.productRow ? [input.productRow] : [];
    }
    return [];
  });
  const orderUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: input.transitionCount ?? 1 });
  const orderFindFirst = vi
    .fn()
    .mockResolvedValue(input.otherActiveOrder ?? null);
  const productUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    order: {
      updateMany: orderUpdateMany,
      findFirst: orderFindFirst,
    },
    product: {
      update: productUpdate,
    },
  } as unknown as Prisma.TransactionClient;

  return { tx, executeRaw, queryRaw, orderUpdateMany, orderFindFirst, productUpdate };
}

const reservedProduct = {
  id: productId,
  campusId: "campus-1",
  sellerId,
  status: "RESERVED",
  deletedAt: null,
};

beforeEach(() => {
  assertActiveAccountMutationAllowed.mockReset().mockResolvedValue(undefined);
  evaluateMarketplaceCapability.mockReset().mockResolvedValue({ allowed: true });
  createNotifications.mockReset().mockResolvedValue(undefined);
});

describe("cancelProductOrderTx（PRODUCT-CANCEL 状态机）", () => {
  it("CASE A：RESERVED + 无其它 active order + capability PASS → ACTIVE", async () => {
    const m = makeTx({ productRow: reservedProduct });

    const result = await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

    expect(result).toEqual({ isBuyer: true });
    expect(m.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: orderId, status: "PENDING" },
      data: {
        status: "CANCELLED",
        completedAt: null,
        cancelReason: "用户主动取消",
      },
    });
    expect(evaluateMarketplaceCapability).toHaveBeenCalledWith(
      m.tx,
      sellerId,
      "campus-1",
    );
    expect(m.productUpdate).toHaveBeenCalledWith({
      where: { id: productId },
      data: { status: "ACTIVE" },
    });
    expect(createNotifications).toHaveBeenCalledTimes(1);
  });

  it("CASE B：seller risk RESTRICTED → OFFLINE（订单取消仍执行）", async () => {
    evaluateMarketplaceCapability.mockResolvedValue({
      allowed: false,
      denialReason: "RISK_RESTRICTED",
    });
    const m = makeTx({ productRow: reservedProduct });

    const result = await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

    expect(result).toEqual({ isBuyer: true });
    expect(m.productUpdate).toHaveBeenCalledWith({
      where: { id: productId },
      data: { status: "OFFLINE" },
    });
    expect(createNotifications).toHaveBeenCalled();
  });

  it("CASE B：seller membership 非ACTIVE → OFFLINE", async () => {
    evaluateMarketplaceCapability.mockResolvedValue({
      allowed: false,
      denialReason: "MEMBERSHIP_NOT_ACTIVE",
    });
    const m = makeTx({ productRow: reservedProduct });

    await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

    expect(m.productUpdate).toHaveBeenCalledWith({
      where: { id: productId },
      data: { status: "OFFLINE" },
    });
  });

  it("CASE B：counterparty account SUSPENDED → OFFLINE（不阻止取消）", async () => {
    evaluateMarketplaceCapability.mockResolvedValue({
      allowed: false,
      denialReason: "ACCOUNT_INACTIVE",
    });
    const m = makeTx({ productRow: reservedProduct });

    const result = await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

    expect(result).toEqual({ isBuyer: true });
    expect(assertActiveAccountMutationAllowed).toHaveBeenCalledWith(m.tx, buyerId);
    expect(m.productUpdate).toHaveBeenCalledWith({
      where: { id: productId },
      data: { status: "OFFLINE" },
    });
  });

  it("CASE C：卖家已显式 OFFLINE → 不覆盖，零 product 写", async () => {
    const m = makeTx({
      productRow: { ...reservedProduct, status: "OFFLINE" },
    });

    const result = await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

    expect(result).toEqual({ isBuyer: true });
    expect(m.productUpdate).not.toHaveBeenCalled();
    expect(evaluateMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("CASE C：SOLD / ACTIVE 同样不被 wind-down 覆盖", async () => {
    for (const status of ["SOLD", "ACTIVE"]) {
      const m = makeTx({
        productRow: { ...reservedProduct, status },
      });

      await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

      expect(m.productUpdate).not.toHaveBeenCalled();
    }
  });

  it("CASE D：deletedAt != null → 不复活 contradictory state", async () => {
    const m = makeTx({
      productRow: { ...reservedProduct, deletedAt: new Date("2026-01-01T00:00:00Z") },
    });

    const result = await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

    expect(result).toEqual({ isBuyer: true });
    expect(m.productUpdate).not.toHaveBeenCalled();
    expect(evaluateMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("CASE E：存在其它 PENDING/ACCEPTED PRODUCT order → 保持 RESERVED", async () => {
    const m = makeTx({
      productRow: reservedProduct,
      otherActiveOrder: { id: "order-2" },
    });

    const result = await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

    expect(result).toEqual({ isBuyer: true });
    expect(m.orderFindFirst).toHaveBeenCalledWith({
      where: {
        productId,
        type: "PRODUCT",
        id: { not: orderId },
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      select: { id: true },
    });
    expect(m.productUpdate).not.toHaveBeenCalled();
  });

  it("订单行缺失 / 非 PRODUCT / 已非 PENDING → null 零写入零通知", async () => {
    for (const orderRow of [
      null,
      { id: orderId, type: "SERVICE", status: "PENDING", buyerId, sellerId, productId },
      { id: orderId, type: "PRODUCT", status: "ACCEPTED", buyerId, sellerId, productId },
      { id: orderId, type: "PRODUCT", status: "CANCELLED", buyerId, sellerId, productId },
    ]) {
      const m = makeTx({ orderRow });

      expect(
        await cancelProductOrderTx(m.tx, buyerId, orderId, candidate),
      ).toBeNull();
      expect(m.orderUpdateMany).not.toHaveBeenCalled();
      expect(m.productUpdate).not.toHaveBeenCalled();
      expect(createNotifications).not.toHaveBeenCalled();
    }
  });

  it("actor 非参与方 → null（身份以锁内 fresh 行为准）", async () => {
    const m = makeTx({ productRow: reservedProduct });

    expect(
      await cancelProductOrderTx(m.tx, "outsider-1", orderId, candidate),
    ).toBeNull();
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("锁内行与 candidate 失配 → fail closed null", async () => {
    const m = makeTx({
      orderRow: {
        id: orderId,
        type: "PRODUCT",
        status: "PENDING",
        buyerId: "someone-else",
        sellerId,
        productId,
      },
    });

    expect(
      await cancelProductOrderTx(m.tx, buyerId, orderId, candidate),
    ).toBeNull();
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("条件 transition 失抢（count 0）→ null，无 product 写、无重复通知", async () => {
    const m = makeTx({
      productRow: reservedProduct,
      transitionCount: 0,
    });

    expect(
      await cancelProductOrderTx(m.tx, buyerId, orderId, candidate),
    ).toBeNull();
    expect(m.productUpdate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("actor lifecycle 非 ACTIVE → 抛 AUTH_ACCOUNT_INACTIVE，零订单写", async () => {
    assertActiveAccountMutationAllowed.mockRejectedValue(
      Object.assign(new Error("账号当前不可用"), { code: "AUTH_ACCOUNT_INACTIVE" }),
    );
    const m = makeTx({ productRow: reservedProduct });

    await expect(
      cancelProductOrderTx(m.tx, buyerId, orderId, candidate),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("Product 行缺失 / sellerId 失配（历史异常）→ 订单取消仍完成，零 listing 写", async () => {
    for (const productRow of [
      null,
      { ...reservedProduct, sellerId: "not-the-seller" },
    ]) {
      const m = makeTx({ productRow });

      const result = await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

      expect(result).toEqual({ isBuyer: true });
      expect(m.orderUpdateMany).toHaveBeenCalled();
      expect(m.productUpdate).not.toHaveBeenCalled();
    }
  });

  it("productId 为 null 的异常 PRODUCT 订单 → 取消成功，跳过 product 权威", async () => {
    const m = makeTx({
      orderRow: {
        id: orderId,
        type: "PRODUCT",
        status: "PENDING",
        buyerId,
        sellerId,
        productId: null,
      },
    });

    const result = await cancelProductOrderTx(m.tx, buyerId, orderId, {
      buyerId,
      sellerId,
      productId: null,
    });

    expect(result).toEqual({ isBuyer: true });
    expect(m.productUpdate).not.toHaveBeenCalled();
  });

  it("锁序：sorted participant advisory 锁先于 Order/Product 行锁", async () => {
    const m = makeTx({ productRow: reservedProduct });

    await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

    const advisory = m.executeRaw.mock.invocationCallOrder[0]!;
    const firstRowLock = m.queryRaw.mock.invocationCallOrder[0]!;
    expect(advisory).toBeLessThan(firstRowLock);
    // 两把 participant 锁（buyer + seller，去重后升序）+ 行锁全部发生
    expect(m.executeRaw).toHaveBeenCalledTimes(2);
    expect(m.queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("ACTIVE_PRODUCT_ORDER_STATUSES 冻结值", () => {
  it("只包含 PENDING / ACCEPTED（COMPLETED/CANCELLED 不占 reservation）", () => {
    expect([...ACTIVE_PRODUCT_ORDER_STATUSES]).toEqual(["PENDING", "ACCEPTED"]);
  });
});

describe("静态契约（AUDIT2-RB01 §47）", () => {
  const readSource = (rel: string) =>
    readFileSync(join(process.cwd(), rel), "utf8");

  it("order-status-service 不得再存在 PRODUCT CANCELLED → 无条件 status ACTIVE 写", () => {
    const source = readSource("src/lib/order-status-service.ts");

    expect(source).not.toMatch(/status:\s*"ACTIVE"/);
    expect(source).not.toContain('"ACTIVE"');
  });

  it("order-status-service 对 PRODUCT + CANCELLED 委派唯一权威实现", () => {
    const source = readSource("src/lib/order-status-service.ts");

    expect(source).toContain("cancelProductOrderTx");
    expect(source).toMatch(/requestedStatus\s*===\s*"CANCELLED"/);
  });

  it("product-order-lifecycle 的 ACTIVE 投影必须以锁内 capability 为条件", () => {
    const source = readSource("src/lib/product-order-lifecycle.ts");

    expect(source).toMatch(/capability\.allowed\s*\?\s*"ACTIVE"\s*:\s*"OFFLINE"/);
    // Order / Product 行锁（FOR UPDATE）两侧权威都必须存在
    expect(source).toMatch(/FROM "Order"[\s\S]*?FOR UPDATE/);
    expect(source).toMatch(/FROM "Product"[\s\S]*?FOR UPDATE/);
  });
});
