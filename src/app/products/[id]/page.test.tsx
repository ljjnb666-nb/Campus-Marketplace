import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  gateMock,
  getActiveViewerId,
  getProductDetail,
  incrementProductView,
  createOrOpenProductConversation,
  createProductOrder,
  deleteProduct,
  createReport,
  toggleFavorite,
  updateProductStatus,
} = vi.hoisted(() => ({
  gateMock: vi.fn(),
  getActiveViewerId: vi.fn(),
  getProductDetail: vi.fn(),
  incrementProductView: vi.fn(),
  createOrOpenProductConversation: vi.fn(),
  createProductOrder: vi.fn(),
  deleteProduct: vi.fn(),
  createReport: vi.fn(),
  toggleFavorite: vi.fn(),
  updateProductStatus: vi.fn(),
}));

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

vi.mock("@/lib/server-auth", () => ({
  getActiveViewerId,
}));

vi.mock("@/lib/moderation/listing-moderation-query", () => ({
  resolvePublicDetailModerationGate: gateMock,
  hasActiveModerationForPublicSurface: vi.fn(async () => false),
  rereadListingForConversation: vi.fn(),
  getActiveListingModeration: vi.fn(async () => null),
}));

vi.mock("@/repositories/product-repository", () => ({
  getProductDetail,
  incrementProductView,
}));

vi.mock("@/actions/conversation", () => ({
  createOrOpenProductConversation,
}));

vi.mock("@/actions/order", () => ({
  createProductOrder,
}));

vi.mock("@/actions/product", () => ({
  deleteProduct,
  toggleFavorite,
  updateProductStatus,
}));

vi.mock("@/actions/trust", () => ({
  createReport,
}));

import ProductDetailPage, { generateMetadata } from "@/app/products/[id]/page";

afterEach(() => {
  cleanup();
});

function buildProductDetail() {
  return {
    product: {
      id: "product-1",
      sellerId: "seller-1",
      title: "高数教材",
      price: "35.00",
      originalPrice: "60.00",
      condition: "LIKE_NEW",
      description: "九成新，含课堂笔记。",
      locationText: "图书馆门口",
      createdAt: new Date("2026-07-10T08:00:00.000Z"),
      viewCount: 20,
      favoriteCount: 6,
      status: "ACTIVE",
      category: { name: "教材资料", slug: "textbooks" },
      campus: { schoolName: "示例大学", name: "主校区" },
      images: [
        { id: "image-1", url: "/uploads/products/book-cover.jpg" },
        { id: "image-2", url: "/uploads/products/book-2.jpg" },
      ],
      favorites: [] as Array<{ userId: string }>,
      seller: {
        id: "seller-1",
        name: "李同学",
        schoolName: "示例大学",
        completedOrdersCount: 8,
        positiveReviewRate: 0.95,
        createdAt: new Date("2026-01-01T08:00:00.000Z"),
      },
    },
    relatedProducts: [
      {
        id: "product-2",
        title: "线代教材",
        description: "配套习题册一起出。",
        price: "25.00",
        status: "ACTIVE",
        category: { name: "教材资料" },
        seller: { name: "王同学" },
        images: [],
        favoriteCount: 3,
        reason: "同分类推荐",
      },
    ],
  };
}

describe("ProductDetailPage Phase 7C 治理门分支（FR-03/03B）", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    gateMock.mockResolvedValue("OPEN");
    getActiveViewerId.mockResolvedValue(null);
    getProductDetail.mockResolvedValue(buildProductDetail());
    incrementProductView.mockResolvedValue(undefined);
  });

  it("OPEN：渲染详情并计数（FR03-V02 行为）", async () => {
    render(
      await ProductDetailPage({ params: Promise.resolve({ id: "product-1" }) }),
    );
    expect(gateMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: "PRODUCT", listingId: "product-1" }),
    );
    expect(incrementProductView).toHaveBeenCalledWith("product-1");
    expect(screen.getByText("物品详细描述")).toBeTruthy();
  });

  it("HIDDEN：非 owner 访问 → notFound()，零 Product 写入（FR03-V01 行为）", async () => {
    gateMock.mockResolvedValue("HIDDEN");
    // 页面使用真实 next/navigation notFound()（未 mock）→ 404 fallback 语义
    await expect(
      ProductDetailPage({ params: Promise.resolve({ id: "product-1" }) }),
    ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(incrementProductView).not.toHaveBeenCalled();
  });

  it("OWNER_VIEW：owner 渲染 + 安全横幅 + 零计数（FR-03B owner 隐藏零写入）", async () => {
    gateMock.mockResolvedValue("OWNER_VIEW");
    getActiveViewerId.mockResolvedValue("seller-1");
    render(
      await ProductDetailPage({ params: Promise.resolve({ id: "product-1" }) }),
    );
    expect(screen.getByTestId("moderation-hidden-banner")).toBeTruthy();
    expect(incrementProductView).not.toHaveBeenCalled();
  });

  it("metadata：hidden listing → generic fallback metadata（FR03-M01）", async () => {
    const { generateMetadata } = await import("./page");
    getProductDetail.mockResolvedValue(buildProductDetail());
    gateMock.mockImplementation(async (args: { ownerId: string; listingId: string }) => {
      // metadata 面调用 hasActiveModerationForPublicSurface（独立于页面 gate）
      return "OPEN";
    });
    // metadata 用 hasActiveModerationForPublicSurface —— 单独 mock 其返回 true
    const modQuery = await import("@/lib/moderation/listing-moderation-query");
    vi.mocked(modQuery.hasActiveModerationForPublicSurface).mockResolvedValue(true);

    const meta = await generateMetadata({ params: Promise.resolve({ id: "product-1" }) });
    expect(String(meta.title)).not.toContain("高数教材");
    expect(String(meta.title)).toContain("校园集市");
  });

  it("metadata：可见商品 → 正常 metadata 保留（FR03-M05）", async () => {
    const { generateMetadata } = await import("./page");
    getProductDetail.mockResolvedValue(buildProductDetail());
    const modQuery = await import("@/lib/moderation/listing-moderation-query");
    vi.mocked(modQuery.hasActiveModerationForPublicSurface).mockResolvedValue(false);

    const meta = await generateMetadata({ params: Promise.resolve({ id: "product-1" }) });
    expect(String(meta.title)).toContain("高数教材");
  });
});

describe("ProductDetailPage Comprehensive Test Suite", () => {
  it("renders owner management controls, price breakdown, seller card and related products", async () => {
    getActiveViewerId.mockResolvedValue("seller-1");
    getProductDetail.mockResolvedValue(buildProductDetail());

    render(
      await ProductDetailPage({
        params: Promise.resolve({ id: "product-1" }),
      }),
    );

    // 验证标题与价格
    expect(screen.getAllByText("高数教材")[0]).toBeTruthy();
    expect(screen.getAllByText(/35\.00/)[0]).toBeTruthy();
    expect(screen.getAllByText(/60/)[0]).toBeTruthy();
    expect(screen.getByText("图书馆门口")).toBeTruthy();

    // 验证卖家权限操作按键与导航
    expect(screen.getByRole("link", { name: "编辑商品" }).getAttribute("href")).toBe(
      "/products/product-1/edit",
    );
    expect(screen.getByRole("button", { name: "删除商品" })).toBeTruthy();

    // 验证卖家信用名片
    expect(screen.getByText("李同学")).toBeTruthy();
    expect(screen.getByText("8 单")).toBeTruthy();

    // 验证关联推荐
    expect(screen.getByText("线代教材")).toBeTruthy();
    expect(screen.getByText("同分类推荐")).toBeTruthy();
  });

  it("renders buyer actions, favorite button, and conversation entry for logged-in buyers", async () => {
    const detail = buildProductDetail();
    detail.product.favorites = [{ userId: "buyer-1" }];
    getActiveViewerId.mockResolvedValue("buyer-1");
    getProductDetail.mockResolvedValue(detail);

    render(
      await ProductDetailPage({
        params: Promise.resolve({ id: "product-1" }),
      }),
    );

    // 验证买家专用交易按键
    expect(screen.getAllByRole("button", { name: "立即购买" })[0]).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "私聊卖家" })[0]).toBeTruthy();
    expect(screen.getAllByText("已收藏")[0]).toBeTruthy();
    expect(screen.getAllByText("6")[0]).toBeTruthy();
  });
});

describe("ProductDetailPage generateMetadata", () => {
  it("returns SEO metadata from the product detail", async () => {
    getProductDetail.mockResolvedValue(buildProductDetail());

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: "product-1" }),
    });

    expect(metadata.title).toBe("高数教材 - 校园集市");
    expect(metadata.description).toBe("九成新，含课堂笔记。");
    expect(metadata.openGraph?.title).toBe("高数教材 - 校园集市");
    expect(metadata.openGraph?.description).toBe("九成新，含课堂笔记。");
  });

  it("falls back to generic metadata when the product is missing", async () => {
    getProductDetail.mockRejectedValue(new Error("notFound"));

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: "missing-product" }),
    });

    expect(metadata.title).toBe("商品详情 - 校园集市");
  });
});
