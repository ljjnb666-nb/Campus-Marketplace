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
  });
});
