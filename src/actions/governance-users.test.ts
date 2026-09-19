import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePathMock,
  requireUserMock,
  loadAuthorizationContextMock,
  suspendAccountMock,
  reinstateAccountMock,
} = vi.hoisted(() => ({
  revalidatePathMock: vi.fn(),
  requireUserMock: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  suspendAccountMock: vi.fn(),
  reinstateAccountMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: requireUserMock,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext: loadAuthorizationContextMock,
  // deriveUserOperationsAccess 依赖 hasPermission（GLOBAL-only 语义的忠实
  // 最小实现，仅供本测试的 mock context 使用）
  hasPermission: (
    context:
      | {
          accountActive?: boolean;
          grants?: Array<{ scope: string; campusId: string | null; permissionKeys: string[] }>;
        }
      | null,
    permission: string,
  ) =>
    Boolean(
      context?.accountActive &&
        context.grants?.some(
          (grant) => grant.scope === "GLOBAL" && grant.permissionKeys.includes(permission),
        ),
    ),
}));

vi.mock("@/lib/enforcement/account-enforcement-service", () => ({
  suspendAccount: suspendAccountMock,
  reinstateAccount: reinstateAccountMock,
}));

import {
  reinstateGovernanceUser,
  suspendGovernanceUser,
} from "@/actions/governance-users";
import { EnforcementError } from "@/lib/enforcement/errors";

/**
 * Phase 7F 薄 adapter 合同（7A/7E 同款冻结约定）：
 * - actor 身份仅来自 requireUser；target userId server validated；
 * - 非 GLOBAL user.suspend → uniform deny（不触发 canonical seam）；
 * - canonical 调用透传 actor/target；missing/privileged/self deny 家族统一文案；
 * - revalidate 用户队列 + 详情 + 执法读面。
 */

function formData(entries: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    form.set(key, value);
  }
  return form;
}

function globalSuspendContext() {
  return {
    userId: "admin-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [
      { roleKey: "OP", scope: "GLOBAL" as const, campusId: null, permissionKeys: ["user.suspend"] },
    ],
  };
}

function emptyContext() {
  return { userId: "admin-1", accountActive: true, activeCampusIds: [], grants: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue({ id: "admin-1", email: "a@x", name: "A", role: "ADMIN" });
  loadAuthorizationContextMock.mockResolvedValue(globalSuspendContext());
});

describe("suspendGovernanceUser / reinstateGovernanceUser（薄 adapter）", () => {
  it("无权限 → uniform deny，不触发 canonical seam", async () => {
    loadAuthorizationContextMock.mockResolvedValue(emptyContext());

    const result = await suspendGovernanceUser(formData({ userId: "user-1" }));

    expect(result).toEqual({ success: false, error: "没有权限管理该账号" });
    expect(suspendAccountMock).not.toHaveBeenCalled();
  });

  it("非法 userId → zod 文案；不触发 requireUser 之后的链路", async () => {
    const result = await suspendGovernanceUser(formData({ userId: " " }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("用户 id");
    expect(suspendAccountMock).not.toHaveBeenCalled();
  });

  it("授权 → canonical suspendAccount 透传 + revalidate", async () => {
    suspendAccountMock.mockResolvedValue({ status: "SUSPENDED", alreadyInState: false, notificationDelivered: true });

    const result = await suspendGovernanceUser(formData({ userId: "user-1" }));

    expect(result).toEqual({ success: true });
    expect(suspendAccountMock).toHaveBeenCalledWith({
      actorId: "admin-1",
      targetUserId: "user-1",
      reasonCode: "MANUAL_REVIEW",
      sourceType: "GOVERNANCE_ACTION",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/users");
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/users/user-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/enforcement");
  });

  it("missing/privileged/self deny 家族 → 统一 uniform deny（无 oracle）", async () => {
    for (const code of [
      "ENFORCEMENT_TARGET_NOT_FOUND",
      "ENFORCEMENT_PRIVILEGED_TARGET",
      "ENFORCEMENT_SELF_DENIED",
    ] as const) {
      suspendAccountMock.mockRejectedValueOnce(new EnforcementError(code, "内部文案"));
      const result = await suspendGovernanceUser(formData({ userId: "user-1" }));
      expect(result).toEqual({ success: false, error: "没有权限管理该账号" });
    }
  });

  it("幂等 already-in-state → 域内安全文案透出", async () => {
    suspendAccountMock.mockRejectedValueOnce(
      new EnforcementError("ENFORCEMENT_INVALID_TRANSITION", "当前状态不允许该操作"),
    );

    const result = await suspendGovernanceUser(formData({ userId: "user-1" }));

    expect(result).toEqual({ success: false, error: "当前状态不允许该操作" });
  });

  it("reinstate → canonical reinstateAccount 透传", async () => {
    reinstateAccountMock.mockResolvedValue({ status: "ACTIVE", alreadyInState: false, notificationDelivered: true });

    const result = await reinstateGovernanceUser(formData({ userId: "user-1" }));

    expect(result).toEqual({ success: true });
    expect(reinstateAccountMock).toHaveBeenCalledWith({
      actorId: "admin-1",
      targetUserId: "user-1",
      reasonCode: "MANUAL_REVIEW",
      sourceType: "GOVERNANCE_ACTION",
    });
  });
});
