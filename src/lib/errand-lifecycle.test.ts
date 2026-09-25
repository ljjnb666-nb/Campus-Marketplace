import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const {
  assertActiveAccountMutationAllowed,
  requireMarketplaceCapability,
  completeErrandOrderTx,
  createNotifications,
} = vi.hoisted(() => ({
  assertActiveAccountMutationAllowed: vi.fn(),
  requireMarketplaceCapability: vi.fn(),
  completeErrandOrderTx: vi.fn(),
  createNotifications: vi.fn(),
}));

vi.mock("@/lib/governance/active-account-mutation", () => ({
  assertActiveAccountMutationAllowed,
}));

vi.mock("@/lib/enforcement/capability-gate", () => ({
  requireMarketplaceCapability,
}));

vi.mock("@/lib/errand-completion", () => ({
  completeErrandOrderTx,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotifications,
}));

import {
  ACTIVE_ERRAND_ORDER_STATUSES,
  deleteErrandTx,
  transitionErrandOrderTx,
  transitionErrandTx,
  updateErrandContentTx,
} from "@/lib/errand-lifecycle";
import { updateErrandStatusTx } from "@/lib/errand-status-service";

/**
 * AUDIT2-RB02：errand lifecycle authority 单元合同。
 *
 * canonical state pairs：
 *   OPEN ↔ 无 active ERRAND order / CLAIMED ↔ ACCEPTED /
 *   IN_PROGRESS ↔ IN_PROGRESS / PENDING_CONFIRMATION ↔ IN_PROGRESS /
 *   COMPLETED ↔ COMPLETED。
 *
 * 冻结不变量：Task + active Order 由 ONE CANONICAL AUTHORITY 同时决定；
 * 锁序 USER advisory → ErrandTask FOR UPDATE → Order FOR UPDATE；异常数据
 * （0 / >1 active order、Task/Order pair 失配、candidate 参与者失配）一律
 * fail closed 零写入。
 */

const PUBLISHER = "user-publisher";
const ACCEPTER = "user-accepter";
const ERRAND_ID = "errand-1";
const ORDER_ID = "order-1";
const CAMPUS_ID = "campus-1";

type TxMocks = {
  tx: Prisma.TransactionClient;
  executeRaw: ReturnType<typeof vi.fn>;
  queryRaw: ReturnType<typeof vi.fn>;
  taskUpdateMany: ReturnType<typeof vi.fn>;
  taskUpdate: ReturnType<typeof vi.fn>;
  orderUpdateMany: ReturnType<typeof vi.fn>;
  orderFindFirst: ReturnType<typeof vi.fn>;
};

function makeTx(input: {
  /** ErrandTask FOR UPDATE 权威行（默认 CLAIMED + accepter） */
  errandRow?: Record<string, unknown> | null;
  /** 事务外 candidate 发现行（默认与 errandRow 一致；stale candidate 用） */
  candidateRow?: Record<string, unknown> | null;
  /** active ERRAND order 行集（默认恰 1 个 ACCEPTED） */
  activeOrderRows?: Record<string, unknown>[] | null;
  /** OPEN → CANCELLED 的历史订单通知挂载点 */
  historicalOrder?: Record<string, unknown> | null;
  taskTransitionCount?: number;
  orderTransitionCount?: number;
} = {}): TxMocks {
  const defaultErrand = {
    id: ERRAND_ID,
    campusId: CAMPUS_ID,
    status: "CLAIMED",
    publisherId: PUBLISHER,
    accepterId: ACCEPTER,
    deletedAt: null,
  };
  const errandRow = input.errandRow === undefined ? defaultErrand : input.errandRow;
  const candidateRow =
    input.candidateRow === undefined ? errandRow : input.candidateRow;
  const defaultOrders = [
    { id: ORDER_ID, status: "ACCEPTED", buyerId: PUBLISHER, sellerId: ACCEPTER },
  ];
  const activeOrderRows =
    input.activeOrderRows === undefined ? defaultOrders : input.activeOrderRows;

  const executeRaw = vi.fn().mockResolvedValue(0);
  const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
    if (sql.includes('FROM "ErrandTask"')) {
      if (sql.includes("FOR UPDATE")) {
        return errandRow ? [errandRow] : [];
      }
      // candidate discovery：真实 SQL 含 deletedAt IS NULL
      return candidateRow && candidateRow.deletedAt == null ? [candidateRow] : [];
    }
    if (sql.includes('FROM "Order"')) {
      return activeOrderRows ?? [];
    }
    return [];
  });
  const taskUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: input.taskTransitionCount ?? 1 });
  const taskUpdate = vi.fn().mockResolvedValue({});
  const orderUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: input.orderTransitionCount ?? 1 });
  const orderFindFirst = vi
    .fn()
    .mockResolvedValue(input.historicalOrder ?? null);

  const tx = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    errandTask: {
      updateMany: taskUpdateMany,
      update: taskUpdate,
    },
    order: {
      updateMany: orderUpdateMany,
      findFirst: orderFindFirst,
    },
  } as unknown as Prisma.TransactionClient;

  return {
    tx,
    executeRaw,
    queryRaw,
    taskUpdateMany,
    taskUpdate,
    orderUpdateMany,
    orderFindFirst,
  };
}

const errandContent = {
  title: "帮我取快递（改）",
  description: "东区快递站两个中号包裹，今晚前送到宿舍楼下（改）。",
  categoryId: "errand-category-1",
  reward: { toString: () => "9.00" } as unknown as Prisma.Decimal,
  pickupLocation: "东区快递站",
  deliveryLocation: "6 号宿舍楼下",
  deadline: new Date("2026-12-31T00:00:00.000Z"),
  contactNote: "到了发消息",
  needsAdvancePay: false,
  advanceAmount: null,
};

beforeEach(() => {
  assertActiveAccountMutationAllowed.mockReset().mockResolvedValue(undefined);
  requireMarketplaceCapability.mockReset().mockResolvedValue(undefined);
  completeErrandOrderTx.mockReset().mockResolvedValue({ completed: true });
  createNotifications.mockReset().mockResolvedValue(undefined);
});

describe("transitionErrandTx（canonical state pairs）", () => {
  it("CLAIMED→OPEN：publisher + 恰 1 个 ACCEPTED order → Task OPEN/accepter null + Order CANCELLED + capability", async () => {
    const m = makeTx();

    const ok = await transitionErrandTx(m.tx, PUBLISHER, ERRAND_ID, "OPEN");

    expect(ok).toBe(true);
    expect(requireMarketplaceCapability).toHaveBeenCalledWith(
      m.tx,
      PUBLISHER,
      CAMPUS_ID,
      "START_NEW_MARKETPLACE_ACTIVITY",
    );
    expect(m.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: ERRAND_ID, status: "CLAIMED" },
      data: { status: "OPEN", accepterId: null },
    });
    expect(m.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, status: "ACCEPTED" },
      data: { status: "CANCELLED", cancelReason: "发布者撤销接单" },
    });
    expect(createNotifications).toHaveBeenCalledTimes(1);
    const payloads = createNotifications.mock.calls[0]![1] as Array<{ userId: string }>;
    expect(payloads.map((p) => p.userId).sort()).toEqual([ACCEPTER, PUBLISHER]);
  });

  it("CLAIMED→IN_PROGRESS：accepter → Task IN_PROGRESS + Order IN_PROGRESS（无 capability）", async () => {
    const m = makeTx();

    const ok = await transitionErrandTx(m.tx, ACCEPTER, ERRAND_ID, "IN_PROGRESS");

    expect(ok).toBe(true);
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
    expect(m.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: ERRAND_ID, status: "CLAIMED" },
      data: { status: "IN_PROGRESS" },
    });
    expect(m.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, status: "ACCEPTED" },
      data: { status: "IN_PROGRESS" },
    });
    expect(createNotifications).toHaveBeenCalledTimes(1);
  });

  it("IN_PROGRESS→PENDING_CONFIRMATION：accepter → 仅 Task 更新，Order 保持 IN_PROGRESS", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "IN_PROGRESS",
        publisherId: PUBLISHER,
        accepterId: ACCEPTER,
        deletedAt: null,
      },
      activeOrderRows: [
        { id: ORDER_ID, status: "IN_PROGRESS", buyerId: PUBLISHER, sellerId: ACCEPTER },
      ],
    });

    const ok = await transitionErrandTx(
      m.tx,
      ACCEPTER,
      ERRAND_ID,
      "PENDING_CONFIRMATION",
    );

    expect(ok).toBe(true);
    expect(m.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: ERRAND_ID, status: "IN_PROGRESS" },
      data: { status: "PENDING_CONFIRMATION" },
    });
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
    expect(createNotifications).toHaveBeenCalledTimes(1);
  });

  it("PENDING_CONFIRMATION→COMPLETED：publisher → 委派唯一 completeErrandOrderTx，不叠加 Task/Order 写", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "PENDING_CONFIRMATION",
        publisherId: PUBLISHER,
        accepterId: ACCEPTER,
        deletedAt: null,
      },
      activeOrderRows: [
        { id: ORDER_ID, status: "IN_PROGRESS", buyerId: PUBLISHER, sellerId: ACCEPTER },
      ],
    });

    const ok = await transitionErrandTx(m.tx, PUBLISHER, ERRAND_ID, "COMPLETED");

    expect(ok).toBe(true);
    expect(completeErrandOrderTx).toHaveBeenCalledWith(m.tx, {
      orderId: ORDER_ID,
      errandTaskId: ERRAND_ID,
      buyerId: PUBLISHER,
      sellerId: ACCEPTER,
    });
    expect(m.taskUpdateMany).not.toHaveBeenCalled();
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("OPEN→CANCELLED：publisher + 无 active order → Task CANCELLED；无订单无通知", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [],
    });

    const ok = await transitionErrandTx(m.tx, PUBLISHER, ERRAND_ID, "CANCELLED");

    expect(ok).toBe(true);
    expect(m.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: ERRAND_ID, status: "OPEN" },
      data: { status: "CANCELLED" },
    });
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
    expect(m.orderFindFirst).toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("OPEN→CANCELLED：存在历史订单时通知挂载其上（既有行为）", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [],
      historicalOrder: { id: "order-old", sellerId: ACCEPTER },
    });

    const ok = await transitionErrandTx(m.tx, PUBLISHER, ERRAND_ID, "CANCELLED");

    expect(ok).toBe(true);
    expect(createNotifications).toHaveBeenCalledTimes(1);
    const payloads = createNotifications.mock.calls[0]![1] as Array<{
      userId: string;
      orderId: string;
    }>;
    expect(payloads.every((p) => p.orderId === "order-old")).toBe(true);
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("wrong role：accepter 请求 OPEN / publisher 请求 IN_PROGRESS / accepter 请求 COMPLETED → 全部 NO-OP", async () => {
    const claimed = makeTx();
    expect(await transitionErrandTx(claimed.tx, ACCEPTER, ERRAND_ID, "OPEN")).toBe(false);
    const claimed2 = makeTx();
    expect(
      await transitionErrandTx(claimed2.tx, PUBLISHER, ERRAND_ID, "IN_PROGRESS"),
    ).toBe(false);
    const pending = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "PENDING_CONFIRMATION",
        publisherId: PUBLISHER,
        accepterId: ACCEPTER,
        deletedAt: null,
      },
      activeOrderRows: [
        { id: ORDER_ID, status: "IN_PROGRESS", buyerId: PUBLISHER, sellerId: ACCEPTER },
      ],
    });
    expect(
      await transitionErrandTx(pending.tx, ACCEPTER, ERRAND_ID, "COMPLETED"),
    ).toBe(false);

    expect(claimed.taskUpdateMany).not.toHaveBeenCalled();
    expect(claimed2.taskUpdateMany).not.toHaveBeenCalled();
    expect(pending.taskUpdateMany).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("stale candidate：candidate 与锁内 fresh row 参与者失配 → fail closed 零写", async () => {
    // candidate 看到 CLAIMED + accepter（发现时）；锁内 fresh 已回到 OPEN
    // （accepter null，如并发 reopen 已提交）→ 参与者失配 fail closed
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: null,
      },
      candidateRow: {
        id: ERRAND_ID,
        publisherId: PUBLISHER,
        accepterId: ACCEPTER,
      },
      activeOrderRows: [],
    });

    const ok = await transitionErrandTx(m.tx, PUBLISHER, ERRAND_ID, "OPEN");

    expect(ok).toBe(false);
    expect(m.taskUpdateMany).not.toHaveBeenCalled();
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("missing active order：CLAIMED 但 0 个 active order → START / REOPEN fail closed", async () => {
    const start = makeTx({ activeOrderRows: [] });
    expect(
      await transitionErrandTx(start.tx, ACCEPTER, ERRAND_ID, "IN_PROGRESS"),
    ).toBe(false);
    const reopen = makeTx({ activeOrderRows: [] });
    expect(await transitionErrandTx(reopen.tx, PUBLISHER, ERRAND_ID, "OPEN")).toBe(false);

    expect(start.taskUpdateMany).not.toHaveBeenCalled();
    expect(reopen.taskUpdateMany).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("multiple active orders：CLAIMED + 2 个 active order → fail closed，不猜 latest", async () => {
    const m = makeTx({
      activeOrderRows: [
        { id: "order-a", status: "ACCEPTED", buyerId: PUBLISHER, sellerId: ACCEPTER },
        { id: "order-b", status: "ACCEPTED", buyerId: PUBLISHER, sellerId: ACCEPTER },
      ],
    });

    const ok = await transitionErrandTx(m.tx, ACCEPTER, ERRAND_ID, "IN_PROGRESS");

    expect(ok).toBe(false);
    expect(m.taskUpdateMany).not.toHaveBeenCalled();
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("Task/Order pair mismatch：Task CLAIMED + Order IN_PROGRESS → START fail closed", async () => {
    const m = makeTx({
      activeOrderRows: [
        { id: ORDER_ID, status: "IN_PROGRESS", buyerId: PUBLISHER, sellerId: ACCEPTER },
      ],
    });

    const ok = await transitionErrandTx(m.tx, ACCEPTER, ERRAND_ID, "IN_PROGRESS");

    expect(ok).toBe(false);
    expect(m.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("OPEN + active order（数据异常）→ CANCELLED fail closed", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [
        { id: ORDER_ID, status: "ACCEPTED", buyerId: PUBLISHER, sellerId: ACCEPTER },
      ],
    });

    const ok = await transitionErrandTx(m.tx, PUBLISHER, ERRAND_ID, "CANCELLED");

    expect(ok).toBe(false);
    expect(m.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("请求 CLAIMED / 未知状态 → 直接 NO-OP（无任何行写入路径）", async () => {
    const m = makeTx();

    expect(await transitionErrandTx(m.tx, ACCEPTER, ERRAND_ID, "CLAIMED")).toBe(false);

    expect(m.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("candidate 缺失 / 锁内行缺失 / 软删除 → false", async () => {
    const missing = makeTx({ candidateRow: null, errandRow: null });
    expect(await transitionErrandTx(missing.tx, PUBLISHER, ERRAND_ID, "OPEN")).toBe(false);

    const deleted = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "CLAIMED",
        publisherId: PUBLISHER,
        accepterId: ACCEPTER,
        deletedAt: new Date(),
      },
    });
    expect(await transitionErrandTx(deleted.tx, PUBLISHER, ERRAND_ID, "OPEN")).toBe(false);

    expect(missing.taskUpdateMany).not.toHaveBeenCalled();
    expect(deleted.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("actor lifecycle 非 ACTIVE → AUTH_ACCOUNT_INACTIVE，零 Task/Order/Notification 写", async () => {
    assertActiveAccountMutationAllowed.mockRejectedValue(
      Object.assign(new Error("账号当前不可用"), { code: "AUTH_ACCOUNT_INACTIVE" }),
    );
    const m = makeTx();

    await expect(
      transitionErrandTx(m.tx, ACCEPTER, ERRAND_ID, "IN_PROGRESS"),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    expect(m.taskUpdateMany).not.toHaveBeenCalled();
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("锁序：sorted participant advisory 锁 → ErrandTask 行锁 → Order 行锁", async () => {
    const m = makeTx();

    await transitionErrandTx(m.tx, ACCEPTER, ERRAND_ID, "IN_PROGRESS");

    // queryRaw 调用序：[0] = candidate discovery（锁前），[1] = ErrandTask
    // FOR UPDATE，[2] = Order FOR UPDATE
    const firstAdvisory = m.executeRaw.mock.invocationCallOrder[0]!;
    const lastAdvisory = m.executeRaw.mock.invocationCallOrder[1]!;
    const errandRowLock = m.queryRaw.mock.invocationCallOrder[1]!;
    const orderRowLock = m.queryRaw.mock.invocationCallOrder[2]!;
    expect(firstAdvisory).toBeLessThan(errandRowLock);
    expect(lastAdvisory).toBeLessThan(errandRowLock);
    expect(errandRowLock).toBeLessThan(orderRowLock);
    // publisher + accepter 一次性完整取得（升序两把），禁止 actor 锁后追加
    expect(m.executeRaw).toHaveBeenCalledTimes(2);
  });
});

describe("transitionErrandOrderTx（订单中心委派）", () => {
  const orderCandidate = {
    errandTaskId: ERRAND_ID,
    buyerId: PUBLISHER,
    sellerId: ACCEPTER,
  };

  it("ERRAND ACCEPTED→IN_PROGRESS：accepter → Task + Order IN_PROGRESS + canonical 通知", async () => {
    const m = makeTx();

    const outcome = await transitionErrandOrderTx(
      m.tx,
      ACCEPTER,
      ORDER_ID,
      orderCandidate,
      "IN_PROGRESS",
    );

    expect(outcome).toEqual({ isBuyer: false });
    expect(m.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: ERRAND_ID, status: "CLAIMED" },
      data: { status: "IN_PROGRESS" },
    });
    expect(m.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, status: "ACCEPTED" },
      data: { status: "IN_PROGRESS" },
    });
    expect(createNotifications).toHaveBeenCalledTimes(1);
    const payloads = createNotifications.mock.calls[0]![1] as Array<{ title: string }>;
    expect(payloads[0]!.title).toContain("跑腿任务状态更新");
  });

  it("ERRAND COMPLETED：publisher → 委派唯一 completeErrandOrderTx", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "PENDING_CONFIRMATION",
        publisherId: PUBLISHER,
        accepterId: ACCEPTER,
        deletedAt: null,
      },
      activeOrderRows: [
        { id: ORDER_ID, status: "IN_PROGRESS", buyerId: PUBLISHER, sellerId: ACCEPTER },
      ],
    });

    const outcome = await transitionErrandOrderTx(
      m.tx,
      PUBLISHER,
      ORDER_ID,
      orderCandidate,
      "COMPLETED",
    );

    expect(outcome).toEqual({ isBuyer: true });
    expect(completeErrandOrderTx).toHaveBeenCalledWith(m.tx, {
      orderId: ORDER_ID,
      errandTaskId: ERRAND_ID,
      buyerId: PUBLISHER,
      sellerId: ACCEPTER,
    });
    expect(m.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("请求的 order 不是当前 active obligation（id 失配）→ null", async () => {
    const m = makeTx();

    const outcome = await transitionErrandOrderTx(
      m.tx,
      ACCEPTER,
      "order-other",
      orderCandidate,
      "IN_PROGRESS",
    );

    expect(outcome).toBeNull();
    expect(m.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("order candidate 与 ErrandTask 参与者失配 → null", async () => {
    const m = makeTx();

    const outcome = await transitionErrandOrderTx(
      m.tx,
      ACCEPTER,
      ORDER_ID,
      { ...orderCandidate, sellerId: "someone-else" },
      "IN_PROGRESS",
    );

    expect(outcome).toBeNull();
    expect(m.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("wrong role：publisher 走订单中心 START → null；accepter 走订单中心 COMPLETED → null", async () => {
    const start = makeTx();
    expect(
      await transitionErrandOrderTx(start.tx, PUBLISHER, ORDER_ID, orderCandidate, "IN_PROGRESS"),
    ).toBeNull();
    const complete = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "PENDING_CONFIRMATION",
        publisherId: PUBLISHER,
        accepterId: ACCEPTER,
        deletedAt: null,
      },
      activeOrderRows: [
        { id: ORDER_ID, status: "IN_PROGRESS", buyerId: PUBLISHER, sellerId: ACCEPTER },
      ],
    });
    expect(
      await transitionErrandOrderTx(complete.tx, ACCEPTER, ORDER_ID, orderCandidate, "COMPLETED"),
    ).toBeNull();

    expect(start.taskUpdateMany).not.toHaveBeenCalled();
    expect(complete.taskUpdateMany).not.toHaveBeenCalled();
    expect(completeErrandOrderTx).not.toHaveBeenCalled();
  });
});

describe("updateErrandContentTx（fresh OPEN 权威）", () => {
  it("fresh OPEN + 发布者 → UPDATED + MODIFY_PUBLIC_LISTING_CONTENT capability + 内容写入", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [],
    });

    const outcome = await updateErrandContentTx(m.tx, PUBLISHER, ERRAND_ID, errandContent);

    expect(outcome).toBe("UPDATED");
    expect(requireMarketplaceCapability).toHaveBeenCalledWith(
      m.tx,
      PUBLISHER,
      CAMPUS_ID,
      "MODIFY_PUBLIC_LISTING_CONTENT",
    );
    expect(m.taskUpdate).toHaveBeenCalledWith({
      where: { id: ERRAND_ID },
      data: errandContent,
    });
  });

  it("edit-after-claim：事务外看到 OPEN、锁内 fresh CLAIMED → NOT_OPEN 零写（绝不 success）", async () => {
    const m = makeTx();

    const outcome = await updateErrandContentTx(m.tx, PUBLISHER, ERRAND_ID, errandContent);

    expect(outcome).toBe("NOT_OPEN");
    expect(m.taskUpdate).not.toHaveBeenCalled();
  });

  it("非发布者 / 软删除 → MISSING 同形零写", async () => {
    const other = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: "someone-else",
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [],
    });
    expect(
      await updateErrandContentTx(other.tx, PUBLISHER, ERRAND_ID, errandContent),
    ).toBe("MISSING");

    const deleted = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: new Date(),
      },
      activeOrderRows: [],
    });
    expect(
      await updateErrandContentTx(deleted.tx, PUBLISHER, ERRAND_ID, errandContent),
    ).toBe("MISSING");

    expect(other.taskUpdate).not.toHaveBeenCalled();
    expect(deleted.taskUpdate).not.toHaveBeenCalled();
  });

  it("OPEN + active order（数据异常）→ fail closed NOT_OPEN 零写", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [
        { id: ORDER_ID, status: "ACCEPTED", buyerId: PUBLISHER, sellerId: ACCEPTER },
      ],
    });

    const outcome = await updateErrandContentTx(m.tx, PUBLISHER, ERRAND_ID, errandContent);

    expect(outcome).toBe("NOT_OPEN");
    expect(m.taskUpdate).not.toHaveBeenCalled();
  });

  it("capability 拒绝 → 抛 MARKETPLACE_RESTRICTED，零内容写", async () => {
    requireMarketplaceCapability.mockRejectedValue(
      Object.assign(new Error("受限"), { code: "MARKETPLACE_RESTRICTED" }),
    );
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [],
    });

    await expect(
      updateErrandContentTx(m.tx, PUBLISHER, ERRAND_ID, errandContent),
    ).rejects.toMatchObject({ code: "MARKETPLACE_RESTRICTED" });
    expect(m.taskUpdate).not.toHaveBeenCalled();
  });
});

describe("deleteErrandTx（事务级删除权威）", () => {
  it("OPEN + 发布者 + 无 active order → DELETED（deletedAt + CANCELLED + accepterId null）", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [],
    });

    const outcome = await deleteErrandTx(m.tx, PUBLISHER, ERRAND_ID);

    expect(outcome).toBe("DELETED");
    expect(m.taskUpdate).toHaveBeenCalledWith({
      where: { id: ERRAND_ID },
      data: {
        deletedAt: expect.any(Date),
        status: "CANCELLED",
        accepterId: null,
      },
    });
  });

  it("CANCELLED 历史任务可删除", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "CANCELLED",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [],
    });

    const outcome = await deleteErrandTx(m.tx, PUBLISHER, ERRAND_ID);

    expect(outcome).toBe("DELETED");
  });

  it("CLAIMED / IN_PROGRESS / COMPLETED → NOT_DELETABLE 零写", async () => {
    for (const status of ["CLAIMED", "IN_PROGRESS", "COMPLETED"]) {
      const m = makeTx({
        errandRow: {
          id: ERRAND_ID,
          campusId: CAMPUS_ID,
          status,
          publisherId: PUBLISHER,
          accepterId: ACCEPTER,
          deletedAt: null,
        },
      });

      expect(await deleteErrandTx(m.tx, PUBLISHER, ERRAND_ID)).toBe("NOT_DELETABLE");
      expect(m.taskUpdate).not.toHaveBeenCalled();
    }
  });

  it("非发布者 / 缺失 / 软删除 → MISSING 零写", async () => {
    const other = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: "someone-else",
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [],
    });
    expect(await deleteErrandTx(other.tx, PUBLISHER, ERRAND_ID)).toBe("MISSING");

    const missing = makeTx({ candidateRow: null, errandRow: null });
    expect(await deleteErrandTx(missing.tx, PUBLISHER, ERRAND_ID)).toBe("MISSING");

    expect(other.taskUpdate).not.toHaveBeenCalled();
    expect(missing.taskUpdate).not.toHaveBeenCalled();
  });

  it("OPEN/CANCELLED + active order（数据异常）→ ANOMALOUS_ACTIVE_ORDER fail closed 零写", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [
        { id: ORDER_ID, status: "ACCEPTED", buyerId: PUBLISHER, sellerId: ACCEPTER },
      ],
    });

    const outcome = await deleteErrandTx(m.tx, PUBLISHER, ERRAND_ID);

    expect(outcome).toBe("ANOMALOUS_ACTIVE_ORDER");
    expect(m.taskUpdate).not.toHaveBeenCalled();
  });

  it("delete vs claim 锁序：delete 持 publisher 锁 → claim 线性化（同一 publisher 锁域）", async () => {
    const m = makeTx({
      errandRow: {
        id: ERRAND_ID,
        campusId: CAMPUS_ID,
        status: "OPEN",
        publisherId: PUBLISHER,
        accepterId: null,
        deletedAt: null,
      },
      activeOrderRows: [],
    });

    await deleteErrandTx(m.tx, PUBLISHER, ERRAND_ID);

    // 仅 publisher 一把锁（OPEN 无 accepter），与 claimErrandTx 共享锁域
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe("ACTIVE_ERRAND_ORDER_STATUSES 冻结值", () => {
  it("只包含 ACCEPTED / IN_PROGRESS（COMPLETED/CANCELLED 不属于 active obligation）", () => {
    expect([...ACTIVE_ERRAND_ORDER_STATUSES]).toEqual(["ACCEPTED", "IN_PROGRESS"]);
  });
});

describe("errand-status-service 稳定导入名", () => {
  it("updateErrandStatusTx 与 canonical transitionErrandTx 为同一实现", () => {
    expect(updateErrandStatusTx).toBe(transitionErrandTx);
  });
});

describe("静态契约（AUDIT2-RB02 §57/§58）", () => {
  const readSource = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("order-status-service 不得再拥有 ERRAND IN_PROGRESS / COMPLETED 的 Order-only transition", () => {
    const source = readSource("src/lib/order-status-service.ts");

    // general canTransition 矩阵不再包含任何 ERRAND 分支
    expect(source).not.toMatch(/order\.type === "ERRAND"/);
    expect(source).not.toContain("completeErrandOrderTx");
    // ERRAND 转换必须委派 canonical lifecycle
    expect(source).toContain("transitionErrandOrderTx");
  });

  it("deleteErrand 不得以事务外 status check + 裸 errandTask.update 作为最终权威", () => {
    const actionSource = readSource("src/actions/errand.ts");

    expect(actionSource).toContain("deleteErrandTx");
    expect(actionSource).not.toMatch(/prisma\.errandTask\.update/);
  });

  it("updateErrand 不得仅依赖事务外 OPEN check（必须事务内 fresh 权威）", () => {
    const actionSource = readSource("src/actions/errand.ts");

    expect(actionSource).toContain("updateErrandContentTx");
  });

  it("canonical lifecycle 的行锁权威必须存在（ErrandTask + Order FOR UPDATE）", () => {
    const source = readSource("src/lib/errand-lifecycle.ts");

    expect(source).toMatch(/FROM "ErrandTask"[\s\S]*?FOR UPDATE/);
    expect(source).toMatch(/FROM "Order"[\s\S]*?FOR UPDATE/);
  });
});
