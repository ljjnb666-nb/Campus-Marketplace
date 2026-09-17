import { describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({
  // Next.js redirect() 通过抛出 NEXT_REDIRECT 中止渲染——mock 保持同形
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/navigation", () => ({
  redirect,
}));

import AdminReportsPage from "@/app/admin/reports/page";

/**
 * Phase 7E：legacy /admin/reports 退役合同——页面退化为 canonical
 * /governance/reports redirect，不再渲染任何队列/表单（零第二 mutation
 * authority、零 legacy 读面）。
 */
describe("AdminReportsPage（legacy redirect）", () => {
  it("redirects to the canonical /governance/reports surface", () => {
    expect(() => AdminReportsPage()).toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/governance/reports");
  });
});
