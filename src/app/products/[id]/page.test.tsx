import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  getProductDetail,
  createOrOpenProductConversation,
  createProductOrder,
  deleteProduct,
  createReport,
  toggleFavorite,
  updateProductStatus,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  getProductDetail: vi.fn(),
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

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/repositories/product-repository", () => ({
  getProductDetail,
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

describe("ProductDetailPage Comprehensive Test Suite", () => {
  it("renders owner management controls, price breakdown, seller card and related products", async () => {
    auth.mockResolvedValue({ user: { id: "seller-1" } });
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
    auth.mockResolvedValue({ user: { id: "buyer-1" } });
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
