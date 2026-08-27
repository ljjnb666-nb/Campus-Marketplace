import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RootLayout, { metadata } from "@/app/layout";

const { auth, getUnreadConversationCount, getUnreadNotificationCount } = vi.hoisted(() => ({
  auth: vi.fn(),
  getUnreadConversationCount: vi.fn(),
  getUnreadNotificationCount: vi.fn(),
}));

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist-sans" }),
  Geist_Mono: () => ({ variable: "font-geist-mono" }),
}));

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/repositories/conversation-repository", () => ({
  getUnreadConversationCount,
}));

vi.mock("@/repositories/notification-repository", () => ({
  getUnreadNotificationCount,
}));

vi.mock("@/components/providers/session-provider", () => ({
  AppSessionProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="session-provider">{children}</div>
  ),
}));

vi.mock("@/components/site/header", () => ({
  SiteHeader: ({
    unreadNotificationCount,
    unreadConversationCount,
  }: {
    unreadNotificationCount?: number;
    unreadConversationCount?: number;
  }) => (
    <header>
      站点头部 未读通知 {unreadNotificationCount ?? 0} 未读会话 {unreadConversationCount ?? 0}
    </header>
  ),
}));

vi.mock("@/components/site/footer", () => ({
  SiteFooter: () => <footer>站点页脚</footer>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

describe("RootLayout", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("exports the expected metadata", () => {
    expect(metadata.title).toBe("校园集市 - 校内二手、跑腿、技能与租赁平台");
    expect(metadata.description).toBe("面向大学校园的同校二手交易、跑腿接单、技能服务与闲置租赁平台。");
    expect(String(metadata.metadataBase)).toBe(
      new URL(process.env.NEXTAUTH_URL ?? "http://localhost:3000").href,
    );
  });

  it("renders header, footer, and children inside the session provider shell", async () => {
    auth.mockResolvedValue(null);
    getUnreadNotificationCount.mockResolvedValue(0);
    getUnreadConversationCount.mockResolvedValue(0);

    render(
      await RootLayout({
        children: <div>页面内容</div>,
      }),
    );

    expect(screen.getByTestId("session-provider")).toBeInTheDocument();
    expect(screen.getByText("站点头部 未读通知 0 未读会话 0")).toBeTruthy();
    expect(screen.getByText("页面内容")).toBeTruthy();
    expect(screen.getByText("站点页脚")).toBeTruthy();
  });

  it("skips per-user repository queries when there is no session", async () => {
    auth.mockResolvedValue(null);
    getUnreadNotificationCount.mockReset();
    getUnreadConversationCount.mockReset();

    render(
      await RootLayout({
        children: <div>页面内容</div>,
      }),
    );

    expect(getUnreadNotificationCount).not.toHaveBeenCalled();
    expect(getUnreadConversationCount).not.toHaveBeenCalled();
    expect(screen.getByText("站点头部 未读通知 0 未读会话 0")).toBeTruthy();
  });

  it("passes repository counts to the header for a signed-in user", async () => {
    auth.mockResolvedValue({
      user: { id: "user-1", name: "张三", role: "STUDENT" },
    });
    getUnreadNotificationCount.mockResolvedValue(6);
    getUnreadConversationCount.mockResolvedValue(4);

    render(
      await RootLayout({
        children: <div>页面内容</div>,
      }),
    );

    expect(getUnreadNotificationCount).toHaveBeenCalledWith("user-1");
    expect(getUnreadConversationCount).toHaveBeenCalledWith("user-1");
    expect(screen.getByText("站点头部 未读通知 6 未读会话 4")).toBeTruthy();
  });
});
