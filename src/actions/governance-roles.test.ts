import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePathMock,
  requireUserMock,
  loadAuthorizationContextMock,
  resolveGrantEligibleCampusMock,
  resolveGrantCandidateMock,
  resolveRevocableAssignmentMock,
  assignRoleMock,
  revokeRoleMock,
} = vi.hoisted(() => ({
  revalidatePathMock: vi.fn(),
  requireUserMock: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  resolveGrantEligibleCampusMock: vi.fn(),
  resolveGrantCandidateMock: vi.fn(),
  resolveRevocableAssignmentMock: vi.fn(),
  assignRoleMock: vi.fn(),
  revokeRoleMock: vi.fn(),
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
}));

vi.mock("@/lib/rbac/role-assignment-query", () => ({
  resolveGrantEligibleCampus: resolveGrantEligibleCampusMock,
  resolveGrantCandidate: resolveGrantCandidateMock,
  resolveRevocableAssignment: resolveRevocableAssignmentMock,
  // loadManagedRoleAssignments / loadManageableRoleCampuses 仅供页面使用
}));

vi.mock("@/lib/rbac/assignment-service", () => ({
  assignRole: assignRoleMock,
  revokeRole: revokeRoleMock,
}));

import {
  grantGovernanceRole,
  lookupRoleGrantCandidate,
  revokeGovernanceRole,
} from "@/actions/governance-roles";
import { RbacError } from "@/lib/rbac/errors";

/**
 * Phase 7B 薄 adapter 合同（Planning Repair + P1 冻结）：
 * - actor 身份仅来自 requireUser（FormData 身份字段结构性无效）；
 * - roleKey 服务器所有（validator .strict() 拒绝注入；canonical 恒收
 *   CAMPUS_APPEAL_REVIEWER）；
 * - P1 顺序：eligibility（Campus isActive）先于 User email lookup；
 * - malformed/missing/越权/inactive/跨校区/unmanaged → 统一文案；
 * - canonical RbacError 机器码/原文案不外泄。
 */

const UNIFORM_DENY = "没有权限执行该角色管理操作";

function activeUser(id = "manager-1") {
  return { id, email: "manager@x", name: "管理员" };
}

function globalManagerContext() {
  return {
    userId: "manager-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [
      {
        roleKey: "PLATFORM_ADMIN",
        scope: "GLOBAL" as const,
        campusId: null,
        permissionKeys: ["rbac.role.assign"],
      },
    ],
  };
}

function campusManagerContext(campusId = "campus-a") {
  return {
    userId: "manager-1",
    accountActive: true,
    activeCampusIds: [campusId],
    grants: [
      {
        roleKey: "CAMPUS_ROLE_MANAGER",
        scope: "CAMPUS" as const,
        campusId,
        permissionKeys: ["rbac.role.assign"],
      },
    ],
  };
}

function emptyAccessContext() {
  return {
    userId: "manager-1",
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

function grantForm(overrides: Record<string, string> = {}) {
  return formData({ campusId: "campus-a", email: "user@campus.edu", ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue(activeUser());
  loadAuthorizationContextMock.mockResolvedValue(globalManagerContext());
  resolveGrantEligibleCampusMock.mockResolvedValue({ id: "campus-a" });
  resolveGrantCandidateMock.mockResolvedValue({ id: "target-1", name: "张三" });
  resolveRevocableAssignmentMock.mockResolvedValue(null);
});

describe("lookupRoleGrantCandidate", () => {
  it("A01：命中 → 仅回传 displayName（email 不回显）", async () => {
    const state = await lookupRoleGrantCandidate(grantForm());

    expect(state).toEqual({ success: true, displayName: "张三" });
    expect(resolveGrantCandidateMock).toHaveBeenCalledWith({
      campusId: "campus-a",
      email: "user@campus.edu",
    });
  });

  it("A03：无 rbac.role.assign → 统一拒绝且不触发 eligibility/candidate", async () => {
    loadAuthorizationContextMock.mockResolvedValue(emptyAccessContext());

    const state = await lookupRoleGrantCandidate(grantForm());

    expect(state).toEqual({ success: false, error: UNIFORM_DENY });
    expect(resolveGrantEligibleCampusMock).not.toHaveBeenCalled();
    expect(resolveGrantCandidateMock).not.toHaveBeenCalled();
  });

  it("A04：campus actor 请求他校区 → 统一拒绝（不触发任何目标查询）", async () => {
    loadAuthorizationContextMock.mockResolvedValue(campusManagerContext("campus-a"));

    const state = await lookupRoleGrantCandidate(grantForm({ campusId: "campus-b" }));

    expect(state).toEqual({ success: false, error: UNIFORM_DENY });
    expect(resolveGrantEligibleCampusMock).not.toHaveBeenCalled();
    expect(resolveGrantCandidateMock).not.toHaveBeenCalled();
  });

  it("A02：requireUser 抛出（未登录/不可用）→ error state 而非崩溃", async () => {
    requireUserMock.mockRejectedValue(new Error("redirect:login"));

    const state = await lookupRoleGrantCandidate(grantForm());

    expect(state.success).toBe(false);
    expect(typeof state.error).toBe("string");
  });

  it("A08：malformed 输入与授权失败同文案（无差异信号）", async () => {
    const malformed = await lookupRoleGrantCandidate(formData({ campusId: "campus-a" }));
    const badEmail = await lookupRoleGrantCandidate(
      formData({ campusId: "campus-a", email: "not-an-email" }),
    );

    expect(malformed).toEqual({ success: false, error: UNIFORM_DENY });
    expect(badEmail).toEqual({ success: false, error: UNIFORM_DENY });
    expect(resolveGrantCandidateMock).not.toHaveBeenCalled();
  });

  it("R06：失败家族（用户缺失/停用/无 membership/cross-campus/未授权）同文案", async () => {
    resolveGrantCandidateMock.mockResolvedValue(null);
    const candidateMiss = await lookupRoleGrantCandidate(grantForm());

    loadAuthorizationContextMock.mockResolvedValue(campusManagerContext("campus-a"));
    const crossCampus = await lookupRoleGrantCandidate(
      grantForm({ campusId: "campus-z" }),
    );
    const unauthorized = await lookupRoleGrantCandidate(grantForm());
    loadAuthorizationContextMock.mockResolvedValue(emptyAccessContext());
    const noPermission = await lookupRoleGrantCandidate(grantForm());

    for (const state of [candidateMiss, crossCampus, unauthorized, noPermission]) {
      expect(state).toEqual({ success: false, error: UNIFORM_DENY });
    }
  });
});

describe("grantGovernanceRole", () => {
  it("happy path：canonical assignRole 收服务器所有字段 → revalidate /governance/roles", async () => {
    assignRoleMock.mockResolvedValue({ created: true, assignment: { id: "asg-1" } });

    const state = await grantGovernanceRole(grantForm());

    expect(state.success).toBe(true);
    expect(assignRoleMock).toHaveBeenCalledWith({
      actorId: "manager-1",
      targetUserId: "target-1",
      roleKey: "CAMPUS_APPEAL_REVIEWER",
      campusId: "campus-a",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/roles");
  });

  it("幂等 re-grant（created=false）→ 中性成功文案", async () => {
    assignRoleMock.mockResolvedValue({ created: false, assignment: { id: "asg-1" } });

    const state = await grantGovernanceRole(grantForm());

    expect(state.success).toBe(true);
    expect(state.message).toBe("该用户已持有该角色");
  });

  it("A05：伪造 roleKey（GLOBAL 键/未来 CAMPUS 键/任意串）→ strict 拒绝，assignRole 零调用，授予角色不可改变", async () => {
    for (const roleKey of ["PLATFORM_ADMIN", "FUTURE_CAMPUS_ROLE", "x"]) {
      const state = await grantGovernanceRole(grantForm({ roleKey }));
      expect(state).toEqual({ success: false, error: UNIFORM_DENY });
    }
    expect(assignRoleMock).not.toHaveBeenCalled();
  });

  it("A06：FormData 注入 actorId/targetUserId/assignedById → strict 拒绝，身份仅服务端", async () => {
    const state = await grantGovernanceRole(
      grantForm({ actorId: "attacker", targetUserId: "victim", assignedById: "attacker" }),
    );

    expect(state).toEqual({ success: false, error: UNIFORM_DENY });
    expect(assignRoleMock).not.toHaveBeenCalled();
  });

  it("A07：canonical self-deny（RbacError）→ 统一文案，机器码/原文案不外泄", async () => {
    assignRoleMock.mockRejectedValue(
      new RbacError("ROLE_ASSIGNMENT_SELF_DENIED", "不能变更自己的角色"),
    );

    const state = await grantGovernanceRole(grantForm({ email: "manager@x" }));

    expect(state).toEqual({ success: false, error: UNIFORM_DENY });
  });

  it("A13：eligibility null（inactive/不存在 campus）→ 统一拒绝 + assignRole 零调用", async () => {
    resolveGrantEligibleCampusMock.mockResolvedValue(null);

    const state = await grantGovernanceRole(grantForm());

    expect(state).toEqual({ success: false, error: UNIFORM_DENY });
    expect(assignRoleMock).not.toHaveBeenCalled();
  });

  it("A14：campus actor 上下文含 campus 但 eligibility null（isActive=false）→ 仍拒绝", async () => {
    loadAuthorizationContextMock.mockResolvedValue(campusManagerContext("campus-a"));
    resolveGrantEligibleCampusMock.mockResolvedValue(null);

    const state = await grantGovernanceRole(grantForm());

    expect(state).toEqual({ success: false, error: UNIFORM_DENY });
    expect(assignRoleMock).not.toHaveBeenCalled();
  });

  it("A15：inactive campus 请求 → User email candidate query = 0 calls（顺序：eligibility 先于 lookup）", async () => {
    resolveGrantEligibleCampusMock.mockResolvedValue(null);

    await grantGovernanceRole(grantForm());

    expect(resolveGrantCandidateMock).not.toHaveBeenCalled();
    // P1 顺序证明：eligibility 调用序先于 candidate（candidate 未调用即已证明；
    // 双 spy 调用序再锁一次 happy path）
    resolveGrantEligibleCampusMock.mockResolvedValue({ id: "campus-a" });
    await grantGovernanceRole(grantForm());
    expect(resolveGrantEligibleCampusMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveGrantCandidateMock.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("candidate 未命中（用户缺失/停用/无 ACTIVE membership）→ 统一拒绝 + assignRole 零调用", async () => {
    resolveGrantCandidateMock.mockResolvedValue(null);

    const state = await grantGovernanceRole(grantForm());

    expect(state).toEqual({ success: false, error: UNIFORM_DENY });
    expect(assignRoleMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("revokeGovernanceRole", () => {
  const revocable = {
    id: "asg-1",
    userId: "target-1",
    campusId: "campus-a",
    roleKey: "CAMPUS_APPEAL_REVIEWER",
  };

  it("happy path：canonical revokeRole 收服务器解析字段 + expectedAssignmentId（FR-02）→ revalidate", async () => {
    resolveRevocableAssignmentMock.mockResolvedValue(revocable);
    revokeRoleMock.mockResolvedValue({ removed: true });

    const state = await revokeGovernanceRole(formData({ assignmentId: "asg-1" }));

    expect(state).toEqual({ success: true, message: "已撤回该角色授予" });
    expect(revokeRoleMock).toHaveBeenCalledWith({
      actorId: "manager-1",
      targetUserId: "target-1",
      roleKey: "CAMPUS_APPEAL_REVIEWER",
      campusId: "campus-a",
      expectedAssignmentId: "asg-1",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/governance/roles");
  });

  it("removed=false（已不存在/已撤回）→ 中性幂等文案（非错误）", async () => {
    resolveRevocableAssignmentMock.mockResolvedValue(revocable);
    revokeRoleMock.mockResolvedValue({ removed: false });

    const state = await revokeGovernanceRole(formData({ assignmentId: "asg-1" }));

    expect(state).toEqual({ success: true, message: "该授予已不存在或已被撤回" });
  });

  it("A09：他校区 assignmentId 与不存在 assignmentId 同文案（存在性不可枚举）", async () => {
    resolveRevocableAssignmentMock.mockResolvedValue(null);

    const state = await revokeGovernanceRole(formData({ assignmentId: "asg-404" }));

    expect(state).toEqual({ success: false, error: UNIFORM_DENY });
    expect(revokeRoleMock).not.toHaveBeenCalled();
  });

  it("A10：unmanaged 角色的 assignmentId 不可经 7B 撤回（resolver null → 统一拒绝）", async () => {
    resolveRevocableAssignmentMock.mockResolvedValue(null);

    const state = await revokeGovernanceRole(formData({ assignmentId: "asg-global" }));

    expect(state).toEqual({ success: false, error: UNIFORM_DENY });
    expect(revokeRoleMock).not.toHaveBeenCalled();
  });

  it("A11：canonical self-revoke（RbacError）→ 统一文案", async () => {
    resolveRevocableAssignmentMock.mockResolvedValue(revocable);
    revokeRoleMock.mockRejectedValue(
      new RbacError("ROLE_ASSIGNMENT_SELF_DENIED", "不能变更自己的角色"),
    );

    const state = await revokeGovernanceRole(formData({ assignmentId: "asg-1" }));

    expect(state).toEqual({ success: false, error: UNIFORM_DENY });
  });

  it("malformed revoke（缺 assignmentId / 注入 targetUserId）→ 统一拒绝", async () => {
    const missing = await revokeGovernanceRole(formData({}));
    const injected = await revokeGovernanceRole(
      formData({ assignmentId: "asg-1", targetUserId: "victim" }),
    );

    expect(missing).toEqual({ success: false, error: UNIFORM_DENY });
    expect(injected).toEqual({ success: false, error: UNIFORM_DENY });
    expect(revokeRoleMock).not.toHaveBeenCalled();
  });
});
