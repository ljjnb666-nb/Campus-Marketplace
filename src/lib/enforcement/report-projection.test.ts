import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  txReportFindUnique,
  txProductFindUnique,
  txErrandFindUnique,
  txServiceFindUnique,
  txMessageFindUnique,
  txRiskFlagFindUnique,
  txRiskFlagCreate,
  txRiskFlagUpdate,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  txReportFindUnique: vi.fn(),
  txProductFindUnique: vi.fn(),
  txErrandFindUnique: vi.fn(),
  txServiceFindUnique: vi.fn(),
  txMessageFindUnique: vi.fn(),
  txRiskFlagFindUnique: vi.fn(),
  txRiskFlagCreate: vi.fn(),
  txRiskFlagUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: withTransactionMock,
}));

import {
  assertReportStatusTransition,
  reconcileReportRiskProjection,
  resolveReportTargetOwner,
  REPORT_STATUS_TRANSITIONS,
} from "@/lib/enforcement/report-projection";

const txStub = {
  report: { findUnique: txReportFindUnique },
  product: { findUnique: txProductFindUnique },
  errandTask: { findUnique: txErrandFindUnique },
  serviceListing: { findUnique: txServiceFindUnique },
  message: { findUnique: txMessageFindUnique },
  riskFlag: { findUnique: txRiskFlagFindUnique, create: txRiskFlagCreate, update: txRiskFlagUpdate },
};

const REPORT_ID = "report-1";
const OWNER = "owner-1";

beforeEach(() => {
  withTransactionMock
    .mockReset()
    .mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub));
  txReportFindUnique.mockReset().mockResolvedValue(null);
  txProductFindUnique.mockReset().mockResolvedValue(null);
  txErrandFindUnique.mockReset().mockResolvedValue(null);
  txServiceFindUnique.mockReset().mockResolvedValue(null);
  txMessageFindUnique.mockReset().mockResolvedValue(null);
  txRiskFlagFindUnique.mockReset().mockResolvedValue(null);
  txRiskFlagCreate.mockReset().mockResolvedValue({});
  txRiskFlagUpdate.mockReset().mockResolvedValue({});
});

describe("assertReportStatusTransition（中央 transition assertion）", () => {
  it("encodes the Option B policy（terminal states reopen via IN_REVIEW）", () => {
    expect(REPORT_STATUS_TRANSITIONS.OPEN).toEqual(["IN_REVIEW", "RESOLVED", "REJECTED"]);
    expect(REPORT_STATUS_TRANSITIONS.IN_REVIEW).toEqual(["RESOLVED", "REJECTED"]);
    expect(REPORT_STATUS_TRANSITIONS.RESOLVED).toEqual(["IN_REVIEW"]);
    expect(REPORT_STATUS_TRANSITIONS.REJECTED).toEqual(["IN_REVIEW"]);
  });

  it("allows same-state re-submission（补充处理说明幂等）", () => {
    expect(() => assertReportStatusTransition("RESOLVED", "RESOLVED")).not.toThrow();
  });

  it("rejects arbitrary jumps", () => {
    expect(() => assertReportStatusTransition("RESOLVED", "REJECTED")).toThrow();
    expect(() => assertReportStatusTransition("OPEN", "OPEN")).not.toThrow();
    expect(() => assertReportStatusTransition("REJECTED", "RESOLVED")).toThrow();
  });
});

describe("resolveReportTargetOwner（全 targetType 归属解析）", () => {
  it("resolves owners through business objects for each target type", async () => {
    txProductFindUnique.mockResolvedValue({ sellerId: "seller-1" });
    txErrandFindUnique.mockResolvedValue({ publisherId: "publisher-1" });
    txServiceFindUnique.mockResolvedValue({ providerId: "provider-1" });
    txMessageFindUnique.mockResolvedValue({ senderId: "sender-1" });

    await expect(
      resolveReportTargetOwner(txStub as never, { targetType: "PRODUCT", productId: "p1" }),
    ).resolves.toBe("seller-1");
    await expect(
      resolveReportTargetOwner(txStub as never, { targetType: "ERRAND_TASK", errandTaskId: "e1" }),
    ).resolves.toBe("publisher-1");
    await expect(
      resolveReportTargetOwner(txStub as never, { targetType: "SERVICE_LISTING", serviceListingId: "s1" }),
    ).resolves.toBe("provider-1");
    await expect(
      resolveReportTargetOwner(txStub as never, { targetType: "MESSAGE", messageId: "m1" }),
    ).resolves.toBe("sender-1");
    await expect(
      resolveReportTargetOwner(txStub as never, { targetType: "USER", targetUserId: "u1" }),
    ).resolves.toBe("u1");
  });

  it("returns null for anonymous message senders", async () => {
    txMessageFindUnique.mockResolvedValue({ senderId: null });
    await expect(
      resolveReportTargetOwner(txStub as never, { targetType: "MESSAGE", messageId: "m1" }),
    ).resolves.toBeNull();
  });
});

describe("reconcileReportRiskProjection（deterministic projection）", () => {
  // 有状态 flag 存储：模拟 DB 行为（create/update/findUnique 一致）
  let store: Map<string, { id: string; kind: string; status: string }>;

  function reportRow(status: string) {
    return {
      id: REPORT_ID,
      status,
      targetType: "USER",
      productId: null,
      errandTaskId: null,
      serviceListingId: null,
      targetUserId: OWNER,
      messageId: null,
    };
  }

  beforeEach(() => {
    store = new Map();
    txRiskFlagFindUnique.mockImplementation(
      async ({
        where,
      }: {
        where: { kind_sourceType_sourceId: { kind: string; sourceId: string } };
      }) => {
        const key = where.kind_sourceType_sourceId;
        const row = store.get(`${key.kind}:${key.sourceId}`);
        return row ? { id: row.id, status: row.status } : null;
      },
    );
    txRiskFlagCreate.mockImplementation(async ({ data }: { data: { kind: string; sourceId: string; userId: string } }) => {
      const key = `${data.kind}:${data.sourceId}`;
      if (store.has(key)) {
        const error = new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "6.19.3",
        });
        throw error;
      }
      store.set(key, { id: `${data.kind}-1`, kind: data.kind, status: "ACTIVE" });
      return {};
    });
    txRiskFlagUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
      for (const row of store.values()) {
        if (row.id === where.id) {
          row.status = data.status;
        }
      }
      return {};
    });
  });

  it("creates missing projection for legacy reports（OPEN → SUBMITTED ACTIVE）", async () => {
    txReportFindUnique.mockResolvedValue(reportRow("OPEN"));

    const result = await reconcileReportRiskProjection({ reportId: REPORT_ID });

    expect(txRiskFlagCreate).toHaveBeenCalledTimes(1);
    expect(txRiskFlagCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "REPORT_SUBMITTED", userId: OWNER, sourceId: REPORT_ID }),
    });
    expect(result).toMatchObject({
      ownerUserId: OWNER,
      reportStatus: "OPEN",
      submittedFlagStatus: "ACTIVE",
      confirmedFlagStatus: "ABSENT",
    });
  });

  it("converges RESOLVED → SUBMITTED resolved + CONFIRMED active", async () => {
    txReportFindUnique.mockResolvedValue(reportRow("RESOLVED"));
    // 矛盾前态：RESOLVED 报告但 SUBMITTED 仍 ACTIVE、CONFIRMED 缺失
    store.set(`REPORT_SUBMITTED:${REPORT_ID}`, { id: "REPORT_SUBMITTED-1", kind: "REPORT_SUBMITTED", status: "ACTIVE" });

    const result = await reconcileReportRiskProjection({ reportId: REPORT_ID });

    expect(txRiskFlagUpdate).toHaveBeenCalledWith({
      where: { id: "REPORT_SUBMITTED-1" },
      data: expect.objectContaining({ status: "RESOLVED" }),
    });
    expect(txRiskFlagCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "REPORT_CONFIRMED", userId: OWNER }),
    });
    expect(result?.submittedFlagStatus).toBe("RESOLVED");
    expect(result?.confirmedFlagStatus).toBe("ACTIVE");
  });

  it("converges REJECTED → SUBMITTED resolved + CONFIRMED resolved（修复矛盾投影）", async () => {
    txReportFindUnique.mockResolvedValue(reportRow("REJECTED"));
    store.set(`REPORT_SUBMITTED:${REPORT_ID}`, { id: "REPORT_SUBMITTED-1", kind: "REPORT_SUBMITTED", status: "RESOLVED" });
    store.set(`REPORT_CONFIRMED:${REPORT_ID}`, { id: "REPORT_CONFIRMED-1", kind: "REPORT_CONFIRMED", status: "ACTIVE" });

    const result = await reconcileReportRiskProjection({ reportId: REPORT_ID });

    expect(txRiskFlagUpdate).toHaveBeenCalledWith({
      where: { id: "REPORT_CONFIRMED-1" },
      data: expect.objectContaining({ status: "RESOLVED" }),
    });
    expect(result?.submittedFlagStatus).toBe("RESOLVED");
    expect(result?.confirmedFlagStatus).toBe("RESOLVED");
  });

  it("supports reopen（RESOLVED → IN_REVIEW）：重激活 SUBMITTED、闭环 CONFIRMED", async () => {
    txReportFindUnique.mockResolvedValue(reportRow("IN_REVIEW"));
    store.set(`REPORT_SUBMITTED:${REPORT_ID}`, { id: "REPORT_SUBMITTED-1", kind: "REPORT_SUBMITTED", status: "RESOLVED" });
    store.set(`REPORT_CONFIRMED:${REPORT_ID}`, { id: "REPORT_CONFIRMED-1", kind: "REPORT_CONFIRMED", status: "ACTIVE" });

    await reconcileReportRiskProjection({ reportId: REPORT_ID });

    const updates = txRiskFlagUpdate.mock.calls.map((call) => call[0]);
    expect(updates).toContainEqual({
      where: { id: "REPORT_SUBMITTED-1" },
      data: expect.objectContaining({ status: "ACTIVE", resolvedAt: null }),
    });
    expect(updates).toContainEqual({
      where: { id: "REPORT_CONFIRMED-1" },
      data: expect.objectContaining({ status: "RESOLVED" }),
    });
  });

  it("is idempotent：同一 canonical 状态重复对账零变更", async () => {
    txReportFindUnique.mockResolvedValue(reportRow("RESOLVED"));
    store.set(`REPORT_SUBMITTED:${REPORT_ID}`, { id: "REPORT_SUBMITTED-1", kind: "REPORT_SUBMITTED", status: "RESOLVED" });
    store.set(`REPORT_CONFIRMED:${REPORT_ID}`, { id: "REPORT_CONFIRMED-1", kind: "REPORT_CONFIRMED", status: "ACTIVE" });

    const first = await reconcileReportRiskProjection({ reportId: REPORT_ID });
    const createCalls = txRiskFlagCreate.mock.calls.length;
    const updateCalls = txRiskFlagUpdate.mock.calls.length;
    const second = await reconcileReportRiskProjection({ reportId: REPORT_ID });

    expect(txRiskFlagCreate.mock.calls.length).toBe(createCalls);
    expect(txRiskFlagUpdate.mock.calls.length).toBe(updateCalls);
    expect(first).toEqual(second);
  });

  it("is a no-op for reports without a resolvable owner", async () => {
    txReportFindUnique.mockResolvedValue({
      id: REPORT_ID,
      status: "OPEN",
      targetType: "MESSAGE",
      productId: null,
      errandTaskId: null,
      serviceListingId: null,
      targetUserId: null,
      messageId: "anon-msg",
    });
    txMessageFindUnique.mockResolvedValue({ senderId: null });

    const result = await reconcileReportRiskProjection({ reportId: REPORT_ID });

    expect(result?.ownerUserId).toBeNull();
    expect(txRiskFlagCreate).not.toHaveBeenCalled();
  });

  it("treats concurrent projection creates (P2002) as idempotent", async () => {
    txReportFindUnique.mockResolvedValue(reportRow("OPEN"));
    txRiskFlagCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6.19.3" }),
    );

    const result = await reconcileReportRiskProjection({ reportId: REPORT_ID });

    expect(result?.submittedFlagStatus).toBe("ABSENT");
  });

  it("returns null for missing reports", async () => {
    txReportFindUnique.mockResolvedValue(null);
    await expect(reconcileReportRiskProjection({ reportId: "ghost" })).resolves.toBeNull();
  });
});
