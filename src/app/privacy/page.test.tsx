import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PrivacyPage from "@/app/privacy/page";

// Phase 5：/privacy 迁移为版本化 policy source（/legal/privacy），
// 旧路由仅保留重定向，不再维护第二份静态文本。
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import { redirect } from "next/navigation";

describe("PrivacyPage（旧路由重定向）", () => {
  it("redirects to the versioned /legal/privacy page", () => {
    render(<PrivacyPage />);

    expect(redirect).toHaveBeenCalledWith("/legal/privacy");
  });
});
