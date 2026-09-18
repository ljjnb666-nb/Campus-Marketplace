import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  acquireGovernanceSubjectLocksMock,
  applyReportReviewTxMock,
  createNotificationMock,
  transactionMock,
  loadAuthorizationContextMock,
  requirePermissionInContextMock,
} = vi.hoisted(() => ({
  acquireGovernanceSubjectLocksMock: vi.fn(),
  applyReportReviewTxMock: vi.fn(),
  createNotificationMock: vi.fn(),
  transactionMock: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  requirePermissionInContextMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: transactionMock,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks: acquireGovernanceSubjectLocksMock,
}));

vi.mock("@/lib/enforcement/report-projection", () => ({
  applyReportReviewTx: applyReportReviewTxMock,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext: loadAuthorizationContextMock,
  requirePermissionInContext: requirePermissionInContextMock,
}));

vi.mock("@/lib/rbac/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rbac/errors")>()),
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotification: createNotificationMock,
}));

import { reviewReportInGovernance } from "@/lib/reports/report-review-service";
import { RbacError } from "@/lib/rbac/errors";

/**
 * Phase 7E canonical review 服务合同（FR01 修复后的冻结链）：
 *   USER:actor subject lock（事务内最先）→ REPORT/CASE 行锁（applyReportReviewTx
 *   内部）→ 锁后授权复核 → transition → 写入 → 通知（同事务，既有 §35/§36
 *   合同：IN_REVIEW/RESOLVED/REJECTED 三段文案零改动）。
 */

beforeEach(() => {
  vi.clearAllMocks();
  transactionMock.mockReset().mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) => callback({ txMarker: true }),
  );
  acquireGovernanceSubjectLocksMock.mockReset().mockResolvedValue(undefined);
  loadAuthorizationContextMock.mockReset().mockResolvedValue({
    userId: "admin-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [
      { roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["report.review"] },
    ],
  });
  requirePermissionInContextMock.mockReset().mockResolvedValue({});
  applyReportReviewTxMock.mockReset().mockResolvedValue({
    reportId: "report-1",
    status: "RESOLVED",
    reporterId: "reporter-1",
    caseId: "case-1",
    reopened: false,
    dueAt: new Date("2026-09-18T00:00:00.000Z"),
  });
});

describe("reviewReportInGovernance（FR01 actor serialization）", () => {
  it("USER:actor advisory lock 在 applyReportReviewTx 之前、同一事务内取得", async () => {
    await reviewReportInGovernance({
      actorId: "admin-1",
      reportId: "report-1",
      status: "RESOLVED",
    });

    expect(acquireGovernanceSubjectLocksMock).toHaveBeenCalledTimes(1);
    expect(acquireGovernanceSubjectLocksMock).toHaveBeenCalledWith(
      expect.objectContaining({ txMarker: true }),
      [{ subjectType: "USER", subjectId: "admin-1" }],
    );
    // 锁先于行锁/transition 入口
    expect(acquireGovernanceSubjectLocksMock.mock.invocationCallOrder[0]).toBeLessThan(
      applyReportReviewTxMock.mock.invocationCallOrder[0],
    );
  });

  it("锁后授权复核 seam 传入 applyReportReviewTx：UNSCOPED → campusId=null（仅 GLOBAL 放行）", async () => {
    applyReportReviewTxMock.mockImplementation(async (_tx, input) => {
      // 模拟行锁后 seam 执行（UNSCOPED 行：campusId=null）
      await input.authorizeAfterLock?.(_tx, {
        reportId: "report-1",
        campusId: null,
        scopeKey: "UNSCOPED",
      });
      return {
        reportId: "report-1",
        status: input.status,
        reporterId: "reporter-1",
        caseId: "case-1",
        reopened: false,
        dueAt: new Date(),
      };
    });

    await reviewReportInGovernance({
      actorId: "admin-1",
      reportId: "report-1",
      status: "IN_REVIEW",
    });

    expect(requirePermissionInContextMock).toHaveBeenCalledWith(
      expect.anything(),
      "report.review",
      null,
    );
  });

  it("锁后授权复核：malformed scope → fail closed（RbacError，整体回滚）", async () => {
    applyReportReviewTxMock.mockImplementation(async (_tx, input) => {
      await input.authorizeAfterLock?.(_tx, {
        reportId: "report-1",
        campusId: "A",
        scopeKey: "UNSCOPED",
      });
      return {
        reportId: "report-1",
        status: input.status,
        reporterId: "reporter-1",
        caseId: "case-1",
        reopened: false,
        dueAt: new Date(),
      };
    });

    await expect(
      reviewReportInGovernance({ actorId: "admin-1", reportId: "report-1", status: "RESOLVED" }),
    ).rejects.toThrow(RbacError);
    // seam 拒绝后零通知（事务回滚）
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("锁后授权复核：campus reviewer 授权缺失 → AUTH_PERMISSION_DENIED", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "admin-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });
    // mock 对齐真实合同：授权缺失时 requirePermissionInContext 抛 RbacError
    requirePermissionInContextMock.mockImplementation(async () => {
      throw new RbacError("AUTH_PERMISSION_DENIED", "无权执行该操作");
    });
    applyReportReviewTxMock.mockImplementation(async (_tx, input) => {
      await input.authorizeAfterLock?.(_tx, {
        reportId: "report-1",
        campusId: "A",
        scopeKey: "CAMPUS:A",
      });
      return {
        reportId: "report-1",
        status: input.status,
        reporterId: "reporter-1",
        caseId: "case-1",
        reopened: false,
        dueAt: new Date(),
      };
    });

    await expect(
      reviewReportInGovernance({ actorId: "admin-1", reportId: "report-1", status: "RESOLVED" }),
    ).rejects.toThrow(RbacError);
  });
});

describe("reviewReportInGovernance（reporter 通知文案合同 §35/§36）", () => {
  it("IN_REVIEW：处理中文案（含备注）", async () => {
    await reviewReportInGovernance({
      actorId: "admin-1",
      reportId: "report-1",
      status: "IN_REVIEW",
      handledNote: "已转交复核",
    });

    expect(createNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ txMarker: true }),
      {
        userId: "reporter-1",
        type: "REPORT",
        title: "举报处理中",
        content: "你提交的举报正在处理中。处理说明：已转交复核",
      },
    );
  });

  it("IN_REVIEW：无备注文案", async () => {
    await reviewReportInGovernance({
      actorId: "admin-1",
      reportId: "report-1",
      status: "IN_REVIEW",
    });

    expect(createNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: "你提交的举报正在处理中，平台会在核查完成后通知你结果。",
      }),
    );
  });

  it("RESOLVED：处理完成文案", async () => {
    await reviewReportInGovernance({
      actorId: "admin-1",
      reportId: "report-1",
      status: "RESOLVED",
      handledNote: "已下架违规商品",
    });

    expect(createNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "举报已处理",
        content: "你提交的举报已处理完成。处理说明：已下架违规商品",
      }),
    );
  });

  it("REJECTED：未通过文案（无备注）", async () => {
    await reviewReportInGovernance({
      actorId: "admin-1",
      reportId: "report-1",
      status: "REJECTED",
    });

    expect(createNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "举报处理结果已更新",
        content: "你提交的举报未通过。如有需要可补充更完整的信息后再次提交。",
      }),
    );
  });

  it("通知失败随事务回滚（既有事务性合同，零改动）", async () => {
    createNotificationMock.mockRejectedValue(new Error("db down"));

    await expect(
      reviewReportInGovernance({ actorId: "admin-1", reportId: "report-1", status: "RESOLVED" }),
    ).rejects.toThrow("db down");
  });
});
