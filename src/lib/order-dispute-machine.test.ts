import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const {
  assertActiveAccountMutationAllowed,
  createHoldTxLocked,
  txNotificationCreateMany,
  txNotificationFindUnique,
} = vi.hoisted(() => ({
  assertActiveAccountMutationAllowed: vi.fn(),
  createHoldTxLocked: vi.fn(),
  // Phase 9B：canonical notification emit（emitNotificationTx 写边界）
  txNotificationCreateMany: vi.fn(),
  txNotificationFindUnique: vi.fn(),
}));

vi.mock("@/lib/governance/active-account-mutation", () => ({
  assertActiveAccountMutationAllowed,
}));

vi.mock("@/lib/privacy/data-hold-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy/data-hold-service")>();
  return {
    ...actual,
    createHoldTxLocked,
  };
});

import {
  initiateOrderDisputeTx,
  DISPUTABLE_ERRAND_PAIRS,
  isOpenedFromLegalDisputableSource,
} from "@/lib/order-dispute-machine";
import { ACTIVE_PRODUCT_ORDER_STATUSES } from "@/lib/product-order-lifecycle";

/**
 * Phase 8C-01：General OrderDispute initiation / restore-source 校验的
 * 状态机单元合同（锁序 / campus snapshot / holds / 原子性见真实 PG 集成）。
 *
 * 冻结矩阵（指令 OD-UNIT-01..10）：
 *   PRODUCT：ACCEPTED / COMPLETED allowed；PENDING denied
 *   SERVICE：ACCEPTED / IN_PROGRESS / COMPLETED allowed；PENDING denied
 *   ERRAND：canonical pair allowed；malformed pair denied
 *   outsider denied；participant drift fail closed；active dispute duplicate denied
 */

const buyerId = "buyer-1";
const sellerId = "seller-1";
const orderId = "order-1";
const productId = "product-1";
const errandId = "errand-1";

function makeTx(input: {
  candidate?: Record<string, unknown> | null;
  orderRow?: Record<string, unknown> | null;
  errandRow?: Record<string, unknown> | null;
  campusRow?: Record<string, unknown> | null;
  listingCampusRow?: Record<string, unknown> | null;
  activeDispute?: { id: string } | null;
  createdDisputeId?: string;
}) {
  const orderFindUnique = vi.fn(async () => input.candidate ?? null);

  const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join("|") : String(strings);
    if (sql.includes('FROM "ErrandTask"')) {
      return input.errandRow ? [input.errandRow] : [];
    }
    if (sql.includes('FROM "Order"')) {
      return input.orderRow ? [input.orderRow] : [];
    }
    return [];
  });

  const productFindUnique = vi.fn(async () => input.campusRow ?? null);
  const serviceListingFindUnique = vi.fn(async () => input.listingCampusRow ?? null);
  const disputeFindFirst = vi.fn(async () => input.activeDispute ?? null);
  const disputeCreate = vi.fn(async () => ({ id: input.createdDisputeId ?? "dispute-1" }));
  const orderUpdate = vi.fn().mockResolvedValue({});
  const errandUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    order: { findUnique: orderFindUnique, update: orderUpdate },
    errandTask: { update: errandUpdate },
    product: { findUnique: productFindUnique },
    serviceListing: { findUnique: serviceListingFindUnique },
    orderDispute: { findFirst: disputeFindFirst, create: disputeCreate },
    $queryRaw: queryRaw,
    $executeRaw: vi.fn().mockResolvedValue(0),
    // Phase 9B：emitNotificationTx 内部写入（createMany + dedupe winner 读回）
    notification: {
      createMany: txNotificationCreateMany,
      findUnique: txNotificationFindUnique,
    },
  } as unknown as Prisma.TransactionClient;

  return {
    tx,
    orderFindUnique,
    queryRaw,
    disputeFindFirst,
    disputeCreate,
    orderUpdate,
    errandUpdate,
  };
}

function productOrderRow(status: string) {
  return {
    id: orderId,
    type: "PRODUCT",
    status,
    buyerId,
    sellerId,
    productId,
    serviceListingId: null,
    errandTaskId: null,
  };
}

const productCampus = { campusId: "campus-1" };

beforeEach(() => {
  assertActiveAccountMutationAllowed.mockReset().mockResolvedValue(undefined);
  createHoldTxLocked.mockReset().mockImplementation(async (_tx: unknown, args: { subjectId: string }) => ({
    id: `hold-${args.subjectId}`,
  }));
  // Phase 9B：emitNotificationTx 写边界（createMany + dedupe winner 读回）
  txNotificationCreateMany.mockReset().mockResolvedValue({ count: 1 });
  txNotificationFindUnique.mockReset().mockResolvedValue({ id: "notification-1" });
});

describe("initiateOrderDisputeTx：disputable 状态矩阵", () => {
  const baseInput = { orderId, userId: buyerId, reason: "r", evidencePhotos: [] as string[] };

  it("OD-UNIT-01：PRODUCT ACCEPTED → dispute 创建（campus snapshot 自 Product）", async () => {
    const m = makeTx({
      candidate: { type: "PRODUCT", buyerId, sellerId, productId, serviceListingId: null, errandTaskId: null },
      orderRow: productOrderRow("ACCEPTED"),
      campusRow: productCampus,
    });

    const outcome = await initiateOrderDisputeTx(m.tx, baseInput);

    // Phase 8C-02：success result 携带 locked authoritative Order 的
    // type-FK revalidation context（仅 context extension，语义零变化）
    expect(outcome).toEqual({
      success: true,
      disputeId: "dispute-1",
      productId,
      serviceListingId: null,
      errandTaskId: null,
    });
    expect(m.disputeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "OPEN",
          campusId: "campus-1",
          scopeKey: "CAMPUS:campus-1",
          openedFromOrderStatus: "ACCEPTED",
          openedFromErrandStatus: null,
        }),
      }),
    );
    // buyer + seller 双 holds
    expect(createHoldTxLocked).toHaveBeenCalledTimes(2);
    expect(createHoldTxLocked.mock.calls.map((c) => c[1].subjectId).sort()).toEqual([buyerId, sellerId]);
    // Order → IN_DISPUTE
    expect(m.orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: orderId }, data: { status: "IN_DISPUTE" } }),
    );
    expect(m.errandUpdate).not.toHaveBeenCalled();
  });

  it("OD-UNIT-02：PRODUCT COMPLETED → disputable", async () => {
    const m = makeTx({
      candidate: { type: "PRODUCT", buyerId, sellerId, productId, serviceListingId: null, errandTaskId: null },
      orderRow: productOrderRow("COMPLETED"),
      campusRow: productCampus,
    });

    expect(await initiateOrderDisputeTx(m.tx, baseInput)).toMatchObject({ success: true });
  });

  it("OD-UNIT-03：PRODUCT PENDING → denied（reservation lifecycle 禁入）", async () => {
    const m = makeTx({
      candidate: { type: "PRODUCT", buyerId, sellerId, productId, serviceListingId: null, errandTaskId: null },
      orderRow: productOrderRow("PENDING"),
      campusRow: productCampus,
    });

    expect(await initiateOrderDisputeTx(m.tx, baseInput)).toEqual({ error: "状态不允许纠纷" });
    expect(m.disputeCreate).not.toHaveBeenCalled();
    expect(createHoldTxLocked).not.toHaveBeenCalled();
    expect(txNotificationCreateMany).not.toHaveBeenCalled();
  });

  it("OD-UNIT-04：SERVICE ACCEPTED / IN_PROGRESS / COMPLETED → allowed（campus snapshot 自 listing）", async () => {
    for (const status of ["ACCEPTED", "IN_PROGRESS", "COMPLETED"]) {
      const m = makeTx({
        candidate: { type: "SERVICE", buyerId, sellerId, productId: null, serviceListingId: "svc-1", errandTaskId: null },
        orderRow: {
          id: orderId, type: "SERVICE", status, buyerId, sellerId,
          productId: null, serviceListingId: "svc-1", errandTaskId: null,
        },
        listingCampusRow: { campusId: "campus-2" },
      });

      expect(await initiateOrderDisputeTx(m.tx, baseInput)).toMatchObject({ success: true });
      expect(m.disputeCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ campusId: "campus-2", scopeKey: "CAMPUS:campus-2" }),
        }),
      );
    }
  });

  it("OD-UNIT-05：SERVICE PENDING → denied", async () => {
    const m = makeTx({
      candidate: { type: "SERVICE", buyerId, sellerId, productId: null, serviceListingId: "svc-1", errandTaskId: null },
      orderRow: {
        id: orderId, type: "SERVICE", status: "PENDING", buyerId, sellerId,
        productId: null, serviceListingId: "svc-1", errandTaskId: null,
      },
      listingCampusRow: { campusId: "campus-2" },
    });

    expect(await initiateOrderDisputeTx(m.tx, baseInput)).toEqual({ error: "状态不允许纠纷" });
    expect(m.disputeCreate).not.toHaveBeenCalled();
  });

  it("OD-UNIT-06：ERRAND canonical pair → allowed（ErrandTask 先于 Order 行锁；DISPUTED 写入 + Task snapshot）", async () => {
    for (const [orderStatus, taskStatus] of DISPUTABLE_ERRAND_PAIRS) {
      const m = makeTx({
        candidate: { type: "ERRAND", buyerId, sellerId, productId: null, serviceListingId: null, errandTaskId: errandId },
        errandRow: { id: errandId, status: taskStatus, campusId: "campus-3", publisherId: buyerId, accepterId: sellerId },
        orderRow: {
          id: orderId, type: "ERRAND", status: orderStatus, buyerId, sellerId,
          productId: null, serviceListingId: null, errandTaskId: errandId,
        },
      });

      const outcome = await initiateOrderDisputeTx(m.tx, baseInput);
      expect(outcome).toMatchObject({ success: true });
      expect(m.disputeCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            campusId: "campus-3",
            openedFromOrderStatus: orderStatus,
            openedFromErrandStatus: taskStatus,
          }),
        }),
      );
      expect(m.errandUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: errandId }, data: { status: "DISPUTED" } }),
      );
    }
  });

  it("OD-UNIT-07：ERRAND malformed pair → denied（OPEN/CANCELLED/DISPUTED/CLOSED 或错配）", async () => {
    for (const [orderStatus, taskStatus] of [
      ["PENDING", "OPEN"],
      ["COMPLETED", "IN_PROGRESS"],
      ["IN_PROGRESS", "COMPLETED"],
      ["COMPLETED", "CLAIMED"],
      ["COMPLETED", "DISPUTED"],
    ] as const) {
      const m = makeTx({
        candidate: { type: "ERRAND", buyerId, sellerId, productId: null, serviceListingId: null, errandTaskId: errandId },
        errandRow: { id: errandId, status: taskStatus, campusId: "campus-3", publisherId: buyerId, accepterId: sellerId },
        orderRow: {
          id: orderId, type: "ERRAND", status: orderStatus, buyerId, sellerId,
          productId: null, serviceListingId: null, errandTaskId: errandId,
        },
      });

      expect(await initiateOrderDisputeTx(m.tx, baseInput)).toEqual({ error: "状态不允许纠纷" });
    }
    const none = makeTx({
      candidate: { type: "ERRAND", buyerId, sellerId, productId: null, serviceListingId: null, errandTaskId: errandId },
      errandRow: null,
      orderRow: {
        id: orderId, type: "ERRAND", status: "COMPLETED", buyerId, sellerId,
        productId: null, serviceListingId: null, errandTaskId: errandId,
      },
    });
    expect(
      await initiateOrderDisputeTx(none.tx, baseInput),
    ).toEqual({ error: "无效请求" });
  });
});

describe("initiateOrderDisputeTx：授权 / 一致性 / 幂等", () => {
  const baseInput = { orderId, userId: buyerId, reason: "r", evidencePhotos: [] as string[] };

  function makeProductTx(overrides: {
    orderRow?: Record<string, unknown> | null;
    candidate?: Record<string, unknown> | null;
    activeDispute?: { id: string } | null;
    listingCampusRow?: Record<string, unknown> | null;
  }) {
    return makeTx({
      candidate:
        overrides.candidate ??
        { type: "PRODUCT", buyerId, sellerId, productId, serviceListingId: null, errandTaskId: null },
      orderRow: overrides.orderRow ?? productOrderRow("ACCEPTED"),
      campusRow: productCampus,
      activeDispute: overrides.activeDispute ?? null,
      listingCampusRow: overrides.listingCampusRow ?? null,
    });
  }

  it("OD-UNIT-08：outsider（非 buyer/seller）→ denied 零写入", async () => {
    const m = makeProductTx({});

    expect(await initiateOrderDisputeTx(m.tx, { ...baseInput, userId: "outsider" })).toEqual({
      error: "无效请求",
    });
    expect(m.disputeCreate).not.toHaveBeenCalled();
    expect(createHoldTxLocked).not.toHaveBeenCalled();
  });

  it("OD-UNIT-09：candidate 参与者漂移 → fail closed", async () => {
    const drifted = makeProductTx({
      orderRow: { ...productOrderRow("ACCEPTED"), buyerId: "someone-else" },
    });
    expect(await initiateOrderDisputeTx(drifted.tx, baseInput)).toEqual({
      error: "订单状态已变化，请重试",
    });

    const typeDrift = makeProductTx({
      candidate: { type: "PRODUCT", buyerId, sellerId, productId, serviceListingId: null, errandTaskId: null },
      orderRow: { ...productOrderRow("ACCEPTED"), type: "SERVICE", serviceListingId: "svc-1" },
      listingCampusRow: productCampus,
    });
    expect(await initiateOrderDisputeTx(typeDrift.tx, baseInput)).toEqual({
      error: "订单状态已变化，请重试",
    });
  });

  it("OD-UNIT-10：active dispute 已存在 → duplicate denied", async () => {
    for (const _status of ["OPEN", "IN_REVIEW"] as const) {
      const m = makeProductTx({ activeDispute: { id: "existing" } });

      expect(await initiateOrderDisputeTx(m.tx, baseInput)).toEqual({
        error: "该订单已有进行中的纠纷",
      });
      expect(m.disputeFindFirst).toHaveBeenCalledWith({
        where: { orderId, status: { in: ["OPEN", "IN_REVIEW"] } },
        select: { id: true },
      });
    }
    expect(createHoldTxLocked).not.toHaveBeenCalled();
  });

  it("type-FK consistency：PRODUCT 带 serviceListing / SERVICE 带 productId → fail closed", async () => {
    const crossA = makeProductTx({
      orderRow: { ...productOrderRow("ACCEPTED"), serviceListingId: "svc-1" },
    });
    expect(await initiateOrderDisputeTx(crossA.tx, baseInput)).toEqual({ error: "无效请求" });

    const crossB = makeTx({
      candidate: { type: "SERVICE", buyerId, sellerId, productId, serviceListingId: "svc-1", errandTaskId: null },
      orderRow: {
        id: orderId, type: "SERVICE", status: "ACCEPTED", buyerId, sellerId,
        productId, serviceListingId: "svc-1", errandTaskId: null,
      },
      listingCampusRow: productCampus,
    });
    expect(await initiateOrderDisputeTx(crossB.tx, baseInput)).toEqual({ error: "无效请求" });
  });

  it("锁序：candidate pre-read → sorted pair advisory 锁 → 行锁（ERRAND 先 Task 后 Order）", async () => {
    const product = makeProductTx({});
    await initiateOrderDisputeTx(product.tx, baseInput);
    const advisoryAt = product.queryRaw.mock.invocationCallOrder[0]!;
    expect(advisoryAt).toBeGreaterThan(product.orderFindUnique.mock.invocationCallOrder[0]!);

    const errand = makeTx({
      candidate: { type: "ERRAND", buyerId, sellerId, productId: null, serviceListingId: null, errandTaskId: errandId },
      errandRow: { id: errandId, status: "IN_PROGRESS", campusId: "campus-3", publisherId: buyerId, accepterId: sellerId },
      orderRow: {
        id: orderId, type: "ERRAND", status: "IN_PROGRESS", buyerId, sellerId,
        productId: null, serviceListingId: null, errandTaskId: errandId,
      },
    });
    await initiateOrderDisputeTx(errand.tx, baseInput);
    const [firstQuery, secondQuery] = errand.queryRaw.mock.invocationCallOrder;
    expect(errand.queryRaw.mock.calls[0]![0].join("|")).toContain('FROM "ErrandTask"');
    expect(errand.queryRaw.mock.calls[1]![0].join("|")).toContain('FROM "Order"');
    expect(firstQuery!).toBeLessThan(secondQuery!);
  });

  it("无 user-authored 内容泄漏：通知为 generic system copy", async () => {
    const m = makeProductTx({});
    await initiateOrderDisputeTx(m.tx, { ...baseInput, reason: "我的私人地址是……" });

    // Phase 9B：registry 渲染的通知行（每接收者一条 createMany）
    const rows = txNotificationCreateMany.mock.calls.map(
      (call) => call[0].data[0] as Record<string, unknown>,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain("我的私人地址");
    }
    expect(rows.map((row) => row.title as string).sort()).toEqual([
      "订单纠纷已提交",
      "订单进入纠纷流程",
    ]);
    // 角色化渲染：发起方（buyer）= 已提交；对手方（seller）= 进入纠纷流程
    expect(rows.find((row) => row.userId === buyerId)).toMatchObject({
      type: "ORDER",
      title: "订单纠纷已提交",
      content: "你的订单已进入纠纷处理流程。",
      orderId,
      dedupeKey: `ORDER_DISPUTE_OPENED:dispute-1:${buyerId}`,
      kind: "ORDER_DISPUTE_OPENED",
      payload: { orderId, disputeId: "dispute-1", initiatorUserId: buyerId },
    });
    expect(rows.find((row) => row.userId === sellerId)).toMatchObject({
      title: "订单进入纠纷流程",
      content: "该订单已被交易对方发起纠纷，请留意平台处理进展。",
      dedupeKey: `ORDER_DISPUTE_OPENED:dispute-1:${sellerId}`,
    });
  });
});

describe("RESTORE_PREVIOUS source 校验（isOpenedFromLegalDisputableSource）", () => {
  it("PRODUCT：ACCEPTED / COMPLETED 合法；PENDING / IN_DISPUTE / CLOSED 非法", () => {
    expect(isOpenedFromLegalDisputableSource({ orderType: "PRODUCT", openedFromOrderStatus: "ACCEPTED", openedFromErrandStatus: null })).toBe(true);
    expect(isOpenedFromLegalDisputableSource({ orderType: "PRODUCT", openedFromOrderStatus: "COMPLETED", openedFromErrandStatus: null })).toBe(true);
    expect(isOpenedFromLegalDisputableSource({ orderType: "PRODUCT", openedFromOrderStatus: "PENDING", openedFromErrandStatus: null })).toBe(false);
    expect(isOpenedFromLegalDisputableSource({ orderType: "PRODUCT", openedFromOrderStatus: "IN_DISPUTE", openedFromErrandStatus: null })).toBe(false);
    expect(isOpenedFromLegalDisputableSource({ orderType: "PRODUCT", openedFromOrderStatus: "CLOSED", openedFromErrandStatus: null })).toBe(false);
  });

  it("SERVICE：ACCEPTED / IN_PROGRESS / COMPLETED 合法；PENDING 非法", () => {
    for (const status of ["ACCEPTED", "IN_PROGRESS", "COMPLETED"]) {
      expect(isOpenedFromLegalDisputableSource({ orderType: "SERVICE", openedFromOrderStatus: status, openedFromErrandStatus: null })).toBe(true);
    }
    expect(isOpenedFromLegalDisputableSource({ orderType: "SERVICE", openedFromOrderStatus: "PENDING", openedFromErrandStatus: null })).toBe(false);
  });

  it("ERRAND：仅 canonical pair snapshot 合法（缺 Task snapshot = DENY）", () => {
    for (const [orderStatus, taskStatus] of DISPUTABLE_ERRAND_PAIRS) {
      expect(
        isOpenedFromLegalDisputableSource({
          orderType: "ERRAND",
          openedFromOrderStatus: orderStatus,
          openedFromErrandStatus: taskStatus,
        }),
      ).toBe(true);
    }
    expect(isOpenedFromLegalDisputableSource({ orderType: "ERRAND", openedFromOrderStatus: "IN_PROGRESS", openedFromErrandStatus: null })).toBe(false);
    expect(isOpenedFromLegalDisputableSource({ orderType: "ERRAND", openedFromOrderStatus: "COMPLETED", openedFromErrandStatus: "PENDING_CONFIRMATION" })).toBe(false);
  });
});

describe("ACTIVE_PRODUCT_ORDER_STATUSES（§44 冻结更新）", () => {
  it("包含 PENDING / ACCEPTED / IN_DISPUTE（dispute 期间保持 reservation occupancy）", () => {
    expect([...ACTIVE_PRODUCT_ORDER_STATUSES]).toEqual(["PENDING", "ACCEPTED", "IN_DISPUTE"]);
  });
});
