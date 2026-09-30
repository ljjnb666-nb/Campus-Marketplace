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
  acceptProductOrderTx,
  cancelProductOrderTx,
  ACTIVE_PRODUCT_ORDER_STATUSES,
  expireProductReservationTx,
} from "@/lib/product-order-lifecycle";
import { PRODUCT_RESERVATION_TTL_MS } from "@/lib/product-reservation";

/**
 * AUDIT2-RB01 + PHASE 8B-01：PRODUCT accept / cancel / reservation expiry
 * 的唯一权威状态机单元合同。
 *
 * 冻结不变量：
 *   - ORDER WIND-DOWN ≠ LISTING EXPOSURE AUTHORITY：Product 只在
 *     「RESERVED + 未删除 + 无其它 active order + seller capability PASS」
 *     时重新 ACTIVE。
 *   - reservation deadline：now >= expiresAt = EXPIRED（中央判定共享）；
 *     期限内 accept → ACCEPTED resolution；超期 accept/cancel 同一事务
 *     materialize EXPIRED（deadline truth > late user intent）；
 *   - explicit expire 无 user actor：不要求任何账号 ACTIVE 检查；
 *   - 幂等：非 PENDING fresh 行 → NOOP，零重复通知零重复投影。
 */

const buyerId = "buyer-1";
const sellerId = "seller-1";
const orderId = "order-1";
const productId = "product-1";
const candidate = { buyerId, sellerId, productId };

// 时间基准相对化（原为固定日期 2026-09-30T12:00Z——真实时钟越过即翻转
// 期限内/超期语义，CASE A 类真实时钟用例必炸）。RB02 determinism：只捕获
// 一次基准 instant（多次 Date.now() 不是同一时刻，跨毫秒会破坏 exact
// 边界），其余全部由 FUTURE_DEADLINE 派生，关系严格冻结：
// BEFORE = FUTURE - 1ms、AT == FUTURE、AFTER = FUTURE + 1ms。
const TEST_BASE_MS = Date.now();
const RESERVATION_DEADLINE_OFFSET_MS = 24 * 60 * 60 * 1000;
const FUTURE_DEADLINE = new Date(TEST_BASE_MS + RESERVATION_DEADLINE_OFFSET_MS);
const BEFORE_DEADLINE = new Date(FUTURE_DEADLINE.getTime() - 1);
const AT_DEADLINE = new Date(FUTURE_DEADLINE.getTime());
const AFTER_DEADLINE = new Date(FUTURE_DEADLINE.getTime() + 1);

type TxMocks = {
  tx: Prisma.TransactionClient;
  executeRaw: ReturnType<typeof vi.fn>;
  queryRaw: ReturnType<typeof vi.fn>;
  orderUpdateMany: ReturnType<typeof vi.fn>;
  orderFindFirst: ReturnType<typeof vi.fn>;
  orderFindUnique: ReturnType<typeof vi.fn>;
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
    productReservationExpiresAt: FUTURE_DEADLINE,
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
  const orderFindUnique = vi.fn(async () => {
    if (!orderRow) return null;
    const { type, buyerId: b, sellerId: s, productId: p } = orderRow;
    return { type, buyerId: b, sellerId: s, productId: p };
  });
  const productUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    order: {
      updateMany: orderUpdateMany,
      findFirst: orderFindFirst,
      findUnique: orderFindUnique,
    },
    product: {
      update: productUpdate,
    },
  } as unknown as Prisma.TransactionClient;

  return {
    tx,
    executeRaw,
    queryRaw,
    orderUpdateMany,
    orderFindFirst,
    orderFindUnique,
    productUpdate,
  };
}

const reservedProduct = {
  id: productId,
  campusId: "campus-1",
  sellerId,
  status: "RESERVED",
  deletedAt: null,
};

function expiredNotifications(createNotifications: ReturnType<typeof vi.fn>) {
  // createNotifications(tx, notifications)：第 2 参才是通知数组
  return createNotifications.mock.calls.flatMap((call) => call[1] ?? []);
}

beforeEach(() => {
  assertActiveAccountMutationAllowed.mockReset().mockResolvedValue(undefined);
  evaluateMarketplaceCapability.mockReset().mockResolvedValue({ allowed: true });
  createNotifications.mockReset().mockResolvedValue(undefined);
});

describe("cancelProductOrderTx（PRODUCT-CANCEL 状态机）", () => {
  it("CASE A：期限内取消 → CANCELLED resolution + ACTIVE 投影", async () => {
    const m = makeTx({ productRow: reservedProduct });

    const result = await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

    expect(result).toEqual({ isBuyer: true });
    expect(m.orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: orderId, status: "PENDING" },
        data: expect.objectContaining({
          status: "CANCELLED",
          completedAt: null,
          cancelReason: "用户主动取消",
          productReservationResolution: "CANCELLED",
        }),
      }),
    );
    expect(m.orderUpdateMany.mock.calls[0]![0].data.productReservationResolvedAt).toBeInstanceOf(Date);
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
        status: { in: ["PENDING", "ACCEPTED", "IN_DISPUTE"] },
      },
      select: { id: true },
    });
    expect(m.productUpdate).not.toHaveBeenCalled();
  });

  it("订单行缺失 / 非 PRODUCT / 已非 PENDING → null 零写入零通知", async () => {
    for (const orderRow of [
      null,
      { id: orderId, type: "SERVICE", status: "PENDING", buyerId, sellerId, productId, productReservationExpiresAt: null },
      { id: orderId, type: "PRODUCT", status: "ACCEPTED", buyerId, sellerId, productId, productReservationExpiresAt: FUTURE_DEADLINE },
      { id: orderId, type: "PRODUCT", status: "CANCELLED", buyerId, sellerId, productId, productReservationExpiresAt: null },
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
        productReservationExpiresAt: FUTURE_DEADLINE,
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
        productReservationExpiresAt: FUTURE_DEADLINE,
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

  it("超期取消：deadline truth > late user intent → materialize EXPIRED（不记 CANCELLED resolution）", async () => {
    const m = makeTx({
      productRow: reservedProduct,
      orderRow: {
        id: orderId,
        type: "PRODUCT",
        status: "PENDING",
        buyerId,
        sellerId,
        productId,
        // 已过期的 deadline（锁内真实 now 必然超期）
        productReservationExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    const result = await cancelProductOrderTx(m.tx, buyerId, orderId, candidate);

    expect(result).toEqual({ isBuyer: true });
    expect(m.orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: orderId, status: "PENDING" },
        data: expect.objectContaining({
          status: "CANCELLED",
          cancelReason: "商品预留超时自动释放",
          productReservationResolution: "EXPIRED",
        }),
      }),
    );
    expect(m.productUpdate).toHaveBeenCalledWith({
      where: { id: productId },
      data: { status: "ACTIVE" },
    });
    // 超期取消不发"用户主动取消"文案，只发 expiry 通知对
    expect(expiredNotifications(createNotifications)).toEqual([
      expect.objectContaining({ userId: buyerId, title: "商品预留已过期" }),
      expect.objectContaining({ userId: sellerId, title: "商品预留已过期" }),
    ]);
  });
});

describe("acceptProductOrderTx（PHASE 8B-01 PRODUCT-ACCEPT 状态机）", () => {
  it("期限内：PENDING → ACCEPTED + resolution ACCEPTED，Product 保持原状", async () => {
    const m = makeTx({ productRow: reservedProduct });

    const outcome = await acceptProductOrderTx(
      m.tx,
      sellerId,
      orderId,
      candidate,
      undefined,
      { now: BEFORE_DEADLINE },
    );

    expect(outcome).toEqual({ reservationResolution: "ACCEPTED" });
    expect(m.orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: orderId, status: "PENDING" },
        data: expect.objectContaining({
          status: "ACCEPTED",
          completedAt: null,
          cancelReason: null,
          productReservationResolvedAt: BEFORE_DEADLINE,
          productReservationResolution: "ACCEPTED",
        }),
      }),
    );
    // accept 不拥有 listing 投影权威：Product remains as-is（通常 RESERVED）
    expect(m.productUpdate).not.toHaveBeenCalled();
    expect(m.queryRaw).toHaveBeenCalledTimes(1); // 只锁 Order 行，不触 Product 行
    // 既有 accept 通知语义逐字保留（general path 同款文案）
    expect(expiredNotifications(createNotifications)).toEqual([
      expect.objectContaining({ userId: buyerId, title: "订单状态更新：已接单" }),
      expect.objectContaining({ userId: sellerId, title: "订单状态更新：已接单" }),
    ]);
  });

  it("at deadline（now == expiresAt）：不得接受 → 同一事务 materialize EXPIRED", async () => {
    const m = makeTx({ productRow: reservedProduct });

    const outcome = await acceptProductOrderTx(
      m.tx,
      sellerId,
      orderId,
      candidate,
      undefined,
      { now: AT_DEADLINE },
    );

    expect(outcome).toEqual({ reservationResolution: "EXPIRED" });
    expect(m.orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: orderId, status: "PENDING" },
        data: expect.objectContaining({
          status: "CANCELLED",
          cancelReason: "商品预留超时自动释放",
          productReservationResolution: "EXPIRED",
        }),
      }),
    );
    expect(m.productUpdate).toHaveBeenCalledWith({
      where: { id: productId },
      data: { status: "ACTIVE" },
    });
    // 绝不能发"已接单"通知；只有 expiry 通知对
    expect(expiredNotifications(createNotifications)).toEqual([
      expect.objectContaining({ userId: buyerId, title: "商品预留已过期" }),
      expect.objectContaining({ userId: sellerId, title: "商品预留已过期" }),
    ]);
  });

  it("after deadline：同样 EXPIRED", async () => {
    const m = makeTx({ productRow: reservedProduct });

    const outcome = await acceptProductOrderTx(
      m.tx,
      sellerId,
      orderId,
      candidate,
      undefined,
      { now: AFTER_DEADLINE },
    );

    expect(outcome).toEqual({ reservationResolution: "EXPIRED" });
    expect(expiredNotifications(createNotifications)).toHaveLength(2);
  });

  it("buyer 不是 accept actor → null（actor 必须 = seller）", async () => {
    const m = makeTx({ productRow: reservedProduct });

    expect(
      await acceptProductOrderTx(m.tx, buyerId, orderId, candidate, undefined, {
        now: BEFORE_DEADLINE,
      }),
    ).toBeNull();
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("无 deadline 的 PENDING PRODUCT 异常行 → fail closed null", async () => {
    const m = makeTx({
      productRow: reservedProduct,
      orderRow: {
        id: orderId,
        type: "PRODUCT",
        status: "PENDING",
        buyerId,
        sellerId,
        productId,
        productReservationExpiresAt: null,
      },
    });

    expect(
      await acceptProductOrderTx(m.tx, sellerId, orderId, candidate, undefined, {
        now: BEFORE_DEADLINE,
      }),
    ).toBeNull();
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("非 PENDING / 非 PRODUCT / candidate 失配 / 缺行 → null 零写入", async () => {
    for (const orderRow of [
      null,
      { id: orderId, type: "SERVICE", status: "PENDING", buyerId, sellerId, productId, productReservationExpiresAt: null },
      { id: orderId, type: "PRODUCT", status: "ACCEPTED", buyerId, sellerId, productId, productReservationExpiresAt: FUTURE_DEADLINE },
      { id: orderId, type: "PRODUCT", status: "PENDING", buyerId: "other", sellerId, productId, productReservationExpiresAt: FUTURE_DEADLINE },
    ]) {
      const m = makeTx({ orderRow });

      expect(
        await acceptProductOrderTx(m.tx, sellerId, orderId, candidate, undefined, {
          now: BEFORE_DEADLINE,
        }),
      ).toBeNull();
      expect(m.orderUpdateMany).not.toHaveBeenCalled();
      expect(createNotifications).not.toHaveBeenCalled();
    }
  });

  it("条件 transition 失抢 → null（safety belt）", async () => {
    const m = makeTx({ productRow: reservedProduct, transitionCount: 0 });

    expect(
      await acceptProductOrderTx(m.tx, sellerId, orderId, candidate, undefined, {
        now: BEFORE_DEADLINE,
      }),
    ).toBeNull();
    expect(m.productUpdate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("锁序：sorted pair locks → Order 行锁（禁止 actor-only 先锁）", async () => {
    const m = makeTx({ productRow: reservedProduct });

    await acceptProductOrderTx(m.tx, sellerId, orderId, candidate, undefined, {
      now: BEFORE_DEADLINE,
    });

    const advisory = m.executeRaw.mock.invocationCallOrder[0]!;
    const rowLock = m.queryRaw.mock.invocationCallOrder[0]!;
    expect(advisory).toBeLessThan(rowLock);
    expect(m.executeRaw).toHaveBeenCalledTimes(2);
  });
});

describe("expireProductReservationTx（PHASE 8B-01 系统过期）", () => {
  it("NOT_DUE：期限内 → 零写零通知", async () => {
    const m = makeTx({ productRow: reservedProduct });

    const outcome = await expireProductReservationTx(
      m.tx,
      orderId,
      undefined,
      { now: BEFORE_DEADLINE },
    );

    expect(outcome).toEqual({ kind: "NOT_DUE" });
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
    expect(m.productUpdate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("DUE：PENDING → CANCELLED/EXPIRED + Product release + 恰一对通知", async () => {
    const m = makeTx({ productRow: reservedProduct });

    const outcome = await expireProductReservationTx(
      m.tx,
      orderId,
      undefined,
      { now: AT_DEADLINE },
    );

    expect(outcome).toEqual({ kind: "EXPIRED" });
    expect(m.orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: orderId, status: "PENDING" },
        data: expect.objectContaining({
          status: "CANCELLED",
          cancelReason: "商品预留超时自动释放",
          productReservationResolvedAt: AT_DEADLINE,
          productReservationResolution: "EXPIRED",
        }),
      }),
    );
    expect(m.productUpdate).toHaveBeenCalledWith({
      where: { id: productId },
      data: { status: "ACTIVE" },
    });
    expect(expiredNotifications(createNotifications)).toEqual([
      expect.objectContaining({ userId: buyerId, title: "商品预留已过期" }),
      expect.objectContaining({ userId: sellerId, title: "商品预留已过期" }),
    ]);
  });

  it("幂等：已非 PENDING（fresh 行）→ NOT_PENDING，零重复副作用", async () => {
    const m = makeTx({
      productRow: reservedProduct,
      orderRow: {
        id: orderId,
        type: "PRODUCT",
        status: "CANCELLED",
        buyerId,
        sellerId,
        productId,
        productReservationExpiresAt: FUTURE_DEADLINE,
      },
    });

    const outcome = await expireProductReservationTx(
      m.tx,
      orderId,
      undefined,
      { now: AFTER_DEADLINE },
    );

    expect(outcome).toEqual({ kind: "NOT_PENDING" });
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
    expect(m.productUpdate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("无 user actor：不做任何账号 ACTIVE 检查（suspended 参与方不阻止过期）", async () => {
    const m = makeTx({ productRow: reservedProduct });

    await expireProductReservationTx(m.tx, orderId, undefined, { now: AT_DEADLINE });

    expect(assertActiveAccountMutationAllowed).not.toHaveBeenCalled();
    expect(m.orderUpdateMany).toHaveBeenCalled();
  });

  it("candidate pre-read 缺行 / 非 PRODUCT → null（pre-read 非权威，仅锁键发现）", async () => {
    const missing = makeTx({ orderRow: null });
    expect(
      await expireProductReservationTx(missing.tx, orderId, undefined, { now: AT_DEADLINE }),
    ).toBeNull();

    const serviceOrder = makeTx({
      orderRow: { id: orderId, type: "SERVICE", status: "PENDING", buyerId, sellerId, productId, productReservationExpiresAt: null },
    });
    expect(
      await expireProductReservationTx(serviceOrder.tx, orderId, undefined, { now: AT_DEADLINE }),
    ).toBeNull();

    for (const m of [missing, serviceOrder]) {
      expect(m.orderUpdateMany).not.toHaveBeenCalled();
      expect(m.productUpdate).not.toHaveBeenCalled();
      expect(createNotifications).not.toHaveBeenCalled();
    }
  });

  it("锁序：candidate pre-read → sorted pair locks → Order 行锁 → Product 行锁", async () => {
    const m = makeTx({ productRow: reservedProduct });

    await expireProductReservationTx(m.tx, orderId, undefined, { now: AT_DEADLINE });

    const preRead = m.orderFindUnique.mock.invocationCallOrder[0]!;
    const advisory = m.executeRaw.mock.invocationCallOrder[0]!;
    const orderRowLock = m.queryRaw.mock.invocationCallOrder[0]!;
    expect(preRead).toBeLessThan(advisory);
    expect(advisory).toBeLessThan(orderRowLock);
    expect(m.executeRaw).toHaveBeenCalledTimes(2);
    expect(m.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("seller capability FAIL（历史异常/风控）→ OFFLINE 投影，过期本身不受影响", async () => {
    evaluateMarketplaceCapability.mockResolvedValue({
      allowed: false,
      denialReason: "RISK_RESTRICTED",
    });
    const m = makeTx({ productRow: reservedProduct });

    const outcome = await expireProductReservationTx(
      m.tx,
      orderId,
      undefined,
      { now: AFTER_DEADLINE },
    );

    expect(outcome).toEqual({ kind: "EXPIRED" });
    expect(m.productUpdate).toHaveBeenCalledWith({
      where: { id: productId },
      data: { status: "OFFLINE" },
    });
    expect(expiredNotifications(createNotifications)).toHaveLength(2);
  });
});

describe("ACTIVE_PRODUCT_ORDER_STATUSES 冻结值", () => {
  it("包含 PENDING / ACCEPTED / IN_DISPUTE（COMPLETED/CANCELLED/CLOSED 不占 reservation）", () => {
    // Phase 8C-01：IN_DISPUTE 属 dispute 治理冻结，仍占 reservation occupancy
    expect([...ACTIVE_PRODUCT_ORDER_STATUSES]).toEqual(["PENDING", "ACCEPTED", "IN_DISPUTE"]);
  });
});

describe("TTL 常量冻结", () => {
  it("accept/expire 共享 24h TTL 单一定义", () => {
    expect(PRODUCT_RESERVATION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("静态契约（AUDIT2-RB01 §47 + PHASE 8B-01）", () => {
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

  it("PHASE 8B-01：order-status-service 对 PRODUCT + ACCEPTED 委派 acceptProductOrderTx，general 路径不再拥有 PRODUCT ACCEPTED", () => {
    const source = readSource("src/lib/order-status-service.ts");

    expect(source).toContain("acceptProductOrderTx");
    expect(source).toMatch(/requestedStatus\s*===\s*"ACCEPTED"/);
    // general canTransition 的 ACCEPTED 分支只允许 SERVICE
    expect(source).toMatch(
      /requestedStatus === "ACCEPTED" &&\s*\n\s*isSeller &&\s*\n\s*order\.status === "PENDING" &&\s*\n\s*order\.type === "SERVICE"/,
    );
    // 委派必须发生在任何 actor-only USER 锁之前（prepareActiveAccountMutation 之后不得再分流 PRODUCT ACCEPTED）
    const delegationAt = source.indexOf('input.requestedStatus === "ACCEPTED"');
    const actorLockAt = source.indexOf("prepareActiveAccountMutation(tx, actorUserId");
    expect(delegationAt).toBeGreaterThan(-1);
    expect(actorLockAt).toBeGreaterThan(delegationAt);
  });

  it("product-order-lifecycle 的 ACTIVE 投影必须以锁内 capability 为条件", () => {
    const source = readSource("src/lib/product-order-lifecycle.ts");

    expect(source).toMatch(/capability\.allowed\s*\?\s*"ACTIVE"\s*:\s*"OFFLINE"/);
    // Order / Product 行锁（FOR UPDATE）两侧权威都必须存在
    expect(source).toMatch(/FROM "Order"[\s\S]*?FOR UPDATE/);
    expect(source).toMatch(/FROM "Product"[\s\S]*?FOR UPDATE/);
  });

  it("PHASE 8B-01：EXPIRED materialization 必须为共享实现（三路合一同 helper）", () => {
    const source = readSource("src/lib/product-order-lifecycle.ts");

    expect(source).toContain("expireLockedProductReservation");
    // 中央时间边界：禁止各路径自行比较时间
    expect(source.match(/isProductReservationExpired/g)?.length).toBeGreaterThanOrEqual(3);
    // EXPIRED 写入只在共享 helper 内出现一次
    expect(source.match(/productReservationResolution:\s*"EXPIRED"/g)?.length).toBe(1);
  });
});
