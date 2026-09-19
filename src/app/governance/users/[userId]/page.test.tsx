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
    // FR01：canonical effective verification（非 legacy 投影）
    effectiveVerificationStatus: "PENDING",
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

  it("渲染安全详情（maskedEmail/校区身份/canonical 执法链接），ACTIVE → 停用表单", async () => {
    mockAdmin();
    loadUserOperationsDetail.mockResolvedValue({ ok: true, detail: baseDetail() });

    render(await GovernanceUserDetailPage({ params: Promise.resolve({ userId: "user-1" }) }));

    expect(screen.getByRole("heading", { name: "张同学" })).toBeTruthy();
    expect(screen.getByText("邮箱：zh***@example.com")).toBeTruthy();
    expect(screen.getByText("正常")).toBeTruthy();
    expect(screen.getByText("审核中")).toBeTruthy();
    expect(screen.getByText("主校区 · 生效")).toBeTruthy();
    // RS05：enforcement canonical 链接保留
    expect(
      screen.getByRole("link", { name: "查看执法记录（canonical 读面）→" }).getAttribute("href"),
    ).toBe("/governance/enforcement/targets/user-1");
    expect(screen.getByRole("form", { name: "停用账号" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "恢复账号" })).toBeNull();
  });

  it("SUSPENDED → 恢复表单；FR02 RS04：页面渲染零 risk-state 摘要（含传入数据也不渲染）", async () => {
    mockAdmin();
    loadUserOperationsDetail.mockResolvedValue({
      ok: true,
      detail: baseDetail({
        status: "SUSPENDED",
        // 即使 DTO 被注入 risk 形状数据（结构上不可能，防御性断言）也不渲染
        riskStates: [
          { scopeKey: "GLOBAL", state: "MARKETPLACE_RESTRICTED", reasonCode: "MANUAL_REVIEW" },
        ],
      }),
    });

    render(await GovernanceUserDetailPage({ params: Promise.resolve({ userId: "user-1" }) }));

    expect(screen.getByRole("form", { name: "恢复账号" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "停用账号" })).toBeNull();
    // RS04：无风控摘要 section / 无 state / 无 reasonCode 呈现
    expect(screen.queryByText("风控状态摘要")).toBeNull();
    expect(screen.queryByText(/MARKETPLACE_RESTRICTED/)).toBeNull();
    expect(screen.queryByText(/MANUAL_REVIEW/)).toBeNull();
    // RS05：enforcement canonical 链接保留
    expect(screen.getByRole("link", { name: "查看执法记录（canonical 读面）→" })).toBeTruthy();
  });
});
