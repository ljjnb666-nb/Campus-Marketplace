import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

import AdminUsersPage from "@/app/admin/users/page";

/**
 * Phase 7F legacy retirement：/admin/users 只做无条件 redirect 到 canonical
 * 用户运营面 /governance/users（无 requireAdmin 桥——授权由目标页
 * requireUserOperationsAdmin 独立执行）。
 */
describe("AdminUsersPage", () => {
  it("redirects unconditionally to /governance/users (no admin bridge)", async () => {
    redirectMock.mockReset();
    await AdminUsersPage();

    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/governance/users");
  });
});
