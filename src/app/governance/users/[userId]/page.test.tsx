import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireUserOperationsAdmin,
  loadUserOperationsDetail,
  suspendGovernanceUser,
  reinstateGovernanceUser,
} = vi.hoisted(() => ({
  requireUserOperationsAdmin: vi.fn(),
  loadUserOperationsDetail: vi.fn(),
  suspendGovernanceUser: vi.fn(),
  reinstateGovernanceUser: vi.fn(),
}));

vi.mock("@/lib/governance/user-operations-access", () => ({
  requireUserOperationsAdmin,
}));

vi.mock("@/lib/governance/user-operations-query", () => ({
  loadUserOperationsDetail,
}));

vi.mock("@/actions/governance-users", () => ({
  suspendGovernanceUser,
  reinstateGovernanceUser,
}));

import GovernanceUserDetailPage from "@/app/governance/users/[userId]/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockAdmin() {
  requireUserOperationsAdmin.mockResolvedValue({
    user: { id: "admin-1", email: "a@x", name: "管理员", role: "ADMIN" },
  });
}

function baseDetail(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    displayName: "张同学",
    maskedEmail: "zh***@example.com",
    status: "ACTIVE",
    createdAt: new Date("2026-09-16T08:00:00.000Z").toISOString(),
    lastLoginAt: null,
    memberships: [{ campusName: "主校区", status: "ACTIVE" }],
    verificationStatus: "PENDING",
    riskStates: [],
    ...overrides,
  };
}

describe("GovernanceUserDetailPage（用户详情，两阶段读 + canonical 账号操作）", () => {
  it("missing / 统一 deny → notFound（无存在性 oracle）", async () => {
    mockAdmin();
    loadUserOperationsDetail.mockResolvedValue({ ok: false });

    await expect(
      GovernanceUserDetailPage({ params: Promise.resolve({ userId: "ghost" }) }),
    ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(loadUserOperationsDetail).toHaveBeenCalledWith({ userId: "ghost" });
  });

  it("渲染安全详情（maskedEmail/校区身份/风控摘要/canonical 执法链接），ACTIVE → 停用表单", async () => {
    mockAdmin();
    loadUserOperationsDetail.mockResolvedValue({ ok: true, detail: baseDetail() });

    render(await GovernanceUserDetailPage({ params: Promise.resolve({ userId: "user-1" }) }));

    expect(screen.getByRole("heading", { name: "张同学" })).toBeTruthy();
    expect(screen.getByText("邮箱：zh***@example.com")).toBeTruthy();
    expect(screen.getByText("正常")).toBeTruthy();
    expect(screen.getByText("审核中")).toBeTruthy();
    expect(screen.getByText("主校区 · 生效")).toBeTruthy();
    expect(screen.getByText("当前无风控限制记录。")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "查看执法记录（canonical 读面）→" }).getAttribute("href"),
    ).toBe("/governance/enforcement/targets/user-1");
    expect(screen.getByRole("form", { name: "停用账号" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "恢复账号" })).toBeNull();
  });

  it("SUSPENDED → 恢复表单；risk-state 摘要呈现", async () => {
    mockAdmin();
    loadUserOperationsDetail.mockResolvedValue({
      ok: true,
      detail: baseDetail({
        status: "SUSPENDED",
        riskStates: [{ scopeKey: "GLOBAL", state: "MARKETPLACE_RESTRICTED", reasonCode: "MANUAL_REVIEW" }],
      }),
    });

    render(await GovernanceUserDetailPage({ params: Promise.resolve({ userId: "user-1" }) }));

    expect(screen.getByRole("form", { name: "恢复账号" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "停用账号" })).toBeNull();
    expect(screen.getByText(/受限/)).toBeTruthy();
    expect(screen.getByText(/MANUAL_REVIEW/)).toBeTruthy();
  });
});
