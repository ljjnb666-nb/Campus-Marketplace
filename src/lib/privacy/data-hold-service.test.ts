import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dataHoldFindMany, dataHoldCreate, dataHoldUpdate, dataHoldFindUnique, transactionMock } =
  vi.hoisted(() => ({
    dataHoldFindMany: vi.fn(),
    dataHoldCreate: vi.fn(),
    dataHoldUpdate: vi.fn(),
    dataHoldFindUnique: vi.fn(),
    transactionMock: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    dataHold: {
      findMany: dataHoldFindMany,
      create: dataHoldCreate,
      update: dataHoldUpdate,
      findUnique: dataHoldFindUnique,
    },
  },
  withTransaction: transactionMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  assertNoActiveHold,
  createHold,
  hasActiveHold,
  createHoldTxLocked,
  releaseHold,
} from "@/lib/privacy/data-hold-service";

const txClient = {
  $executeRaw: vi.fn().mockResolvedValue(0),
  dataHold: { findMany: dataHoldFindMany, update: dataHoldUpdate, create: dataHoldCreate },
};

beforeEach(() => {
  dataHoldFindMany.mockReset();
  dataHoldCreate.mockReset();
  dataHoldUpdate.mockReset();
  dataHoldFindUnique.mockReset();
  transactionMock.mockReset();
  txClient.$executeRaw.mockClear().mockResolvedValue(0);
  // createHold/releaseHold 经 withGovernanceSubjectLock → withTransaction(tx)
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(txClient),
  );
  dataHoldCreate.mockResolvedValue({ id: "hold-new", status: "ACTIVE" });
  dataHoldUpdate.mockResolvedValue({ id: "hold-9", status: "RELEASED", releasedAt: new Date() });
});

describe("DataHold（ACTIVE_LEGAL_HOLD_BLOCKS / RELEASED_HOLD_ALLOWS）", () => {
  it("blocks erasure while a legal hold is active", async () => {
    dataHoldFindMany.mockResolvedValue([
      { id: "hold-1", type: "LEGAL", status: "ACTIVE", subjectId: "user-1" },
    ]);

    await expect(assertNoActiveHold("user-1")).rejects.toMatchObject({
      code: "ACTIVE_DATA_HOLD",
      status: 409,
    });
    await expect(assertNoActiveHold("user-1", txClient as never)).rejects.toMatchObject({
      code: "ACTIVE_DATA_HOLD",
    });
  });

  it("blocks erasure while a dispute hold is active", async () => {
    dataHoldFindMany.mockResolvedValue([
      { id: "hold-2", type: "DISPUTE", status: "ACTIVE", subjectId: "user-2" },
    ]);

    await expect(assertNoActiveHold("user-2")).rejects.toMatchObject({
      code: "ACTIVE_DATA_HOLD",
    });
  });

  it("allows erasure once every hold has been released", async () => {
    dataHoldFindMany.mockResolvedValue([]);

    await expect(assertNoActiveHold("user-1")).resolves.toBeUndefined();
    expect(await hasActiveHold("user-1")).toBe(false);
  });

  it("creates and releases holds through the subject-locked seam", async () => {
    const hold = await createHold({
      type: "LEGAL",
      subjectId: "user-3",
      reasonCode: "REGULATORY_INQUIRY",
    });

    expect(hold.status).toBe("ACTIVE");
    // subject advisory 锁在写之前于同一事务内取得
    expect(txClient.$executeRaw).toHaveBeenCalled();
    expect(dataHoldCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "LEGAL",
        subjectId: "user-3",
        subjectType: "USER",
        reasonCode: "REGULATORY_INQUIRY",
      }),
    });

    dataHoldFindUnique.mockResolvedValue({ subjectType: "USER", subjectId: "user-3" });

    const released = await releaseHold("hold-9");
    expect(released.status).toBe("RELEASED");
    expect(txClient.$executeRaw).toHaveBeenCalled();

    // releasedById 显式传入（可选参数第二臂）
    dataHoldUpdate.mockResolvedValueOnce({ id: "hold-9", status: "RELEASED" } as never);
    await releaseHold("hold-9", "operator-1");
    expect(dataHoldUpdate).toHaveBeenLastCalledWith({
      where: { id: "hold-9" },
      data: expect.objectContaining({ status: "RELEASED", releasedById: "operator-1" }),
    });

    // hold 不存在 → PRIVACY_REQUEST_NOT_FOUND（fail closed）
    dataHoldFindUnique.mockResolvedValueOnce(null);
    await expect(releaseHold("ghost")).rejects.toMatchObject({
      code: "PRIVACY_REQUEST_NOT_FOUND",
    });
  });
});

// ── Phase 7G：createHoldTxLocked（TxLocked seam；subjectType 默认臂 + P2002 幂等收敛 + 非唯一错重抛）──

describe("createHoldTxLocked（source-linked hold，调用方持锁合同）", () => {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    dataHold: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
  };

  beforeEach(() => {
    tx.$executeRaw.mockClear().mockResolvedValue(0);
    tx.dataHold.create.mockReset();
    tx.dataHold.findFirst.mockReset();
  });

  function p2002Error(target: string[] | string) {
    const error = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "test",
    });
    error.meta = { target };
    return error;
  }

  it("subjectType 省略 → 默认 USER；SAVEPOINT 包裹插入点", async () => {
    tx.dataHold.create.mockResolvedValue({ id: "h1", subjectType: "USER" });

    await createHoldTxLocked(tx as never, {
      type: "DISPUTE",
      subjectId: "user-1",
      reasonCode: "ACTIVE_RENTAL_DISPUTE",
      sourceType: "RENTAL_DISPUTE",
      sourceId: "d1",
    });

    expect(tx.dataHold.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ subjectType: "USER", sourceType: "RENTAL_DISPUTE" }),
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1); // 仅 SAVEPOINT（成功无 ROLLBACK）
  });

  it("P2002（partial unique 兜底命中）→ ROLLBACK TO SAVEPOINT + 幂等返回既有 ACTIVE hold", async () => {
    tx.dataHold.create.mockRejectedValueOnce(p2002Error(["DataHold_source_active_key"]));
    tx.dataHold.findFirst.mockResolvedValue({ id: "hold-existing", status: "ACTIVE" });

    const result = await createHoldTxLocked(tx as never, {
      type: "DISPUTE",
      subjectId: "user-1",
      reasonCode: "ACTIVE_RENTAL_DISPUTE",
      sourceType: "RENTAL_DISPUTE",
      sourceId: "d1",
    });

    expect(result.id).toBe("hold-existing");
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2); // SAVEPOINT + ROLLBACK TO
    expect(tx.dataHold.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ sourceId: "d1", status: "ACTIVE" }),
    });
  });

  it("P2002 且无既有行 → 抛出（防御：收敛目标缺失不得静默）", async () => {
    tx.dataHold.create.mockRejectedValueOnce(p2002Error("DataHold_source_active_key"));
    tx.dataHold.findFirst.mockResolvedValue(null);

    await expect(
      createHoldTxLocked(tx as never, {
        type: "DISPUTE",
        subjectId: "user-1",
        reasonCode: "X",
        sourceType: "RENTAL_DISPUTE",
        sourceId: "d1",
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("非唯一约束错误 → 原样重抛（不吞错）", async () => {
    tx.dataHold.create.mockRejectedValueOnce(new Error("connection lost"));

    await expect(
      createHoldTxLocked(tx as never, {
        type: "DISPUTE",
        subjectId: "user-1",
        reasonCode: "X",
        sourceType: "RENTAL_DISPUTE",
        sourceId: "d1",
      }),
    ).rejects.toThrow("connection lost");
    // 无 ROLLBACK（错误路径直接抛出，事务随调用方回滚）
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
