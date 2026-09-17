import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePathMock,
  requireUserMock,
  loadAuthorizationContextMock,
  claimModerationCaseMock,
  releaseModerationCaseMock,
  reviewReportInGovernanceMock,
} = vi.hoisted(() => ({
  revalidatePathMock: vi.fn(),
  requireUserMock: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  claimModerationCaseMock: vi.fn(),
  releaseModerationCaseMock: vi.fn(),
  reviewReportInGovernanceMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: requireUserMock,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext: loadAuthorizationContextMock,
}));

vi.mock("@/lib/reports/moderation-case-service", () => ({
  claimModerationCase: claimModerationCaseMock,
  releaseModerationCase: releaseModerationCaseMock,
}));

vi.mock("@/lib/reports/report-review-service", () => ({
  reviewReportInGovernance: reviewReportInGovernanceMock,
}));

import {
  claimGovernanceReportCase,
  releaseGovernanceReportCase,
  reviewGovernanceReport,
} from "@/actions/governance-reports";
import { ReportCaseError } from "@/lib/reports/errors";

/**
 * Phase 7E 薄 adapter 合同（7A governance-appeals 同款冻结约定）：
 * - actor 身份仅来自 requireUser（FormData 身份字段结构性无效）；
 * - missing/越权 → 统一文案（无存在性 oracle）；
 * - 领用冲突 / case 已关闭保留域内安全文案；
 * - revalidate 仅治理路由 + 通知；
 * - 无 access 的调用者 fail-fast（不触发域服务）。
 */

function activeUser(id = "reviewer-1") {
  return { id, email: "r@x", name: "R", role: "ADMIN" as const };
}

function globalAccessContext() {
  return {
    userId: "reviewer-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [
      { roleKey: "R", scope: "GLOBAL" as const, campusId: null, permissionKeys: ["report.review"] },
    ],
  };
}

function emptyAccessContext() {
  return {
    userId: "reviewer-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [],
  };
}

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.append(key, value);
  }
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue(activeUser());
  loadAuthorizationContextMock.mockResolvedValue(globalAccessContext());
});

describe("claimGovernanceReportCase", () => {
  it("thin adapter：server 身份 → claimModerationCase → revalidate 治理路由", async () => {
    claimModerationCaseMock.mockResolvedValue({
      caseId: "case-1",
      assignedToId: "reviewer-1",
      outcome: "CLAIMED",
    });

    const result = await claimGovernanceReportCase(formData({ reportId: "report-1" }));

    expect(result).toEqual({ success: true, outcome: "CLAIMED" });
    expect(claimModerationCaseMock).toHaveBeenCalledWith({
      actorId: "reviewer-1",
      reportId: "report-1",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/reports");
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/reports/report-1");
  });

  it("FormData 伪造 actorId 无效：actor 一律来自 requireUser", async () => {
    claimModerationCaseMock.mockResolvedValue({ caseId: "case-1", assignedToId: "x", outcome: "CLAIMED" });

    await claimGovernanceReportCase(
      formData({ reportId: "report-1", actorId: "attacker" }),
    );

    expect(claimModerationCaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "reviewer-1" }),
    );
  });

  it("零有效 access → 统一 deny 且不触发域服务", async () => {
    loadAuthorizationContextMock.mockResolvedValue(emptyAccessContext());

    const result = await claimGovernanceReportCase(formData({ reportId: "report-1" }));

    expect(result).toEqual({ success: false, error: "没有权限处理该举报" });
    expect(claimModerationCaseMock).not.toHaveBeenCalled();
  });

  it("missing/越权（NOT_FOUND/FORBIDDEN）→ 统一 deny 文案（反 oracle）", async () => {
    claimModerationCaseMock.mockRejectedValue(new ReportCaseError("REPORT_CASE_NOT_FOUND"));
    const forbidden = await claimGovernanceReportCase(formData({ reportId: "report-1" }));
    expect(forbidden).toEqual({ success: false, error: "没有权限处理该举报" });

    claimModerationCaseMock.mockRejectedValue(new ReportCaseError("REPORT_CASE_FORBIDDEN"));
    const forbidden2 = await claimGovernanceReportCase(formData({ reportId: "report-1" }));
    expect(forbidden2).toEqual({ success: false, error: "没有权限处理该举报" });
    expect(forbidden).toEqual(forbidden2);
  });

  it("领用冲突 / case 已关闭保留域内安全文案", async () => {
    claimModerationCaseMock.mockRejectedValue(
      new ReportCaseError("REPORT_CASE_ALREADY_CLAIMED"),
    );
    const claimed = await claimGovernanceReportCase(formData({ reportId: "report-1" }));
    expect(claimed).toEqual({ success: false, error: "该举报已被其他审核员领用" });

    claimModerationCaseMock.mockRejectedValue(new ReportCaseError("REPORT_CASE_CLOSED"));
    const closed = await claimGovernanceReportCase(formData({ reportId: "report-1" }));
    expect(closed).toEqual({ success: false, error: "该举报的运营 case 已关闭" });
  });

  it("参数缺失 → 校验错误", async () => {
    const result = await claimGovernanceReportCase(formData({}));
    expect(result.success).toBe(false);
    expect(claimModerationCaseMock).not.toHaveBeenCalled();
  });
});

describe("releaseGovernanceReportCase", () => {
  it("thin adapter：server 身份 → releaseModerationCase → revalidate", async () => {
    releaseModerationCaseMock.mockResolvedValue({
      caseId: "case-1",
      assignedToId: null,
      outcome: "RELEASED",
    });

    const result = await releaseGovernanceReportCase(formData({ reportId: "report-1" }));

    expect(result).toEqual({ success: true, outcome: "RELEASED" });
    expect(releaseModerationCaseMock).toHaveBeenCalledWith({
      actorId: "reviewer-1",
      reportId: "report-1",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/reports");
  });

  it("零有效 access → 统一 deny；参数缺失 → 校验错误；非领用人/非域错误 → 域内与兜底文案", async () => {
    loadAuthorizationContextMock.mockResolvedValue(emptyAccessContext());
    const deny = await releaseGovernanceReportCase(formData({ reportId: "report-1" }));
    expect(deny).toEqual({ success: false, error: "没有权限处理该举报" });
    expect(releaseModerationCaseMock).not.toHaveBeenCalled();

    loadAuthorizationContextMock.mockResolvedValue(globalAccessContext());

    const invalid = await releaseGovernanceReportCase(formData({}));
    expect(invalid.success).toBe(false);
    expect(releaseModerationCaseMock).not.toHaveBeenCalled();

    releaseModerationCaseMock.mockRejectedValue(new ReportCaseError("REPORT_CASE_FORBIDDEN"));
    const forbidden = await releaseGovernanceReportCase(formData({ reportId: "report-1" }));
    expect(forbidden.error).toBe("没有权限处理该举报");

    releaseModerationCaseMock.mockRejectedValue(new Error("db down"));
    const fallback = await releaseGovernanceReportCase(formData({ reportId: "report-1" }));
    expect(fallback.success).toBe(false);
    expect(fallback.error).toBeTruthy();
    expect(fallback.error).not.toBe("没有权限处理该举报");
  });
});

describe("reviewGovernanceReport", () => {
  it("thin adapter：server 身份 → reviewReportInGovernance → revalidate", async () => {
    reviewReportInGovernanceMock.mockResolvedValue({
      reportId: "report-1",
      status: "RESOLVED",
      reporterId: "reporter-1",
      caseId: "case-1",
      reopened: false,
      dueAt: new Date(),
    });

    const result = await reviewGovernanceReport(
      formData({ reportId: "report-1", status: "RESOLVED", handledNote: "done" }),
    );

    expect(result).toEqual({ success: true });
    expect(reviewReportInGovernanceMock).toHaveBeenCalledWith({
      actorId: "reviewer-1",
      reportId: "report-1",
      status: "RESOLVED",
      handledNote: "done",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/reports");
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/reports/report-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/notifications");
  });

  it("零有效 access → 统一 deny 且不触发域服务", async () => {
    loadAuthorizationContextMock.mockResolvedValue(emptyAccessContext());

    const result = await reviewGovernanceReport(
      formData({ reportId: "report-1", status: "RESOLVED" }),
    );

    expect(result).toEqual({ success: false, error: "没有权限处理该举报" });
    expect(reviewReportInGovernanceMock).not.toHaveBeenCalled();
  });

  it("非法 transition / missing → 域安全文案映射", async () => {
    reviewReportInGovernanceMock.mockRejectedValue(
      new Error("REPORT_STATUS_INVALID_TRANSITION:RESOLVED->REJECTED"),
    );
    const invalid = await reviewGovernanceReport(
      formData({ reportId: "report-1", status: "REJECTED" }),
    );
    expect(invalid).toEqual({ success: false, error: "举报当前状态不允许此操作" });

    reviewReportInGovernanceMock.mockRejectedValue(new Error("REPORT_NOT_FOUND:ghost"));
    const missing = await reviewGovernanceReport(
      formData({ reportId: "ghost", status: "RESOLVED" }),
    );
    expect(missing).toEqual({ success: false, error: "没有权限处理该举报" });
  });

  it("status 枚举外（OPEN）拒绝", async () => {
    const result = await reviewGovernanceReport(
      formData({ reportId: "report-1", status: "OPEN" }),
    );
    expect(result.success).toBe(false);
    expect(reviewReportInGovernanceMock).not.toHaveBeenCalled();
  });
});
