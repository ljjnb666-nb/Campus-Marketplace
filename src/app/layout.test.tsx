import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RootLayout, { metadata } from "@/app/layout";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist-sans" }),
  Geist_Mono: () => ({ variable: "font-geist-mono" }),
}));

vi.mock("@/components/providers/session-provider", () => ({
  AppSessionProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="session-provider">{children}</div>
  ),
}));

vi.mock("@/components/site/header", () => ({
  SiteHeader: () => <header>站点头部</header>,
}));

vi.mock("@/components/site/footer", () => ({
  SiteFooter: () => <footer>站点页脚</footer>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

describe("RootLayout", () => {
  it("exports the expected metadata", () => {
    expect(metadata.title).toBe("校园集市 - 校内二手、跑腿、技能与租赁平台");
    expect(metadata.description).toBe("面向大学校园的同校二手交易、跑腿接单、技能服务与闲置租赁平台。");
  });

  it("renders header, footer, and children inside the session provider shell", () => {
    render(
      RootLayout({
        children: <div>页面内容</div>,
      }),
    );

    expect(screen.getByTestId("session-provider")).toBeInTheDocument();
    expect(screen.getByText("站点头部")).toBeTruthy();
    expect(screen.getByText("页面内容")).toBeTruthy();
    expect(screen.getByText("站点页脚")).toBeTruthy();
  });
});
