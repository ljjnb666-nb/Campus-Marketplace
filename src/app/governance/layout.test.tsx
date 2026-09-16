import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, loadAuthorizationContext, notFound } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext,
}));

vi.mock("next/navigation", () => ({
  notFound,
}));

import GovernanceLayout from "@/app/governance/layout";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GovernanceLayout（/governance 路由级授权门）", () => {
  it("GLOBAL appeal.review reviewer → 渲染 children", async () => {
    requireUser.mockResolvedValue({ id: "r1", email: "r@x", name: "R", role: "STUDENT" });
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
      accountActive: true,
      activeCampusIds: [],
      grants: [
        { roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["appeal.review"] },
      ],
    });

    render(
      await GovernanceLayout({ children: <div data-testid="content">治理内容</div> }),
    );

    expect(screen.getByTestId("content")).toBeTruthy();
  });

  it("有效 campus scope reviewer → 渲染 children", async () => {
    requireUser.mockResolvedValue({ id: "r1", email: "r@x", name: "R", role: "STUDENT" });
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
      accountActive: true,
      activeCampusIds: ["A"],
      grants: [
        { roleKey: "R", scope: "CAMPUS", campusId: "A", permissionKeys: ["appeal.review"] },
      ],
    });

    render(
      await GovernanceLayout({ children: <div data-testid="content">治理内容</div> }),
    );

    expect(screen.getByTestId("content")).toBeTruthy();
  });

  it("零有效 scope → notFound（campus grant 无 ACTIVE membership 不得入内）", async () => {
    requireUser.mockResolvedValue({ id: "r1", email: "r@x", name: "R", role: "STUDENT" });
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
      accountActive: true,
      activeCampusIds: [],
      grants: [
        { roleKey: "R", scope: "CAMPUS", campusId: "A", permissionKeys: ["appeal.review"] },
      ],
    });

    await expect(
      GovernanceLayout({ children: <div>治理内容</div> }),
    ).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});

// ── Phase 7B：root gate union（appealReview OR roleManage）───────────────────
// R01/R02 单元层：role-manager-only 必须通过 root gate（其对 appeals 面不可见
// 由 appeals 页自守 requireAppealReviewer 保证，浏览器级由 7B-E2E03 断言）；
// appeal-reviewer-only 对 roles 面 404 由 roles 页自守 + E2E 断言。
describe("GovernanceLayout Phase 7B union gate（R01/R02）", () => {
  const activeUser = { id: "r1", email: "r@x", name: "R", role: "STUDENT" };

  it("GLOBAL role-manager-only（rbac.role.assign）→ 渲染 children", async () => {
    requireUser.mockResolvedValue(activeUser);
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
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

    render(
      await GovernanceLayout({ children: <div data-testid="content">治理内容</div> }),
    );

    expect(screen.getByTestId("content")).toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("campus-scoped role-manager-only（grant ∧ ACTIVE membership）→ 渲染 children", async () => {
    requireUser.mockResolvedValue(activeUser);
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
      accountActive: true,
      activeCampusIds: ["A"],
      grants: [
        {
          roleKey: "CAMPUS_ROLE_MANAGER",
          scope: "CAMPUS",
          campusId: "A",
          permissionKeys: ["rbac.role.assign"],
        },
      ],
    });

    render(
      await GovernanceLayout({ children: <div data-testid="content">治理内容</div> }),
    );

    expect(screen.getByTestId("content")).toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("双持（appeal.review ∧ rbac.role.assign 同校区）→ 渲染 children", async () => {
    requireUser.mockResolvedValue(activeUser);
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
      accountActive: true,
      activeCampusIds: ["A"],
      grants: [
        {
          roleKey: "BOTH",
          scope: "CAMPUS",
          campusId: "A",
          permissionKeys: ["appeal.review", "rbac.role.assign"],
        },
      ],
    });

    render(
      await GovernanceLayout({ children: <div data-testid="content">治理内容</div> }),
    );

    expect(screen.getByTestId("content")).toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("仅普通学生（零 grant）→ notFound（union 两分量皆空）", async () => {
    requireUser.mockResolvedValue(activeUser);
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });

    await expect(
      GovernanceLayout({ children: <div>治理内容</div> }),
    ).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});

// ── Phase 7D：root gate 五元 union + capability 派生导航 ─────────────────────
describe("GovernanceLayout Phase 7D union gate + 导航可见性", () => {
  const activeUser = { id: "r1", email: "r@x", name: "R", role: "STUDENT" };

  it("audit.read-only GLOBAL → 通过 root gate，导航仅显示 审计日志", async () => {
    requireUser.mockResolvedValue(activeUser);
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
      accountActive: true,
      activeCampusIds: [],
      grants: [
        { roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["audit.read"] },
      ],
    });

    render(
      await GovernanceLayout({ children: <div data-testid="content">治理内容</div> }),
    );

    expect(screen.getByTestId("content")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "治理控制台" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "审计日志" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "申诉审核" })).toBeNull();
    expect(screen.queryByRole("link", { name: "角色管理" })).toBeNull();
    expect(screen.queryByRole("link", { name: "列表治理" })).toBeNull();
    expect(screen.queryByRole("link", { name: "执法记录" })).toBeNull();
  });

  it("enforcement.read-only GLOBAL → 通过 root gate，导航仅显示 执法记录", async () => {
    requireUser.mockResolvedValue(activeUser);
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
      accountActive: true,
      activeCampusIds: [],
      grants: [
        { roleKey: "R", scope: "GLOBAL", campusId: null, permissionKeys: ["enforcement.read"] },
      ],
    });

    render(
      await GovernanceLayout({ children: <div data-testid="content">治理内容</div> }),
    );

    expect(screen.getByTestId("content")).toBeTruthy();
    expect(screen.getByRole("link", { name: "执法记录" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "审计日志" })).toBeNull();
  });

  it("campus moderator（listing.moderate）→ 可入树，但看不到 Audit/Enforcement 链接", async () => {
    requireUser.mockResolvedValue(activeUser);
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
      accountActive: true,
      activeCampusIds: ["A"],
      grants: [
        { roleKey: "CAMPUS_CONTENT_MODERATOR", scope: "CAMPUS", campusId: "A", permissionKeys: ["listing.moderate"] },
      ],
    });

    render(
      await GovernanceLayout({ children: <div data-testid="content">治理内容</div> }),
    );

    expect(screen.getByRole("link", { name: "列表治理" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "审计日志" })).toBeNull();
    expect(screen.queryByRole("link", { name: "执法记录" })).toBeNull();
  });

  it("legacy 全量 11-key GLOBAL（不含 enforcement.read）→ 五链接齐备", async () => {
    requireUser.mockResolvedValue(activeUser);
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
      accountActive: true,
      activeCampusIds: [],
      grants: [
        {
          roleKey: "PLATFORM_ADMIN",
          scope: "GLOBAL",
          campusId: null,
          permissionKeys: [
            "verification.review",
            "report.review",
            "listing.moderate",
            "category.manage",
            "moderation.keyword.manage",
            "user.suspend",
            "appeal.review",
            "asset.sensitive.read",
            "campus.manage",
            "rbac.role.assign",
            "audit.read",
          ],
        },
      ],
    });

    render(
      await GovernanceLayout({ children: <div data-testid="content">治理内容</div> }),
    );

    for (const label of ["申诉审核", "角色管理", "列表治理", "审计日志"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
    // R1 语义分离：legacy 全量集合不含 enforcement.read → 执法记录链接不可见
    expect(screen.queryByRole("link", { name: "执法记录" })).toBeNull();
  });

  it("audit.read 无 ACTIVE membership 的 campus grant → 不得入树", async () => {
    requireUser.mockResolvedValue(activeUser);
    loadAuthorizationContext.mockResolvedValue({
      userId: "r1",
      accountActive: true,
      activeCampusIds: [],
      grants: [
        { roleKey: "R", scope: "CAMPUS", campusId: "A", permissionKeys: ["audit.read"] },
      ],
    });

    await expect(
      GovernanceLayout({ children: <div>治理内容</div> }),
    ).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});
