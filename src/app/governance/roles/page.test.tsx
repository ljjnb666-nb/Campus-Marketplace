import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireUser,
  loadAuthorizationContext,
  loadManageableRoleCampuses,
  loadManagedRoleAssignments,
  grantGovernanceRole,
  lookupRoleGrantCandidate,
  revokeGovernanceRole,
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  loadManageableRoleCampuses: vi.fn(),
  loadManagedRoleAssignments: vi.fn(),
  grantGovernanceRole: vi.fn(),
  lookupRoleGrantCandidate: vi.fn(),
  revokeGovernanceRole: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext,
}));

vi.mock("@/lib/rbac/role-assignment-query", () => ({
  loadManageableRoleCampuses,
  loadManagedRoleAssignments,
}));

vi.mock("@/actions/governance-roles", () => ({
  grantGovernanceRole,
  lookupRoleGrantCandidate,
  revokeGovernanceRole,
}));

import GovernanceRolesPage from "@/app/governance/roles/page";

/**
 * Phase 7B 冻结矩阵 UI/页面测试：/governance/roles 渲染与自守。
 * deriveRoleManageAccess 为真实实现（纯函数）——普通学生 → notFound；
 * DTO 最小面渲染（无内部 key/PII）；cursor 安全失败态；下一页链接。
 */

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockManager() {
  requireUser.mockResolvedValue({ id: "mgr-1", email: "m@x", name: "管理员" });
  loadAuthorizationContext.mockResolvedValue({
    userId: "mgr-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [
      {
        roleKey: "PLATFORM_ADMIN",
        scope: "GLOBAL",
        campusId: null,
        permissionKeys: ["rbac.role.assign"],
      },
    ],
  });
}

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "asg-1",
    roleKey: "CAMPUS_APPEAL_REVIEWER",
    campusName: "主校区",
    userDisplayName: "张审核员",
    assignedByDisplayName: "管理员",
    assignedAt: new Date("2026-09-12T08:00:00.000Z").toISOString(),
    ...overrides,
  };
}

describe("GovernanceRolesPage（/governance/roles）", () => {
  it("普通学生（零 grant）→ notFound（页面自守，query 零调用）", async () => {
    requireUser.mockResolvedValue({ id: "u1", email: "u@x", name: "学生" });
    loadAuthorizationContext.mockResolvedValue({
      userId: "u1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });

    await expect(
      GovernanceRolesPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(loadManagedRoleAssignments).not.toHaveBeenCalled();
  });

  it("渲染标题/授予表单/assignment 行（角色标签 + 授予人），不渲染内部 key", async () => {
    mockManager();
    loadManageableRoleCampuses.mockResolvedValue([{ id: "campus-a", name: "主校区" }]);
    loadManagedRoleAssignments.mockResolvedValue({
      items: [baseItem()],
      nextCursor: null,
    });

    render(await GovernanceRolesPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "角色管理" })).toBeTruthy();
    expect(screen.getByText("管理校园治理角色的授予与撤回")).toBeTruthy();
    expect(screen.getByText("将授予：校区申诉审核员")).toBeTruthy();
    expect(screen.getByText("用户：张审核员")).toBeTruthy();
    expect(screen.getByText("授予人：管理员")).toBeTruthy();
    expect(screen.getByText("校区申诉审核员")).toBeTruthy();
    expect(screen.getByText("校区：主校区")).toBeTruthy();
    expect(screen.getByRole("button", { name: "撤回" })).toBeTruthy();
    // DTO 无内部 roleKey 回显
    expect(screen.queryByText("CAMPUS_APPEAL_REVIEWER")).toBeNull();
    // 无下一页
    expect(screen.queryByRole("link", { name: "下一页" })).toBeNull();
  });

  it("allowlist 外 roleKey → 「未知角色」兜底（内部 key 永不回显）", async () => {
    mockManager();
    loadManageableRoleCampuses.mockResolvedValue([]);
    loadManagedRoleAssignments.mockResolvedValue({
      items: [baseItem({ roleKey: "FUTURE_ROLE" })],
      nextCursor: null,
    });

    render(await GovernanceRolesPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("未知角色")).toBeTruthy();
    expect(screen.queryByText("FUTURE_ROLE")).toBeNull();
  });

  it("畸形 cursor → 安全失败态（读模型零调用）", async () => {
    mockManager();
    loadManageableRoleCampuses.mockResolvedValue([{ id: "campus-a", name: "主校区" }]);

    render(await GovernanceRolesPage({ searchParams: Promise.resolve({ cursor: "!!bad!!" }) }));

    expect(screen.getByText(/分页链接无效/)).toBeTruthy();
    expect(loadManagedRoleAssignments).not.toHaveBeenCalled();
  });

  it("nextCursor → 下一页链接（cursor 经 encodeURIComponent）", async () => {
    mockManager();
    loadManageableRoleCampuses.mockResolvedValue([{ id: "campus-a", name: "主校区" }]);
    loadManagedRoleAssignments.mockResolvedValue({
      items: [baseItem()],
      nextCursor: "CURSOR==",
    });

    render(await GovernanceRolesPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("link", { name: "下一页" }).getAttribute("href"),
    ).toBe("/governance/roles?cursor=CURSOR%3D%3D&limit=25");
  });

  it("空列表 → 空态文案；非法 limit 回退默认 25", async () => {
    mockManager();
    loadManageableRoleCampuses.mockResolvedValue([]);
    loadManagedRoleAssignments.mockResolvedValue({ items: [], nextCursor: null });

    render(
      await GovernanceRolesPage({ searchParams: Promise.resolve({ limit: "9999" }) }),
    );

    expect(screen.getByText("当前没有可管理的角色授予。")).toBeTruthy();
    expect(loadManagedRoleAssignments.mock.calls[0]![0].limit).toBe(25);
  });

  it("零可授校区 → picker 空态提示", async () => {
    mockManager();
    loadManageableRoleCampuses.mockResolvedValue([]);
    loadManagedRoleAssignments.mockResolvedValue({ items: [], nextCursor: null });

    render(await GovernanceRolesPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("当前没有可授予新角色的校区。")).toBeTruthy();
  });
});
