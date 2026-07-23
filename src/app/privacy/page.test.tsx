import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PrivacyPage from "@/app/privacy/page";

describe("PrivacyPage", () => {
  it("renders the privacy commitments", () => {
    render(<PrivacyPage />);

    expect(screen.getByRole("heading", { name: "隐私政策" })).toBeTruthy();
    expect(screen.getByText(/公开资料仅包含昵称、头像、学校、校区、认证状态/)).toBeTruthy();
    expect(screen.getByText(/学生证图片仅管理员可见/)).toBeTruthy();
  });
});
