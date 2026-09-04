import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import RulesPage from "@/app/rules/page";

// Phase 5：/rules 迁移为版本化 policy source（/legal/rules），
// 旧路由仅保留重定向，不再维护第二份静态文本。
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import { redirect } from "next/navigation";

describe("RulesPage（旧路由重定向）", () => {
  it("redirects to the versioned /legal/rules page", () => {
    render(<RulesPage />);

    expect(redirect).toHaveBeenCalledWith("/legal/rules");
  });
});
