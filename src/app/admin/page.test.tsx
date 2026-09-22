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

import AdminPage from "@/app/admin/page";

/**
 * Phase 7H：legacy /admin root dashboard 退役合同——页面退化为 canonical
 * /governance redirect（§40/§61：canonical dashboard truth 唯一化，禁止
 * 两套 dashboard authority），不再渲染任何统计卡/队列/入口。
 */
describe("AdminPage（legacy root redirect）", () => {
  it("redirects to the canonical /governance landing surface", () => {
    expect(() => AdminPage()).toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/governance");
  });
});
