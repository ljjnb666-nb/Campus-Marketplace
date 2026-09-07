import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  txReportFindUnique,
  txUserFindUnique,
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
  txUserFindUnique: vi.fn(),
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
  resolveReportTargetContext,
  applyReportReviewTx,
  REPORT_STATUS_TRANSITIONS,
} from "@/lib/enforcement/report-projection";

const txStub = {
  report: { findUnique: txReportFindUnique },
  user: { findUnique: txUserFindUnique },
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
  txUserFindUnique.mockReset().mockResolvedValue({ id: OWNER });
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

describe("resolveReportTargetContext（全 targetType 归属 + campus provenance）", () => {
  it("resolves owner + campus through business objects for each target type", async () => {
    txProductFindUnique.mockResolvedValue({ sellerId: "seller-1", campusId: "campus-p" });
    txErrandFindUnique.mockResolvedValue({ publisherId: "publisher-1", campusId: "campus-e" });
    txServiceFindUnique.mockResolvedValue({ providerId: "provider-1", campusId: "campus-s" });
    txMessageFindUnique.mockResolvedValue({ senderId: "sender-1" });

    await expect(
      resolveReportTargetContext(txStub as never, { targetType: "PRODUCT", productId: "p1" }),
    ).resolves.toEqual({ ownerUserId: "seller-1", campusId: "campus-p", targetExists: true });
    await expect(
      resolveReportTargetContext(txStub as never, { targetType: "ERRAND_TASK", errandTaskId: "e1" }),
    ).resolves.toEqual({ ownerUserId: "publisher-1", campusId: "campus-e", targetExists: true });
    await expect(
      resolveReportTargetContext(txStub as never, { targetType: "SERVICE_LISTING", serviceListingId: "s1" }),
    ).resolves.toEqual({ ownerUserId: "provider-1", campusId: "campus-s", targetExists: true });
    // MESSAGE：不猜 campus（如实 null）
    await expect(
      resolveReportTargetContext(txStub as never, { targetType: "MESSAGE", messageId: "m1" }),
    ).resolves.toEqual({ ownerUserId: "sender-1", campusId: null, targetExists: true });
    // USER：无 campus 语境（如实 null）
    txUserFindUnique.mockResolvedValue({ id: "u1" });
    await expect(
      resolveReportTargetContext(txStub as never, { targetType: "USER", targetUserId: "u1" }),
    ).resolves.toEqual({ ownerUserId: "u1", campusId: null, targetExists: true });
  });

  it("returns null owner for anonymous message senders", async () => {
    txMessageFindUnique.mockResolvedValue({ senderId: null });
    await expect(
      resolveReportTargetContext(txStub as never, { targetType: "MESSAGE", messageId: "m1" }),
    ).resolves.toEqual({ ownerUserId: null, campusId: null, targetExists: true });
  });

  it("reports targetExists=false for missing business objects", async () => {
    txProductFindUnique.mockResolvedValue(null);
    await expect(
      resolveReportTargetContext(txStub as never, { targetType: "PRODUCT", productId: "ghost" }),
    ).resolves.toEqual({ ownerUserId: null, campusId: null, targetExists: false });
  });
});

describe("applyReportReviewTx（FOR UPDATE 序列化审核）", () => {
  beforeEach(() => {
    txReportFindUnique.mockReset();
  });

  function reportRow(status: string) {
    return [{ id: REPORT_ID, status, reporterId: "reporter-1" }];
  }

  it("applies the review under the row lock with reconcile + admin log", async () => {
    const $queryRaw = vi.fn().mockResolvedValue(reportRow("OPEN"));
    const reportUpdate = vi.fn().mockResolvedValue({ reporterId: "reporter-1" });
    const adminLogCreate = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw,
      report: { findUnique: vi.fn().mockResolvedValue(reportRow("RESOLVED")), update: reportUpdate },
      user: { findUnique: vi.fn().mockResolvedValue({ id: OWNER }) },
      adminLog: { create: adminLogCreate },
      riskFlag: { findUnique: txRiskFlagFindUnique, create: txRiskFlagCreate, update: txRiskFlagUpdate },
    } as never;

    const result = await applyReportReviewTx(tx, {
      reportId: REPORT_ID,
      actorId: "admin-1",
      status: "RESOLVED",
      handledNote: "done",
    });

    expect($queryRaw).toHaveBeenCalled();
    expect(reportUpdate).toHaveBeenCalledWith({
      where: { id: REPORT_ID },
      data: expect.objectContaining({
        status: "RESOLVED",
        handledById: "admin-1",
        handledNote: "done",
        handledAt: expect.any(Date),
      }),
      select: { reporterId: true },
    });
    expect(adminLogCreate).toHaveBeenCalled();
    expect(result).toMatchObject({ reportId: REPORT_ID, status: "RESOLVED" });
  });

  it("throws REPORT_NOT_FOUND for missing reports", async () => {
    const $queryRaw = vi.fn().mockResolvedValue([]);
    const tx = { $queryRaw } as never;

    await expect(
      applyReportReviewTx(tx, { reportId: "ghost", actorId: "admin-1", status: "RESOLVED" }),
    ).rejects.toThrow("REPORT_NOT_FOUND:ghost");
  });

  it("runs racePoint after the row lock and before the transition assert（race seam）", async () => {
    const $queryRaw = vi.fn().mockResolvedValue(reportRow("OPEN"));
    const order: string[] = [];
    const tx = {
      $queryRaw: $queryRaw.mockImplementation(async () => {
        order.push("row-lock");
        return reportRow("OPEN");
      }),
      report: {
        findUnique: vi.fn().mockResolvedValue(reportRow("OPEN")),
        update: vi.fn().mockImplementation(async () => {
          order.push("update");
          return { reporterId: "reporter-1" };
        }),
      },
      user: { findUnique: vi.fn().mockResolvedValue({ id: OWNER }) },
      adminLog: { create: vi.fn().mockResolvedValue({}) },
      riskFlag: { findUnique: txRiskFlagFindUnique, create: txRiskFlagCreate, update: txRiskFlagUpdate },
    } as never;

    await applyReportReviewTx(tx, {
      reportId: REPORT_ID,
      actorId: "admin-1",
      status: "RESOLVED",
      racePoint: async () => {
        order.push("race-point");
      },
    });

    expect(order).toEqual(["row-lock", "race-point", "update"]);
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
    txRiskFlagCreate.mockImplementation(async ({ data }: { data: { kind: string; sourceId: string; userId: string; status?: string } }) => {
      const key = `${data.kind}:${data.sourceId}`;
      if (store.has(key)) {
        const error = new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "6.19.3",
        });
        throw error;
      }
      store.set(key, {
        id: `${data.kind}-1`,
        kind: data.kind,
        status: (data.status as string) ?? "ACTIVE",
      });
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

    // RESOLVED/CONFIRMED 合同下 OPEN 报告只投影 SUBMITTED；
    // CONFIRMED 以 RESOLVED 状态补建（absent-or-resolved 合同，两行都补齐）
    expect(txRiskFlagCreate).toHaveBeenCalledTimes(2);
    expect(txRiskFlagCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "REPORT_SUBMITTED", userId: OWNER, sourceId: REPORT_ID }),
    });
    expect(result).toMatchObject({
      ownerUserId: OWNER,
      reportStatus: "OPEN",
      submittedFlagStatus: "ACTIVE",
      // CONFIRMED 以 RESOLVED 状态补建（合同：absent or RESOLVED）
      confirmedFlagStatus: "RESOLVED",
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
    const rowsAfterFirst = new Map(store);
    const second = await reconcileReportRiskProjection({ reportId: REPORT_ID });

    // 幂等合同：不产生重复行（unique key 固定），且收敛结果一致
    expect(store.size).toBe(rowsAfterFirst.size);
    expect(second).toEqual(first);
    expect(second?.submittedFlagStatus).toBe("RESOLVED");
    expect(second?.confirmedFlagStatus).toBe("ACTIVE");
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
