import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireUser,
  loadAuthorizationContext,
  claimDispute,
  releaseDispute,
  resolveDispute,
  closeDispute,
} = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  claimDispute: vi.fn(),
  releaseDispute: vi.fn(),
  resolveDispute: vi.fn(),
  closeDispute: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext }));
vi.mock("@/lib/disputes/dispute-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/disputes/dispute-access")>();
  return { ...actual, deriveDisputeReviewAccess: actual.deriveDisputeReviewAccess };
});
vi.mock("@/lib/disputes/dispute-service", () => ({
  claimDispute,
  releaseDispute,
  resolveDispute,
  closeDispute,
}));

import {
  claimGovernanceDispute,
  closeGovernanceDispute,
  releaseGovernanceDispute,
  resolveGovernanceDispute,
} from "@/actions/governance-disputes";
import { disputeError } from "@/lib/disputes/errors";

/**
 * Phase 7G：纠纷 actions 薄适配层合同（validate → 身份 → access fail-fast →
 * canonical 服务 → revalidate；missing/越权统一 deny 文案）。
 */

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.set(k, v);
  }
  return fd;
}

beforeEach(() => {
  for (const fn of [requireUser, loadAuthorizationContext, claimDispute, releaseDispute, resolveDispute, closeDispute, revalidatePath]) {
    fn.mockReset();
  }
  requireUser.mockResolvedValue({ id: "operator-1" });
  loadAuthorizationContext.mockResolvedValue({
    userId: "operator-1",
    accountActive: true,
    activeCampusIds: ["A"],
    grants: [
      { roleKey: "CAMPUS_DISPUTE_REVIEWER", scope: "CAMPUS", campusId: "A", permissionKeys: ["dispute.review"] },
    ],
  });
});

describe("claimGovernanceDispute / releaseGovernanceDispute", () => {
  it("claim happy path → canonical 服务 + revalidate + outcome", async () => {
    claimDispute.mockResolvedValue({ disputeId: "d1", assignedToId: "operator-1", outcome: "CLAIMED" });

    const result = await claimGovernanceDispute(formData({ disputeId: "d1" }));

    expect(result).toEqual({ success: true, outcome: "CLAIMED" });
    expect(claimDispute).toHaveBeenCalledWith({ actorId: "operator-1", disputeId: "d1" });
    expect(revalidatePath).toHaveBeenCalledWith("/governance/disputes");
    expect(revalidatePath).toHaveBeenCalledWith("/governance/disputes/d1");
  });

  it("零有效 access → 统一 deny（canonical 服务零调用）", async () => {
    loadAuthorizationContext.mockResolvedValue({
      userId: "operator-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });

    const result = await claimGovernanceDispute(formData({ disputeId: "d1" }));
    expect(result).toEqual({ success: false, error: "没有权限处理该纠纷" });
    expect(claimDispute).not.toHaveBeenCalled();
  });

  it("NOT_FOUND/FORBIDDEN → 统一 deny；ALREADY_CLAIMED → 域内安全文案", async () => {
    claimDispute.mockRejectedValue(disputeError("DISPUTE_NOT_FOUND"));
    expect(await claimGovernanceDispute(formData({ disputeId: "x" }))).toEqual({
      success: false,
      error: "没有权限处理该纠纷",
    });

    claimDispute.mockRejectedValue(disputeError("DISPUTE_ALREADY_CLAIMED"));
    expect(await claimGovernanceDispute(formData({ disputeId: "x" }))).toEqual({
      success: false,
      error: "该纠纷已被其他审核员领用",
    });
  });

  it("参数缺失 → 参数错误（不进入服务）", async () => {
    const result = await claimGovernanceDispute(formData({}));
    expect(result.success).toBe(false);
    expect(claimDispute).not.toHaveBeenCalled();
  });

  it("release happy path", async () => {
    releaseDispute.mockResolvedValue({ disputeId: "d1", assignedToId: null, outcome: "RELEASED" });
    const result = await releaseGovernanceDispute(formData({ disputeId: "d1" }));
    expect(result).toEqual({ success: true, outcome: "RELEASED" });
  });
});

describe("resolveGovernanceDispute / closeGovernanceDispute", () => {
  it("resolve 透传 resolutionCode/action/adminNote", async () => {
    resolveDispute.mockResolvedValue({ disputeId: "d1", status: "RESOLVED", orderStatus: "IN_RENTAL", releasedHolds: 2 });

    const result = await resolveGovernanceDispute(
      formData({ disputeId: "d1", resolutionCode: "MUTUAL_AGREEMENT", resolutionAction: "RESTORE_PREVIOUS", adminNote: "ok" }),
    );

    expect(result.success).toBe(true);
    expect(resolveDispute).toHaveBeenCalledWith({
      actorId: "operator-1",
      disputeId: "d1",
      resolutionCode: "MUTUAL_AGREEMENT",
      resolutionAction: "RESTORE_PREVIOUS",
      adminNote: "ok",
    });
  });

  it("RESTORE_UNAVAILABLE → 域内安全文案（非统一 deny）", async () => {
    resolveDispute.mockRejectedValue(disputeError("DISPUTE_RESTORE_UNAVAILABLE"));
    const result = await resolveGovernanceDispute(
      formData({ disputeId: "d1", resolutionCode: "OTHER", resolutionAction: "RESTORE_PREVIOUS" }),
    );
    expect(result).toEqual({ success: false, error: "无法确定订单纠纷前状态，不能执行恢复" });
  });

  it("release/resolve 零 access → 统一 deny（canonical 服务零调用）", async () => {
    loadAuthorizationContext.mockResolvedValue({
      userId: "operator-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });
    expect(await releaseGovernanceDispute(formData({ disputeId: "d1" }))).toEqual({
      success: false,
      error: "没有权限处理该纠纷",
    });
    expect(await resolveGovernanceDispute(
      formData({ disputeId: "d1", resolutionCode: "OTHER", resolutionAction: "CLOSE_ORDER" }),
    )).toEqual({ success: false, error: "没有权限处理该纠纷" });
    expect(releaseDispute).not.toHaveBeenCalled();
    expect(resolveDispute).not.toHaveBeenCalled();
  });

  it("release/resolve/close 错误分支：RELEASE_FORBIDDEN 统一 deny；域错误保留文案；非域错误走 fallback", async () => {
    releaseDispute.mockRejectedValue(disputeError("DISPUTE_RELEASE_FORBIDDEN"));
    expect(await releaseGovernanceDispute(formData({ disputeId: "x" }))).toEqual({
      success: false,
      error: "没有权限处理该纠纷",
    });

    closeDispute.mockRejectedValue(disputeError("DISPUTE_INVALID_TRANSITION"));
    expect(
      await closeGovernanceDispute(formData({ disputeId: "d1", resolutionAction: "CLOSE_ORDER" })),
    ).toEqual({ success: false, error: "纠纷当前状态不允许此操作" });

    resolveDispute.mockRejectedValue(new Error("boom"));
    const fallback = await resolveGovernanceDispute(
      formData({ disputeId: "d1", resolutionCode: "OTHER", resolutionAction: "CLOSE_ORDER" }),
    );
    expect(fallback.success).toBe(false);
  });

  it("close 透传 action；非法枚举 → 参数错误", async () => {
    closeDispute.mockResolvedValue({ disputeId: "d1", status: "CLOSED", orderStatus: "CLOSED", releasedHolds: 2 });
    const result = await closeGovernanceDispute(
      formData({ disputeId: "d1", resolutionAction: "CLOSE_ORDER" }),
    );
    expect(result.success).toBe(true);

    const bad = await closeGovernanceDispute(
      formData({ disputeId: "d1", resolutionAction: "NOT_AN_ACTION" }),
    );
    expect(bad.success).toBe(false);
    expect(closeDispute).toHaveBeenCalledTimes(1);
  });
});
