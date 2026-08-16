import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, getHomepageSummary } = vi.hoisted(() => ({
  auth: vi.fn(),
  getHomepageSummary: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/repositories/home-repository", () => ({
  getHomepageSummary,
}));

vi.mock("@/components/site/hero", () => ({
  HeroSection: ({
    summary,
  }: {
    summary: {
      productCount: number;
      userSummary: { unreadNotifications: number } | null;
    };
  }) => (
    <div>
      <p>商品数量 {summary.productCount}</p>
      <p>未读通知 {summary.userSummary?.unreadNotifications ?? "未登录"}</p>
    </div>
  ),
}));

import { HomeHeroSummary } from "@/app/home-sections/hero-summary";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomeHeroSummary", () => {
  it("renders the hero with session-aware summary data", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } });
    getHomepageSummary.mockResolvedValue({
      productCount: 21,
      errandCount: 9,
      serviceCount: 6,
      campuses: [],
      selectedCampusId: "campus-1",
      userSummary: {
        unreadNotifications: 4,
        unreadConversations: 3,
        activeOrders: 5,
      },
    });

    render(await HomeHeroSummary({ campusId: "campus-1" }));

    expect(auth).toHaveBeenCalledTimes(1);
    expect(getHomepageSummary).toHaveBeenCalledWith({
      userId: "user-1",
      campusId: "campus-1",
    });
    expect(screen.getByText("商品数量 21")).toBeTruthy();
    expect(screen.getByText("未读通知 4")).toBeTruthy();
  });

  it("keeps the hero working for anonymous visitors", async () => {
    auth.mockResolvedValue(null);
    getHomepageSummary.mockResolvedValue({
      productCount: 0,
      errandCount: 0,
      serviceCount: 0,
      campuses: [],
      selectedCampusId: null,
      userSummary: null,
    });

    render(await HomeHeroSummary({}));

    expect(getHomepageSummary).toHaveBeenCalledWith({
      userId: undefined,
      campusId: undefined,
    });
    expect(screen.getByText("未读通知 未登录")).toBeTruthy();
  });
});
