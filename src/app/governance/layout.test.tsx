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
