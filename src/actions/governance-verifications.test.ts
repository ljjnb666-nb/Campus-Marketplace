import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePathMock,
  requireUserMock,
  loadAuthorizationContextMock,
  decideMembershipVerificationMock,
} = vi.hoisted(() => ({
  revalidatePathMock: vi.fn(),
  requireUserMock: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  decideMembershipVerificationMock: vi.fn(),
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

vi.mock("@/lib/campus/verification-service", () => ({
  decideMembershipVerification: decideMembershipVerificationMock,
}));

import { reviewGovernanceVerification } from "@/actions/governance-verifications";
import { RbacError } from "@/lib/rbac/errors";

/**
 * Phase 7F 薄 adapter 合同（7A/7E 同款冻结约定）：
 * - actor 身份仅来自 requireUser；verificationId/decision/note server validated；
 * - 零有效 verification review scope → uniform deny（不触发 canonical 状态机）；
 * - missing/越权 → 统一文案；自审/非法流转/membership 失效保留域内安全文案；
 * - 不复制 transition table：schema 只挡明显非法输入，合法性由状态机断言。
 */

function formData(entries: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    form.set(key, value);
  }
  return form;
}

function campusAccessContext() {
  return {
    userId: "reviewer-1",
    accountActive: true,
    activeCampusIds: ["A"],
    grants: [
      {
        roleKey: "CAMPUS_VERIFICATION_REVIEWER",
        scope: "CAMPUS" as const,
        campusId: "A",
        permissionKeys: ["verification.review", "verification.evidence.read"],
      },
    ],
  };
}

function emptyContext() {
  return { userId: "reviewer-1", accountActive: true, activeCampusIds: [], grants: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue({ id: "reviewer-1", email: "r@x", name: "R", role: "STUDENT" });
  loadAuthorizationContextMock.mockResolvedValue(campusAccessContext());
});

describe("reviewGovernanceVerification（薄 adapter）", () => {
  it("非法 decision → zod 文案；不触发状态机", async () => {
    const result = await reviewGovernanceVerification(
      formData({ verificationId: "v-1", decision: "PENDING" }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(decideMembershipVerificationMock).not.toHaveBeenCalled();
  });

  it("零有效 scope → uniform deny，不触发状态机", async () => {
    loadAuthorizationContextMock.mockResolvedValue(emptyContext());

    const result = await reviewGovernanceVerification(
      formData({ verificationId: "v-1", decision: "VERIFIED" }),
    );

    expect(result).toEqual({ success: false, error: "没有权限审核该认证申请" });
    expect(decideMembershipVerificationMock).not.toHaveBeenCalled();
  });

  it("授权 → canonical decideMembershipVerification 透传（含 note/reasonCode）+ revalidate", async () => {
    decideMembershipVerificationMock.mockResolvedValue({ id: "v-1", status: "VERIFIED" });

    const result = await reviewGovernanceVerification(
      formData({
        verificationId: "v-1",
        decision: "REJECTED",
        reviewNote: "材料模糊",
        reasonCode: "VERIFICATION_MATERIALS_INVALID",
      }),
    );

    expect(result).toEqual({ success: true });
    expect(decideMembershipVerificationMock).toHaveBeenCalledWith({
      actorId: "reviewer-1",
      verificationId: "v-1",
      decision: "REJECTED",
      reviewNote: "材料模糊",
      reasonCode: "VERIFICATION_MATERIALS_INVALID",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/verifications");
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/verifications/v-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/verification");
    expect(revalidatePathMock).toHaveBeenCalledWith("/notifications");
  });

  it("missing/越权 deny 家族 → uniform deny（无 oracle）；域内文案透出", async () => {
    for (const code of [
      "VERIFICATION_NOT_FOUND",
      "AUTH_PERMISSION_DENIED",
      "AUTH_CAMPUS_SCOPE_MISMATCH",
    ] as const) {
      decideMembershipVerificationMock.mockRejectedValueOnce(new RbacError(code, "内部文案"));
      const result = await reviewGovernanceVerification(
        formData({ verificationId: "v-1", decision: "VERIFIED" }),
      );
      expect(result).toEqual({ success: false, error: "没有权限审核该认证申请" });
    }

    decideMembershipVerificationMock.mockRejectedValueOnce(
      new RbacError("VERIFICATION_SELF_REVIEW_DENIED", "不能审核自己提交的认证申请"),
    );
    const selfReview = await reviewGovernanceVerification(
      formData({ verificationId: "v-1", decision: "VERIFIED" }),
    );
    expect(selfReview).toEqual({ success: false, error: "不能审核自己提交的认证申请" });

    decideMembershipVerificationMock.mockRejectedValueOnce(
      new RbacError("VERIFICATION_INVALID_TRANSITION", "认证当前状态不允许此操作"),
    );
    const transition = await reviewGovernanceVerification(
      formData({ verificationId: "v-1", decision: "REVOKED" }),
    );
    expect(transition).toEqual({ success: false, error: "认证当前状态不允许此操作" });
  });
});
