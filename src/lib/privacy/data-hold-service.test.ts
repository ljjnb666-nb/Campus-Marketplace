import { beforeEach, describe, expect, it, vi } from "vitest";

const { dataHoldFindMany, dataHoldCreate, dataHoldUpdate } = vi.hoisted(() => ({
  dataHoldFindMany: vi.fn(),
  dataHoldCreate: vi.fn(),
  dataHoldUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    dataHold: {
      findMany: dataHoldFindMany,
      create: dataHoldCreate,
      update: dataHoldUpdate,
    },
  },
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

const txClient = { dataHold: { findMany: dataHoldFindMany } };

beforeEach(() => {
  dataHoldFindMany.mockReset();
  dataHoldCreate.mockReset();
  dataHoldUpdate.mockReset();
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

  it("creates and releases holds through the service seam", async () => {
    dataHoldCreate.mockResolvedValue({ id: "hold-9", status: "ACTIVE" });
    dataHoldUpdate.mockResolvedValue({ id: "hold-9", status: "RELEASED", releasedAt: new Date() });

    const hold = await createHold({
      type: "LEGAL",
      subjectId: "user-3",
      reasonCode: "REGULATORY_INQUIRY",
    });

    expect(hold.status).toBe("ACTIVE");
    expect(dataHoldCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "LEGAL",
        subjectId: "user-3",
        subjectType: "USER",
        reasonCode: "REGULATORY_INQUIRY",
      }),
    });

    const released = await releaseHold("hold-9");
    expect(released.status).toBe("RELEASED");
  });
});
