import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUserOperationsAdmin, loadUserOperationsQueue, listUserQueueCampuses } =
  vi.hoisted(() => ({
    requireUserOperationsAdmin: vi.fn(),
    loadUserOperationsQueue: vi.fn(),
    listUserQueueCampuses: vi.fn(),
  }));

vi.mock("@/lib/governance/user-operations-access", () => ({
  requireUserOperationsAdmin,
}));

vi.mock("@/lib/governance/user-operations-query", () => ({
  loadUserOperationsQueue,
  listUserQueueCampuses,
  USER_QUEUE_DEFAULT_PAGE_SIZE: 25,
  USER_QUEUE_MAX_PAGE_SIZE: 50,
  decodeUserCursor: (raw: string) =>
    raw === "good-cursor"
      ? { createdAt: new Date("2026-09-16T00:00:00.000Z"), id: "user-1" }
      : null,
}));

import GovernanceUsersPage from "@/app/governance/users/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockAdmin() {
  requireUserOperationsAdmin.mockResolvedValue({
    user: { id: "admin-1", email: "a@x", name: "管理员", role: "ADMIN" },
  });
}

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    displayName: "张同学",
    status: "ACTIVE",
    createdAt: new Date("2026-09-16T08:00:00.000Z").toISOString(),
    lastLoginAt: null,
    activeCampusNames: ["主校区"],
    // FR01：canonical effective verification（非 legacy 投影）
    effectiveVerificationStatus: "PENDING",
    ...overrides,
  };
}

describe("GovernanceUsersPage（用户运营队列，GLOBAL user.suspend ONLY）", () => {
  it("空队列渲染空态；campus 选项由仓储查询派生", async () => {
    mockAdmin();
    loadUserOperationsQueue.mockResolvedValue({ items: [], nextCursor: null });
    listUserQueueCampuses.mockResolvedValue([{ id: "campus-1", name: "主校区" }]);

    render(await GovernanceUsersPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "用户管理" })).toBeTruthy();
    expect(screen.getByText("当前没有符合条件的用户。")).toBeTruthy();
    expect(screen.getByRole("form", { name: "队列过滤" })).toBeTruthy();
    expect(loadUserOperationsQueue).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25, filters: {} }),
    );
  });

  it("渲染队列行（状态/认证/校区摘要），不含 email/role/信用分", async () => {
    mockAdmin();
    loadUserOperationsQueue.mockResolvedValue({
      items: [baseItem({ status: "SUSPENDED", verificationStatus: "VERIFIED" })],
      nextCursor: null,
    });
    listUserQueueCampuses.mockResolvedValue([]);

    render(await GovernanceUsersPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("张同学")).toBeTruthy();
    expect(screen.getAllByText("已停用").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已认证").length).toBeGreaterThan(0);
    expect(screen.getByText("主校区")).toBeTruthy();
    expect(screen.getByText(/注册时间/)).toBeTruthy();
    expect(screen.getByText("最近登录：暂无记录")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看详情" }).getAttribute("href")).toBe(
      "/governance/users/user-1",
    );
    // UP04/UP05：role authority 与 creditScore 结构性不在页面
    expect(screen.queryByText("信用分")).toBeNull();
  });

  it("畸形 cursor → 安全失败态（空页 + 提示），不发查询", async () => {
    mockAdmin();
    loadUserOperationsQueue.mockResolvedValue({ items: [], nextCursor: null });
    listUserQueueCampuses.mockResolvedValue([]);

    render(
      await GovernanceUsersPage({ searchParams: Promise.resolve({ cursor: "%bad" }) }),
    );

    expect(screen.getByText(/分页链接无效/)).toBeTruthy();
    expect(loadUserOperationsQueue).not.toHaveBeenCalled();
  });

  it("合法 cursor → 作为分页位置传入查询；nextCursor 渲染下一页链接", async () => {
    mockAdmin();
    loadUserOperationsQueue.mockResolvedValue({
      items: [baseItem()],
      nextCursor: "next-token",
    });
    listUserQueueCampuses.mockResolvedValue([]);

    render(
      await GovernanceUsersPage({ searchParams: Promise.resolve({ cursor: "good-cursor" }) }),
    );

    expect(loadUserOperationsQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { createdAt: new Date("2026-09-16T00:00:00.000Z"), id: "user-1" },
      }),
    );
    const next = screen.getByRole("link", { name: "下一页" });
    expect(next.getAttribute("href")).toContain("cursor=next-token");
  });

  it("filters 透传（status/verification/campus），非法值静默忽略", async () => {
    mockAdmin();
    loadUserOperationsQueue.mockResolvedValue({ items: [], nextCursor: null });
    listUserQueueCampuses.mockResolvedValue([]);

    render(
      await GovernanceUsersPage({
        searchParams: Promise.resolve({
          status: "SUSPENDED",
          verification: "PENDING",
          campus: "campus-1",
          limit: "50",
        }),
      }),
    );

    expect(loadUserOperationsQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50,
        filters: { status: "SUSPENDED", verificationStatus: "PENDING", campusId: "campus-1" },
      }),
    );
  });
});
