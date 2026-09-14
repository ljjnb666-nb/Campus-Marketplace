import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireUser,
  loadAuthorizationContext,
  loadListingModerationHistory,
  loadGovernanceListingDetail,
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  loadListingModerationHistory: vi.fn(),
  loadGovernanceListingDetail: vi.fn(),
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

vi.mock("@/lib/moderation/listing-moderation-query", () => ({
  loadListingModerationHistory,
  loadGovernanceListingDetail,
}));

vi.mock("@/actions/governance-listings", () => ({
  moderateProductListingAction: vi.fn(),
  moderateServiceListingAction: vi.fn(),
  moderateErrandListingAction: vi.fn(),
  moderateRentalListingAction: vi.fn(),
  restoreListingModerationAction: vi.fn(),
}));

import GovernanceListingDetailPage from "@/app/governance/listings/[type]/[id]/page";

const UPDATED_AT = "2026-09-13T10:00:00.000Z";

const DETAIL = {
  targetType: "PRODUCT" as const,
  listingId: "product-1",
  title: "E2E治理商品",
  description: "现势描述",
  businessStatus: "ACTIVE",
  campusId: "campus-1",
  campusName: "主校区",
  ownerDisplayName: "卖家甲",
  ownerId: "seller-1",
  createdAt: new Date("2026-09-12T10:00:00.000Z"),
  updatedAt: new Date(UPDATED_AT),
  imageUrls: ["/uploads/products/e2e.jpg", "/uploads/products/e2e-2.jpg"],
  pricing: "¥66",
  locationText: "东门",
};

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

function detailPage() {
  return GovernanceListingDetailPage({
    params: Promise.resolve({ type: "product", id: "product-1" }),
  });
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "moderator-1", name: "审核员" });
  loadAuthorizationContext.mockResolvedValue(GLOBAL_CONTEXT);
  loadGovernanceListingDetail.mockResolvedValue(DETAIL);
  loadListingModerationHistory.mockResolvedValue([]);
});

describe("GovernanceListingDetailPage（/governance/listings/[type]/[id]）", () => {
  it("无活跃处置 → 渲染现势内容 + takedown 表单（restore 不可用）", async () => {
    render(await detailPage());

    expect(screen.getByRole("heading", { name: "E2E治理商品" })).toBeTruthy();
    expect(screen.getByText("现势描述")).toBeTruthy();
    expect(screen.getByRole("button", { name: /强制下架/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "恢复公开展示" })).toBeNull();
  });

  it("活跃处置 → 提供 moderationId/updatedAt token（R2-03 restore 凭据）+ 历史", async () => {
    loadListingModerationHistory.mockResolvedValue([
      {
        id: "m-1",
        reasonCode: "PROHIBITED_ITEM",
        note: "内部备注",
        createdAt: new Date("2026-09-13T09:00:00.000Z"),
        resolvedAt: null,
        moderatorDisplayName: "审核员",
        resolvedByDisplayName: null,
      },
    ]);

    render(await detailPage());

    expect(screen.getByText("治理处置中")).toBeTruthy();
    const restoreForm = screen.getByRole("button", { name: "恢复公开展示" }).closest("form");
    expect(restoreForm?.innerHTML).toContain("m-1");
    expect(restoreForm?.innerHTML).toContain(UPDATED_AT);
    // 治理历史（含 note）仅本面可见
    expect(screen.getByText(/内部备注/)).toBeTruthy();
    expect(screen.getByText(/处置人 审核员/)).toBeTruthy();
  });

  it("owner 访问治理视图（self-moderation deny）→ notFound", async () => {
    requireUser.mockResolvedValue({ id: "seller-1", name: "卖家甲" });

    await expect(detailPage()).rejects.toThrow("NOT_FOUND");
  });

  it("invalid type / missing listing / 跨校区 → 统一 notFound（防 oracle）", async () => {
    await expect(
      GovernanceListingDetailPage({
        params: Promise.resolve({ type: "message", id: "x" }),
      }),
    ).rejects.toThrow("NOT_FOUND");

    loadGovernanceListingDetail.mockResolvedValue(null);
    await expect(detailPage()).rejects.toThrow("NOT_FOUND");

    loadAuthorizationContext.mockResolvedValue({
      userId: "moderator-2",
      accountActive: true,
      activeCampusIds: ["campus-2"],
      grants: [
        {
          roleKey: "CAMPUS_CONTENT_MODERATOR",
          scope: "CAMPUS" as const,
          campusId: "campus-2",
          permissionKeys: ["listing.moderate"],
        },
      ],
    });
    await expect(detailPage()).rejects.toThrow("NOT_FOUND");
  });
});
