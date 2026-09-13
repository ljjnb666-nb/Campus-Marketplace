import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireUser,
  loadAuthorizationContext,
  loadReportFlaggedListings,
  loadActiveModerations,
  browseListings,
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  loadReportFlaggedListings: vi.fn(),
  loadActiveModerations: vi.fn(),
  browseListings: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext,
}));

vi.mock("@/lib/moderation/listing-moderation-query", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/moderation/listing-moderation-query")
  >();
  return {
    ...actual,
    loadReportFlaggedListings,
    loadActiveModerations,
    browseListings,
  };
});

vi.mock("@/actions/governance-listings", () => ({
  moderateProductListingAction: vi.fn(),
  moderateServiceListingAction: vi.fn(),
  moderateErrandListingAction: vi.fn(),
  moderateRentalListingAction: vi.fn(),
  restoreListingModerationAction: vi.fn(),
}));

import GovernanceListingsPage from "./page";

const GLOBAL_CONTEXT = {
  userId: "moderator-1",
  accountActive: true,
  activeCampusIds: [],
  grants: [
    {
      roleKey: "PLATFORM_ADMIN",
      scope: "GLOBAL" as const,
      campusId: null,
      permissionKeys: ["listing.moderate"],
    },
  ],
};

const QUEUE_ITEM = {
  key: "PRODUCT:product-1",
  targetType: "PRODUCT" as const,
  listingId: "product-1",
  title: "E2E治理商品",
  businessStatus: "ACTIVE",
  campusName: "主校区",
  ownerDisplayName: "卖家甲",
  createdAt: new Date("2026-09-13T10:00:00.000Z"),
  activeModeration: null,
  openReportReasons: ["BANNED_ITEM"],
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "moderator-1", name: "审核员" });
  loadAuthorizationContext.mockResolvedValue(GLOBAL_CONTEXT);
  loadReportFlaggedListings.mockResolvedValue([]);
  loadActiveModerations.mockResolvedValue([]);
  browseListings.mockResolvedValue([]);
});

describe("GovernanceListingsPage（/governance/listings）", () => {
  it("渲染标题与三 tab；待处置 tab 呈现举报 badge 与 takedown 表单", async () => {
    loadReportFlaggedListings.mockImplementation(async ({ targetType }: { targetType: string }) =>
      targetType === "PRODUCT" ? [QUEUE_ITEM] : [],
    );

    const element = await GovernanceListingsPage({ searchParams: Promise.resolve({}) });
    render(element);

    expect(screen.getByText("内容治理")).toBeTruthy();
    expect(screen.getByText("待处置举报")).toBeTruthy();
    expect(screen.getByText("治理处置中")).toBeTruthy();
    expect(screen.getByText("浏览检视")).toBeTruthy();
    expect(screen.getAllByText("E2E治理商品").length).toBeGreaterThan(0);
    // 举报域只读 badge：仅 reason 枚举，无自由文本
    expect(screen.getByText(/未结举报/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /强制下架/ })).toBeTruthy();
  });

  it("处置中 tab：活跃 moderation 行只读呈现（无第二个 takedown 表单）", async () => {
    loadActiveModerations.mockResolvedValue([
      {
        ...QUEUE_ITEM,
        key: "MODERATION:m-1",
        activeModeration: {
          id: "m-1",
          createdAt: new Date("2026-09-13T11:00:00.000Z"),
          reasonCode: "PROHIBITED_ITEM",
        },
        openReportReasons: [],
      },
    ]);

    const element = await GovernanceListingsPage({
      searchParams: Promise.resolve({ tab: "active" }),
    });
    render(element);

    expect(screen.getAllByText("治理处置中").length).toBeGreaterThan(0);
    expect(screen.getByText(/处置时间/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /强制下架/ })).toBeNull();
  });

  it("零 scope moderator（campus 角色）→ notFound；读模型零调用", async () => {
    loadAuthorizationContext.mockResolvedValue({
      userId: "student-1",
      accountActive: true,
      activeCampusIds: ["campus-1"],
      grants: [],
    });

    await expect(
      GovernanceListingsPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(loadReportFlaggedListings).not.toHaveBeenCalled();
    expect(browseListings).not.toHaveBeenCalled();
  });

  it("畸形 cursor → 安全失败态（读模型零调用）", async () => {
    const element = await GovernanceListingsPage({
      searchParams: Promise.resolve({ cursor: "!!!bad!!!" }),
    });
    render(element);

    expect(loadReportFlaggedListings).not.toHaveBeenCalled();
    expect(screen.getByText(/分页链接无效/)).toBeTruthy();
  });
});
