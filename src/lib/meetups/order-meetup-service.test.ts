import { beforeEach, describe, expect, it, vi } from "vitest";
// Phase 10F's real transaction guard is separately verified by
// feature-flag-guard.test.ts and Phase 10F real-PostgreSQL contracts.
// This legacy unit suite isolates its existing domain behavior only.
vi.mock("@/lib/feature-flags/feature-flag-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feature-flags/feature-flag-guard")>()),
  requireNewActivityAllowed: vi.fn().mockResolvedValue(undefined),
}));

import type { Prisma } from "@prisma/client";

const {
  assertActiveAccountMutationAllowed,
  acquireGovernanceSubjectLocks,
  createOrderDisputeFromLockedOrderTx,
} = vi.hoisted(() => ({
  assertActiveAccountMutationAllowed: vi.fn(),
  acquireGovernanceSubjectLocks: vi.fn(),
  createOrderDisputeFromLockedOrderTx: vi.fn(),
}));

vi.mock("@/lib/governance/active-account-mutation", () => ({
  assertActiveAccountMutationAllowed,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
}));

vi.mock("@/lib/order-dispute-machine", () => ({
  createOrderDisputeFromLockedOrderTx,
}));

import {
  MEETUP_NO_SHOW_DISPUTE_REASON,
  confirmOrderMeetupTx,
  markOrderMeetupArrivalTx,
  proposeOrderMeetupTx,
  reportOrderMeetupNoShowTx,
} from "@/lib/meetups/order-meetup-service";

/**
 * Phase 8D-01：meetup 状态机单元合同（D01-UNIT-03..18）。
 *
 * 锁序 / campus snapshot / partial unique / 原子性 / DataHold 见真实 PG
 * 集成测试（tests/integration/phase8d-01-order-meetup-domain.test.ts）。
 * 本文件用 hand-rolled fake tx 锁定状态机谓词矩阵与写入形状。
 */

const buyerId = "buyer-1";
const sellerId = "seller-1";
const orderId = "order-1";
const productId = "product-1";
const meetupId = "meetup-1";

// 时间基准必须是真实时钟的相对偏移（禁止固定日期——真实时间推移会翻转
// future/past 语义；精确边界语义由 meetup-policy.test.ts 用固定基准锁定）
const NOW = () => Date.now();

function future(offsetMs = 60 * 60 * 1000) {
  return new Date(NOW() + offsetMs);
}

function past(offsetMs = 60 * 60 * 1000) {
  return new Date(NOW() - offsetMs);
}

function makeTx(input: {
  candidate?: Record<string, unknown> | null;
  lockedOrder?: Record<string, unknown> | null;
  candidateMeetup?: Record<string, unknown> | null;
  lockedMeetup?: Record<string, unknown> | null;
  meetupPoint?: Record<string, unknown> | null;
  productCampus?: Record<string, unknown> | null;
  serviceCampus?: Record<string, unknown> | null;
  activeMeetup?: { id: string } | null;
  createdMeetupId?: string;
  disputeOutcome?: { success: true; disputeId: string } | { error: string };
}) {
  const orderFindUnique = vi.fn(async () => input.candidate ?? null);
  const meetupFindUnique = vi.fn(async () => input.candidateMeetup ?? null);
  const meetupFindFirst = vi.fn(async () => input.activeMeetup ?? null);
  const meetupCreate = vi.fn(async () => ({ id: input.createdMeetupId ?? "created-meetup-1" }));
  const meetupUpdateMany = vi.fn(async () => ({ count: 1 }));

  const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join("|") : String(strings);
    // 注意顺序：FROM "OrderMeetup" 必须先于 FROM "Order" 判定
    if (sql.includes('FROM "OrderMeetup"')) {
      return input.lockedMeetup ? [input.lockedMeetup] : [];
    }
    if (sql.includes('FROM "Order"')) {
      return input.lockedOrder ? [input.lockedOrder] : [];
    }
    return [];
  });

  const meetupPointFindUnique = vi.fn(async () => input.meetupPoint ?? null);
  const productFindUnique = vi.fn(async () => input.productCampus ?? null);
  const serviceFindUnique = vi.fn(async () => input.serviceCampus ?? null);

  const tx = {
    order: { findUnique: orderFindUnique },
    orderMeetup: {
      findUnique: meetupFindUnique,
      findFirst: meetupFindFirst,
      create: meetupCreate,
      updateMany: meetupUpdateMany,
    },
    meetupPoint: { findUnique: meetupPointFindUnique },
    product: { findUnique: productFindUnique },
    serviceListing: { findUnique: serviceFindUnique },
    $queryRaw: queryRaw,
    $executeRaw: vi.fn().mockResolvedValue(0),
  } as unknown as Prisma.TransactionClient;

  return {
    tx,
    meetupCreate,
    meetupUpdateMany,
    meetupFindFirst,
    meetupPointFindUnique,
    productFindUnique,
    serviceFindUnique,
    queryRaw,
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

function serviceOrderRow(status: string) {
  return {
    id: orderId,
    type: "SERVICE",
    status,
    buyerId,
    sellerId,
    productId: null,
    serviceListingId: "svc-1",
    errandTaskId: null,
  };
}

function errandOrderRow(status: string) {
  return {
    id: orderId,
    type: "ERRAND",
    status,
    buyerId,
    sellerId,
    productId: null,
    serviceListingId: null,
    errandTaskId: "errand-1",
  };
}

function confirmedMeetupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: meetupId,
    orderId,
    campusId: "campus-1",
    meetupPointId: null,
    locationTextSnapshot: "东门",
    scheduledAt: future(),
    status: "CONFIRMED",
    proposedById: buyerId,
    confirmedById: sellerId,
    buyerArrivedAt: null,
    sellerArrivedAt: null,
    ...overrides,
  };
}

const proposeInput = {
  orderId,
  proposerId: buyerId,
  scheduledAt: future(),
  locationText: "东门快递柜旁",
};

beforeEach(() => {
  assertActiveAccountMutationAllowed.mockReset().mockResolvedValue(undefined);
  acquireGovernanceSubjectLocks.mockReset().mockResolvedValue(undefined);
  createOrderDisputeFromLockedOrderTx.mockReset().mockResolvedValue({
    success: true,
    disputeId: "dispute-1",
  });
});

describe("proposeOrderMeetupTx：支持矩阵（D01-UNIT-03..08）", () => {
  it("D01-UNIT-03：PRODUCT ACCEPTED → PROPOSED 创建（campus 自 Product；snapshot 固化）", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      lockedOrder: productOrderRow("ACCEPTED"),
      productCampus: { campusId: "campus-1" },
    });

    const outcome = await proposeOrderMeetupTx(m.tx, proposeInput);

    expect(outcome).toEqual({
      success: true,
      meetupId: "created-meetup-1",
      campusId: "campus-1",
      locationTextSnapshot: "东门快递柜旁",
      status: "PROPOSED",
    });
    expect(m.meetupCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId,
          campusId: "campus-1",
          meetupPointId: null,
          locationTextSnapshot: "东门快递柜旁",
          locationSource: "CUSTOM",
          status: "PROPOSED",
          proposedById: buyerId,
        }),
      }),
    );
  });

  it("D01-UNIT-04：SERVICE ACCEPTED → allowed（campus 自 ServiceListing）", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      lockedOrder: serviceOrderRow("ACCEPTED"),
      serviceCampus: { campusId: "campus-2" },
    });

    const outcome = await proposeOrderMeetupTx(m.tx, proposeInput);

    expect(outcome).toMatchObject({ success: true, campusId: "campus-2" });
  });

  it("D01-UNIT-05：PRODUCT PENDING → denied（reservation lifecycle 禁入；零写入）", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      lockedOrder: productOrderRow("PENDING"),
      productCampus: { campusId: "campus-1" },
    });

    expect(await proposeOrderMeetupTx(m.tx, proposeInput)).toEqual({
      error: "MEETUP_INVALID_TRANSITION",
    });
    expect(m.meetupCreate).not.toHaveBeenCalled();
  });

  it("D01-UNIT-06：IN_PROGRESS → denied", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      lockedOrder: serviceOrderRow("IN_PROGRESS"),
      serviceCampus: { campusId: "campus-2" },
    });

    expect(await proposeOrderMeetupTx(m.tx, proposeInput)).toEqual({
      error: "MEETUP_INVALID_TRANSITION",
    });
    expect(m.meetupCreate).not.toHaveBeenCalled();
  });

  it("D01-UNIT-07：COMPLETED / IN_DISPUTE / CLOSED / CANCELLED → denied", async () => {
    const createMocks: ReturnType<typeof vi.fn>[] = [];
    for (const status of ["COMPLETED", "IN_DISPUTE", "CLOSED", "CANCELLED"]) {
      const m = makeTx({
        candidate: { buyerId, sellerId },
        lockedOrder: productOrderRow(status),
        productCampus: { campusId: "campus-1" },
      });
      createMocks.push(m.meetupCreate);

      expect(await proposeOrderMeetupTx(m.tx, proposeInput)).toEqual({
        error: "MEETUP_INVALID_TRANSITION",
      });
    }
    for (const create of createMocks) {
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("D01-UNIT-08：ERRAND → denied（不进入 meetup domain；零写入）", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      lockedOrder: errandOrderRow("ACCEPTED"),
    });

    expect(await proposeOrderMeetupTx(m.tx, proposeInput)).toEqual({
      error: "MEETUP_INVALID_TRANSITION",
    });
    expect(m.meetupCreate).not.toHaveBeenCalled();
  });
});

describe("confirm / cancel / 状态机", () => {
  it("D01-UNIT-09：proposer 不能自确认（MEETUP_FORBIDDEN）", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      candidateMeetup: { orderId },
      lockedOrder: productOrderRow("ACCEPTED"),
      lockedMeetup: confirmedMeetupRow({ status: "PROPOSED", proposedById: buyerId }),
      productCampus: { campusId: "campus-1" },
    });

    const outcome = await confirmOrderMeetupTx(m.tx, {
      orderId,
      meetupId,
      confirmerId: buyerId, // proposer 自己
    });

    expect(outcome).toEqual({ error: "MEETUP_FORBIDDEN" });
    expect(m.meetupUpdateMany).not.toHaveBeenCalled();
  });

  it("counterparty 确认成功 → CONFIRMED + confirmedById/confirmedAt 写入", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      candidateMeetup: { orderId },
      lockedOrder: productOrderRow("ACCEPTED"),
      lockedMeetup: confirmedMeetupRow({ status: "PROPOSED", proposedById: buyerId }),
      productCampus: { campusId: "campus-1" },
    });

    const outcome = await confirmOrderMeetupTx(m.tx, {
      orderId,
      meetupId,
      confirmerId: sellerId,
    });

    expect(outcome).toEqual({ success: true, status: "CONFIRMED" });
    expect(m.meetupUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: meetupId, status: "PROPOSED" },
        data: expect.objectContaining({
          status: "CONFIRMED",
          confirmedById: sellerId,
        }),
      }),
    );
  });

  it("非参与方 propose/confirm → MEETUP_FORBIDDEN", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      lockedOrder: productOrderRow("ACCEPTED"),
      productCampus: { campusId: "campus-1" },
    });

    expect(
      await proposeOrderMeetupTx(m.tx, { ...proposeInput, proposerId: "outsider-1" }),
    ).toEqual({ error: "MEETUP_FORBIDDEN" });

    const m2 = makeTx({
      candidate: { buyerId, sellerId },
      candidateMeetup: { orderId },
      lockedOrder: productOrderRow("ACCEPTED"),
      lockedMeetup: confirmedMeetupRow({ status: "PROPOSED" }),
      productCampus: { campusId: "campus-1" },
    });
    expect(
      await confirmOrderMeetupTx(m2.tx, { orderId, meetupId, confirmerId: "outsider-1" }),
    ).toEqual({ error: "MEETUP_FORBIDDEN" });
  });
});

describe("MeetupPoint 校验（D01-UNIT-10/11）", () => {
  it("D01-UNIT-10：cross-campus MeetupPoint → MEETUP_POINT_INVALID（零写入）", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      lockedOrder: productOrderRow("ACCEPTED"),
      productCampus: { campusId: "campus-1" },
      meetupPoint: { campusId: "campus-OTHER", isActive: true, locationText: "图书馆" },
    });

    expect(
      await proposeOrderMeetupTx(m.tx, { ...proposeInput, meetupPointId: "point-1" }),
    ).toEqual({ error: "MEETUP_POINT_INVALID" });
    expect(m.meetupCreate).not.toHaveBeenCalled();
  });

  it("D01-UNIT-11：inactive MeetupPoint → MEETUP_POINT_INVALID；catalog point 时客户端 locationText 不入 snapshot", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      lockedOrder: productOrderRow("ACCEPTED"),
      productCampus: { campusId: "campus-1" },
      meetupPoint: { campusId: "campus-1", isActive: false, locationText: "图书馆北门" },
    });

    expect(
      await proposeOrderMeetupTx(m.tx, {
        ...proposeInput,
        meetupPointId: "point-1",
        locationText: "伪造地点",
      }),
    ).toEqual({ error: "MEETUP_POINT_INVALID" });

    // 活跃 point：snapshot = point.locationText（不是客户端文本）
    const m2 = makeTx({
      candidate: { buyerId, sellerId },
      lockedOrder: productOrderRow("ACCEPTED"),
      productCampus: { campusId: "campus-1" },
      meetupPoint: { campusId: "campus-1", isActive: true, locationText: "图书馆北门" },
    });
    const outcome = await proposeOrderMeetupTx(m2.tx, {
      ...proposeInput,
      meetupPointId: "point-1",
      locationText: "伪造地点",
    });
    expect(outcome).toEqual({
      success: true,
      meetupId: "created-meetup-1",
      campusId: "campus-1",
      locationTextSnapshot: "图书馆北门",
      status: "PROPOSED",
    });
    expect(m2.meetupCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          meetupPointId: "point-1",
          locationTextSnapshot: "图书馆北门",
          locationSource: "MEETUP_POINT",
        }),
      }),
    );
  });
});

describe("arrival（D01-UNIT-12/13/17）", () => {
  it("D01-UNIT-12：arrival 只写 self 字段——买家只写 buyerArrivedAt；双方齐 → COMPLETED", async () => {
    // 买家首到：只写 buyerArrivedAt，status 保持 CONFIRMED
    const m = makeTx({
      candidate: { buyerId, sellerId },
      candidateMeetup: { orderId },
      lockedOrder: productOrderRow("ACCEPTED"),
      lockedMeetup: confirmedMeetupRow({ scheduledAt: past() }),
      productCampus: { campusId: "campus-1" },
    });

    const first = await markOrderMeetupArrivalTx(m.tx, { orderId, meetupId, actorId: buyerId });
    expect(first).toEqual({ success: true, status: "CONFIRMED", alreadyArrived: false });
    expect(m.meetupUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ buyerArrivedAt: expect.any(Date), status: "CONFIRMED" }),
      }),
    );

    // 卖家后到：写 sellerArrivedAt，status → COMPLETED
    const m2 = makeTx({
      candidate: { buyerId, sellerId },
      candidateMeetup: { orderId },
      lockedOrder: productOrderRow("ACCEPTED"),
      lockedMeetup: confirmedMeetupRow({
        scheduledAt: past(),
        buyerArrivedAt: past(),
      }),
      productCampus: { campusId: "campus-1" },
    });
    const second = await markOrderMeetupArrivalTx(m2.tx, { orderId, meetupId, actorId: sellerId });
    expect(second).toEqual({ success: true, status: "COMPLETED", alreadyArrived: false });
    expect(m2.meetupUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sellerArrivedAt: expect.any(Date), status: "COMPLETED" }),
      }),
    );
  });

  it("重复 self-arrival 幂等（alreadyArrived，不重写时间）", async () => {
    const arrivedAt = past();
    const m = makeTx({
      candidate: { buyerId, sellerId },
      candidateMeetup: { orderId },
      lockedOrder: productOrderRow("ACCEPTED"),
      lockedMeetup: confirmedMeetupRow({ scheduledAt: past(10), buyerArrivedAt: arrivedAt }),
      productCampus: { campusId: "campus-1" },
    });

    const outcome = await markOrderMeetupArrivalTx(m.tx, { orderId, meetupId, actorId: buyerId });
    expect(outcome).toEqual({ success: true, status: "CONFIRMED", alreadyArrived: true });
    expect(m.meetupUpdateMany).not.toHaveBeenCalled();
  });

  it("D01-UNIT-13：提前 arrival（now < scheduledAt）→ MEETUP_TIME_WINDOW", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      candidateMeetup: { orderId },
      lockedOrder: productOrderRow("ACCEPTED"),
      lockedMeetup: confirmedMeetupRow({ scheduledAt: future() }),
      productCampus: { campusId: "campus-1" },
    });

    expect(await markOrderMeetupArrivalTx(m.tx, { orderId, meetupId, actorId: buyerId })).toEqual({
      error: "MEETUP_TIME_WINDOW",
    });
    expect(m.meetupUpdateMany).not.toHaveBeenCalled();
  });

  it("D01-UNIT-17：Meetup COMPLETED 不 mutation Order（无 Order 状态写、无 dispute、无 Product 触碰）", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      candidateMeetup: { orderId },
      lockedOrder: productOrderRow("ACCEPTED"),
      lockedMeetup: confirmedMeetupRow({ scheduledAt: past(), buyerArrivedAt: past() }),
      productCampus: { campusId: "campus-1" },
    });
    const orderUpdate = vi.fn();
    (m.tx as { order: { update: unknown } }).order.update = orderUpdate;

    const outcome = await markOrderMeetupArrivalTx(m.tx, { orderId, meetupId, actorId: sellerId });
    expect(outcome).toEqual({ success: true, status: "COMPLETED", alreadyArrived: false });
    expect(orderUpdate).not.toHaveBeenCalled();
    expect(createOrderDisputeFromLockedOrderTx).not.toHaveBeenCalled();
  });
});

describe("no-show（D01-UNIT-14/15/16）", () => {
  function noShowTx(meetupOverrides: Record<string, unknown>) {
    return makeTx({
      candidate: { buyerId, sellerId },
      candidateMeetup: { orderId },
      lockedOrder: productOrderRow("ACCEPTED"),
      lockedMeetup: confirmedMeetupRow({
        scheduledAt: past(20 * 60 * 1000), // 已过 15min grace
        buyerArrivedAt: past(30 * 60 * 1000),
        ...meetupOverrides,
      }),
      productCampus: { campusId: "campus-1" },
    });
  }

  it("D01-UNIT-14：grace 内报告 → MEETUP_TIME_WINDOW（零写入、无 dispute）", async () => {
    const m = makeTx({
      candidate: { buyerId, sellerId },
      candidateMeetup: { orderId },
      lockedOrder: productOrderRow("ACCEPTED"),
      lockedMeetup: confirmedMeetupRow({
        scheduledAt: future(), // 尚未到点
        buyerArrivedAt: past(),
      }),
      productCampus: { campusId: "campus-1" },
    });

    expect(await reportOrderMeetupNoShowTx(m.tx, { orderId, meetupId, reporterId: buyerId })).toEqual(
      { error: "MEETUP_TIME_WINDOW" },
    );
    expect(m.meetupUpdateMany).not.toHaveBeenCalled();
    expect(createOrderDisputeFromLockedOrderTx).not.toHaveBeenCalled();
  });

  it("D01-UNIT-15：reporter 未 self-arrival → denied（自己没签到不能报告对方爽约）", async () => {
    const m = noShowTx({ buyerArrivedAt: null });

    expect(await reportOrderMeetupNoShowTx(m.tx, { orderId, meetupId, reporterId: buyerId })).toEqual(
      { error: "MEETUP_INVALID_TRANSITION" },
    );
    expect(m.meetupUpdateMany).not.toHaveBeenCalled();
    expect(createOrderDisputeFromLockedOrderTx).not.toHaveBeenCalled();
  });

  it("D01-UNIT-16：target 已到场 → denied", async () => {
    const m = noShowTx({ sellerArrivedAt: past(10) });

    expect(await reportOrderMeetupNoShowTx(m.tx, { orderId, meetupId, reporterId: buyerId })).toEqual(
      { error: "MEETUP_INVALID_TRANSITION" },
    );
    expect(m.meetupUpdateMany).not.toHaveBeenCalled();
    expect(createOrderDisputeFromLockedOrderTx).not.toHaveBeenCalled();
  });

  it("成功报告 → 原子 composition：固定 reason + triggeredDisputeId + NO_SHOW_REPORTED 写入", async () => {
    const m = noShowTx({});

    const outcome = await reportOrderMeetupNoShowTx(m.tx, { orderId, meetupId, reporterId: buyerId });

    expect(outcome).toEqual({ success: true, disputeId: "dispute-1", status: "NO_SHOW_REPORTED" });
    expect(createOrderDisputeFromLockedOrderTx).toHaveBeenCalledTimes(1);
    expect(createOrderDisputeFromLockedOrderTx).toHaveBeenCalledWith(
      m.tx,
      expect.objectContaining({
        order: expect.objectContaining({ id: orderId, status: "ACCEPTED", type: "PRODUCT" }),
        lockedErrand: null,
        initiatorId: buyerId,
        reason: MEETUP_NO_SHOW_DISPUTE_REASON,
        evidencePhotos: [],
      }),
    );
    expect(m.meetupUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: meetupId, status: "CONFIRMED" },
        data: expect.objectContaining({
          status: "NO_SHOW_REPORTED",
          noShowReportedById: buyerId,
          noShowTargetId: sellerId,
          triggeredDisputeId: "dispute-1",
        }),
      }),
    );
  });

  it("非 CONFIRMED 状态不可报告（COMPLETED / CANCELLED / NO_SHOW_REPORTED）", async () => {
    for (const status of ["COMPLETED", "CANCELLED", "NO_SHOW_REPORTED", "PROPOSED"]) {
      const m = noShowTx({ status });
      expect(
        await reportOrderMeetupNoShowTx(m.tx, { orderId, meetupId, reporterId: buyerId }),
      ).toEqual({ error: "MEETUP_INVALID_TRANSITION" });
    }
    expect(createOrderDisputeFromLockedOrderTx).not.toHaveBeenCalled();
  });
});

describe("active meetup 唯一性 / 重开（D01-UNIT-18）", () => {
  it("D01-UNIT-18：CANCELLED 不在 active 集 → 允许 reproposal；active 存在 → MEETUP_ACTIVE_EXISTS", async () => {
    // findFirst 只查 active 集：CANCELLED 历史 → null → 成功
    const m = makeTx({
      candidate: { buyerId, sellerId },
      lockedOrder: productOrderRow("ACCEPTED"),
      productCampus: { campusId: "campus-1" },
      activeMeetup: null,
    });
    expect(await proposeOrderMeetupTx(m.tx, proposeInput)).toMatchObject({ success: true });

    // active（PROPOSED / CONFIRMED / COMPLETED / NO_SHOW_REPORTED）→ DENY
    // （findFirst 只查 active 集；具体 status 由集成测试真实行覆盖）
    for (const status of ["PROPOSED", "CONFIRMED", "COMPLETED", "NO_SHOW_REPORTED"]) {
      const m2 = makeTx({
        candidate: { buyerId, sellerId },
        lockedOrder: productOrderRow("ACCEPTED"),
        productCampus: { campusId: "campus-1" },
        activeMeetup: { id: `existing-active-${status}` },
      });
      expect(await proposeOrderMeetupTx(m2.tx, proposeInput)).toEqual({
        error: "MEETUP_ACTIVE_EXISTS",
      });
      expect(m2.meetupCreate).not.toHaveBeenCalled();
    }
  });
});
