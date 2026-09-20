import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, loadAuthorizationContext, hasPermission, loadOperationsOverview } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  hasPermission: vi.fn(),
  loadOperationsOverview: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext, hasPermission }));
vi.mock(
  "@/lib/governance/operations-overview-query",
  () => ({
    loadOperationsOverview,
  }),
);

// derive* 为纯函数：真实实现（与 layout.test 的中央 hasPermission mock 语义一致）
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import GovernanceOverviewPage from "@/app/governance/page";

const activeUser = { id: "r1", email: "r@x", name: "R", role: "STUDENT" };

/** 与中央 hasPermission GLOBAL-only 语义同构的最小 mock（campus derive 用真实实现）。 */
hasPermission.mockImplementation(
  (
    context: {
      accountActive?: boolean;
      grants?: Array<{ scope: string; permissionKeys: string[] }>;
    } | null,
    permission: string,
  ) =>
    Boolean(
      context?.accountActive &&
        context.grants?.some(
          (grant) => grant.scope === "GLOBAL" && grant.permissionKeys.includes(permission),
        ),
    ),
);

function mockContext(grants: Array<{ scope: string; campusId: string | null; permissionKeys: string[] }>, activeCampusIds: string[] = []) {
  requireUser.mockResolvedValue(activeUser);
  loadAuthorizationContext.mockResolvedValue({
    userId: "r1",
    accountActive: true,
    activeCampusIds,
    grants: grants.map((grant, index) => ({ roleKey: `R${index}`, ...grant })),
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // clearAllMocks 会清掉 hasPermission 的实现，恢复
  hasPermission.mockImplementation(
    (
      context: {
        accountActive?: boolean;
        grants?: Array<{ scope: string; permissionKeys: string[] }>;
      } | null,
      permission: string,
    ) =>
      Boolean(
        context?.accountActive &&
          context.grants?.some(
            (grant) => grant.scope === "GLOBAL" && grant.permissionKeys.includes(permission),
          ),
      ),
  );
});

describe("GovernanceOverviewPage（/governance canonical 落地仪表盘）", () => {
  it("O09：仅 GLOBAL campus.manage → root 可入，仅校区管理快捷入口，零队列 summary 查询", async () => {
    mockContext([{ scope: "GLOBAL", campusId: null, permissionKeys: ["campus.manage"] }]);
    loadOperationsOverview.mockResolvedValue([]);

    render(await GovernanceOverviewPage());

    expect(screen.getByRole("heading", { name: "治理总览" })).toBeTruthy();
    expect(screen.getByText("你当前没有运营队列的授权范围。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "校区管理" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "系统状态" })).toBeNull();
    expect(screen.queryByRole("link", { name: "用户管理" })).toBeNull();
    // anti-oracle：五个队列域全部以 null 传入
    expect(loadOperationsOverview).toHaveBeenCalledWith({
      viewerId: "r1",
      reports: null,
      verifications: null,
      appeals: null,
      disputes: null,
      support: null,
    });
  });

  it("O10：仅 GLOBAL operations.overview → 仅系统状态快捷入口，零治理域 counts", async () => {
    mockContext([{ scope: "GLOBAL", campusId: null, permissionKeys: ["operations.overview"] }]);
    loadOperationsOverview.mockResolvedValue([]);

    render(await GovernanceOverviewPage());

    expect(screen.getByRole("link", { name: "系统状态" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "校区管理" })).toBeNull();
    expect(screen.queryByText("运营队列概况")).toBeNull();
  });

  it("O01/O08：GLOBAL user.suspend + report scope → report summary 卡片 + 用户管理入口", async () => {
    mockContext([
      { scope: "GLOBAL", campusId: null, permissionKeys: ["user.suspend"] },
      { scope: "CAMPUS", campusId: "A", permissionKeys: ["report.review"] },
    ], ["A"]);
    loadOperationsOverview.mockResolvedValue([
      {
        domain: "reports",
        title: "举报处理",
        href: "/governance/reports",
        activeCount: 5,
        overdueCount: 2,
        assignedToMeCount: 1,
        oldestDueAt: "2026-09-19T08:00:00.000Z",
      },
    ]);

    render(await GovernanceOverviewPage());

    expect(screen.getByText("运营队列概况")).toBeTruthy();
    expect(screen.getByText("举报处理")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("超时 2")).toBeTruthy();
    expect(screen.getByText("我领用的：1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "用户管理" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看队列" }).getAttribute("href")).toBe(
      "/governance/reports",
    );
    // report access 传入，其它域仍为 null（anti-oracle）
    const input = loadOperationsOverview.mock.calls[0][0] as Record<string, unknown>;
    expect(input.reports).toEqual({ global: false, campusIds: ["A"] });
    expect(input.verifications).toBeNull();
    expect(input.appeals).toBeNull();
    expect(input.disputes).toBeNull();
    expect(input.support).toBeNull();
  });

  it("summary 卡片结构性不含任何 PII 字段（§44：counts/timestamps only）", async () => {
    mockContext([{ scope: "GLOBAL", campusId: null, permissionKeys: ["support.manage"] }]);
    loadOperationsOverview.mockResolvedValue([
      {
        domain: "support",
        title: "支持工单",
        href: "/governance/support",
        activeCount: 1,
        overdueCount: 0,
        assignedToMeCount: 0,
        oldestDueAt: null,
      },
    ]);

    const { container } = render(await GovernanceOverviewPage());

    expect(screen.getByText("支持工单")).toBeTruthy();
    expect(container.textContent).not.toContain("@");
    expect(container.textContent).not.toContain("subject");
    expect(screen.getByText("最早时限：—")).toBeTruthy();
  });
});
