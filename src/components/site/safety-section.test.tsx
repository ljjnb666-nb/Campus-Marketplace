import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SafetySection } from "@/components/site/safety-section";

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

describe("SafetySection", () => {
  it("renders homepage safety guidance and action links", () => {
    render(<SafetySection />);

    expect(screen.getByText("安全交易提示")).toBeTruthy();
    expect(screen.getByText("优先选择同校区当面交易")).toBeTruthy();
    expect(screen.getByText("付款前先确认实物和服务细节")).toBeTruthy();
    expect(screen.getByText("遇到异常内容立即举报")).toBeTruthy();
    expect(screen.getByText("优先选择已认证用户")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看平台规则" }).getAttribute("href")).toBe("/rules");
    expect(screen.getByRole("link", { name: "前往举报中心" }).getAttribute("href")).toBe("/reports");
  });
});
