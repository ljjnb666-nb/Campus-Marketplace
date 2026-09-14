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
  cursorCreatedAt: new Date("2026-09-13T10:00:00.000Z"),
  cursorId: "product-1",
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
      targetType === "PRODUCT"
        ? { items: [QUEUE_ITEM], hasMore: false }
        : { items: [], hasMore: false },
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
    loadActiveModerations.mockResolvedValue({
      items: [
        {
          ...QUEUE_ITEM,
          key: "MODERATION:m-1",
        activeModeration: {
          id: "m-1",
          createdAt: new Date("2026-09-13T11:00:00.000Z"),
          reasonCode: "PROHIBITED_ITEM",
        },
          openReportReasons: [],
          // FR-01：active 元组 = moderation.(createdAt,id)
          cursorCreatedAt: new Date("2026-09-13T11:00:00.000Z"),
          cursorId: "m-1",
        },
      ],
      hasMore: false,
    });

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

  it("FR-01 分页：hasMore → 下一页链接携带 cursor 且保留 q/type/limit；browse tab 透传 q", async () => {
    // 一致 mock：loader 恒取 limit+1=11 行（hasMore=true 时），合并窗口
    // merged.length(11) > limit(10) → hasMore 语义由页面统一重算
    browseListings.mockResolvedValue({
      items: [
        {
          ...QUEUE_ITEM,
          key: "PRODUCT:product-2",
          listingId: "product-2",
          cursorCreatedAt: new Date("2026-09-13T09:00:00.000Z"),
          cursorId: "product-2",
        },
        ...Array.from({ length: 10 }, (_, i) => ({
          ...QUEUE_ITEM,
          key: `PRODUCT:filler-${i}`,
          listingId: `filler-${i}`,
          title: `填充 ${i}`,
          cursorCreatedAt: new Date(2026, 8, 13, 8, 0, 0, i),
          cursorId: `filler-${i}`,
        })),
      ],
      hasMore: true,
    });

    const element = await GovernanceListingsPage({
      searchParams: Promise.resolve({ tab: "browse", type: "PRODUCT", q: "治理", limit: "10" }),
    });
    render(element);

    expect(browseListings).toHaveBeenCalledWith(
      expect.objectContaining({ q: "治理", targetType: "PRODUCT", limit: 10 }),
    );
    const nextPage = screen.getByText("下一页").closest("a");
    expect(nextPage?.getAttribute("href")).toContain("cursor=");
    expect(nextPage?.getAttribute("href")).toContain("tab=browse");
    expect(nextPage?.getAttribute("href")).toContain("type=PRODUCT");
    expect(nextPage?.getAttribute("href")).toContain("q=");
    expect(nextPage?.getAttribute("href")).toContain("limit=10");
  });

  it("FR-01 分页：active tab hasMore → 下一页链接（moderation 元组）", async () => {
    loadActiveModerations.mockResolvedValue({
      items: [
        {
          ...QUEUE_ITEM,
          key: "MODERATION:m-9",
          activeModeration: { id: "m-9", createdAt: new Date(), reasonCode: "OTHER" },
          cursorCreatedAt: new Date("2026-09-13T12:00:00.000Z"),
          cursorId: "m-9",
        },
      ],
      hasMore: true,
    });

    const element = await GovernanceListingsPage({
      searchParams: Promise.resolve({ tab: "active" }),
    });
    render(element);

    const nextPage = screen.getByText("下一页").closest("a");
    expect(nextPage?.getAttribute("href")).toContain("tab=active");
    expect(nextPage?.getAttribute("href")).toContain("cursor=");
  });

  it("FR-01 导航：tab 链接不携带 cursor；过滤表单不含 cursor 字段", async () => {
    loadReportFlaggedListings.mockResolvedValue({ items: [], hasMore: false });

    const element = await GovernanceListingsPage({
      searchParams: Promise.resolve({ tab: "browse", type: "PRODUCT", q: "x", cursor: "valid-cursor" }),
    });
    const { container } = render(element);

    // tab 链接：切 tab 语义性清除 cursor
    for (const link of Array.from(container.querySelectorAll("a"))) {
      const href = link.getAttribute("href") ?? "";
      if (href.includes("tab=") && !href.includes("cursor=")) {
        continue;
      }
    }
    const tabLinks = Array.from(container.querySelectorAll("a")).filter((link) =>
      (link.getAttribute("href") ?? "").includes("tab="),
    );
    expect(tabLinks.length).toBeGreaterThan(0);
    for (const link of tabLinks) {
      expect(link.getAttribute("href")).not.toContain("cursor=");
    }
    // 过滤表单：无 cursor 隐藏字段
    const form = container.querySelector("form[method='get']");
    expect(form?.querySelector("input[name='cursor']")).toBeNull();
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
