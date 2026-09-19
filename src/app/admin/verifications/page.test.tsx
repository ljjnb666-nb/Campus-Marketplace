import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

import AdminVerificationsPage from "@/app/admin/verifications/page";

/**
 * Phase 7F legacy retirement：/admin/verifications 只做无条件 redirect 到
 * canonical 认证审核面 /governance/verifications（无 requireAdmin 桥——
 * 授权由目标页 requireVerificationReviewer 独立执行）。
 */
describe("AdminVerificationsPage", () => {
  it("redirects unconditionally to /governance/verifications (no admin bridge)", async () => {
    redirectMock.mockReset();
    await AdminVerificationsPage();

    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/governance/verifications");
  });
});
