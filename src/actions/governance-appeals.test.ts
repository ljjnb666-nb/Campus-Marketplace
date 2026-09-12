import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePathMock,
  requireUserMock,
  loadAuthorizationContextMock,
  hasPermissionMock,
  beginAppealReviewMock,
  decideAppealMock,
} = vi.hoisted(() => ({
  revalidatePathMock: vi.fn(),
  requireUserMock: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  beginAppealReviewMock: vi.fn(),
  decideAppealMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: requireUserMock,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext: loadAuthorizationContextMock,
  hasPermission: hasPermissionMock,
}));

vi.mock("@/lib/appeals/appeal-review-service", () => ({
  beginAppealReview: beginAppealReviewMock,
  decideAppeal: decideAppealMock,
}));

import {
  beginGovernanceAppealReview,
  decideGovernanceAppeal,
} from "@/actions/governance-appeals";
import { AppealError } from "@/lib/appeals/errors";

/**
 * Phase 7A 薄 adapter 合同（Planning §26/§28/§29 冻结）：
 * - reviewer 身份仅来自 requireUser（GOV-03：FormData 身份字段结构性无效）；
 * - missing/malformed/越权/appellant-self → 统一文案（无存在性 oracle）；
 * - 程序性 DISMISSED = 成功结局回传（GOV-09）；
 * - revalidate 仅治理路由；
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
      { roleKey: "R", scope: "GLOBAL" as const, campusId: null, permissionKeys: ["appeal.review"] },
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

describe("beginGovernanceAppealReview", () => {
  it("thin adapter：server 身份 → beginAppealReview → revalidate 治理路由", async () => {
    beginAppealReviewMock.mockResolvedValue(undefined);

    const state = await beginGovernanceAppealReview(formData({ appealId: "ap-1" }));

    expect(state.success).toBe(true);
    expect(beginAppealReviewMock).toHaveBeenCalledWith({
      reviewerId: "reviewer-1",
      appealId: "ap-1",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/appeals");
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/appeals/ap-1");
  });

  it("FormData 伪造 reviewerId 不进入域调用（身份仅服务端）", async () => {
    beginAppealReviewMock.mockResolvedValue(undefined);

    await beginGovernanceAppealReview(
      formData({ appealId: "ap-1", reviewerId: "attacker", campusId: "B" }),
    );

    expect(beginAppealReviewMock).toHaveBeenCalledWith({
      reviewerId: "reviewer-1",
      appealId: "ap-1",
    });
  });

  it("缺失 appealId → 参数无效，不触发域", async () => {
    const state = await beginGovernanceAppealReview(formData({}));
    expect(state.success).toBe(false);
    expect(beginAppealReviewMock).not.toHaveBeenCalled();
  });

  it("无有效 access → 统一拒绝且不触发域（fail-fast）", async () => {
    loadAuthorizationContextMock.mockResolvedValue(emptyAccessContext());

    const state = await beginGovernanceAppealReview(formData({ appealId: "ap-1" }));

    expect(state).toEqual({ success: false, error: "没有权限审核该申诉" });
    expect(beginAppealReviewMock).not.toHaveBeenCalled();
  });

  it("APPEAL_INVALID_TRANSITION → 域用户文案", async () => {
    beginAppealReviewMock.mockRejectedValue(
      new AppealError("APPEAL_INVALID_TRANSITION", "当前状态不允许该操作"),
    );

    const state = await beginGovernanceAppealReview(formData({ appealId: "ap-1" }));

    expect(state).toEqual({ success: false, error: "当前状态不允许该操作" });
  });
});

describe.each([
  "APPEAL_NOT_FOUND",
  "APPEAL_NOT_OWNED",
  "APPEAL_SCOPE_MISMATCH",
  "APPEAL_REVIEW_FORBIDDEN",
  "APPEAL_REVIEWER_IS_APPELLANT",
] as const)("deny 家族统一文案：%s", (code) => {
  it("begin 与 decide 均统一为不可区分文案", async () => {
    beginAppealReviewMock.mockRejectedValue(new AppealError(code, "任意原文案"));
    decideAppealMock.mockRejectedValue(new AppealError(code, "任意原文案"));

    const beginState = await beginGovernanceAppealReview(formData({ appealId: "ap-1" }));
    const decideState = await decideGovernanceAppeal(
      formData({ appealId: "ap-1", decision: "UPHELD" }),
    );

    expect(beginState.error).toBe("没有权限审核该申诉");
    expect(decideState.error).toBe("没有权限审核该申诉");
  });
});

describe("decideGovernanceAppeal", () => {
  it("thin adapter：decision/decisionNote 透传 canonical decideAppeal", async () => {
    decideAppealMock.mockResolvedValue({
      outcome: "UPHELD",
      reasonCode: "MERIT_VIOLATION_CONFIRMED",
      appeal: { id: "ap-1", status: "UPHELD" },
    });

    const state = await decideGovernanceAppeal(
      formData({ appealId: "ap-1", decision: "UPHELD", decisionNote: "  维持  " }),
    );

    expect(state).toEqual({
      success: true,
      outcome: "UPHELD",
      reasonCode: "MERIT_VIOLATION_CONFIRMED",
    });
    // validator z.string().trim() 先行收敛空白；域内再 trim/长度校验（域为权威）
    expect(decideAppealMock).toHaveBeenCalledWith({
      reviewerId: "reviewer-1",
      appealId: "ap-1",
      decision: "UPHELD",
      decisionNote: "维持",
    });
  });

  it("operator 选 GRANTED 而域判程序性 DISMISSED → 成功结局回传（A-09/GOV-09）", async () => {
    decideAppealMock.mockResolvedValue({
      outcome: "DISMISSED",
      reasonCode: "STALE_ENFORCEMENT",
      appeal: { id: "ap-1", status: "DISMISSED" },
    });

    const state = await decideGovernanceAppeal(
      formData({ appealId: "ap-1", decision: "GRANTED" }),
    );

    expect(state.success).toBe(true);
    expect(state.outcome).toBe("DISMISSED");
    expect(state.reasonCode).toBe("STALE_ENFORCEMENT");
  });

  it("空备注 → decisionNote=null 透传", async () => {
    decideAppealMock.mockResolvedValue({ outcome: "UPHELD", reasonCode: null });

    await decideGovernanceAppeal(formData({ appealId: "ap-1", decision: "UPHELD" }));

    expect(decideAppealMock).toHaveBeenCalledWith({
      reviewerId: "reviewer-1",
      appealId: "ap-1",
      decision: "UPHELD",
      decisionNote: null,
    });
  });

  it("decision 非法值 → 参数错误，不触发域", async () => {
    const state = await decideGovernanceAppeal(
      formData({ appealId: "ap-1", decision: "DISMISSED" }),
    );
    expect(state.success).toBe(false);
    expect(decideAppealMock).not.toHaveBeenCalled();
  });
});
