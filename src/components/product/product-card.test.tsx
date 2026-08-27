import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProductCard } from "@/components/product/product-card";

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

describe("ProductCard", () => {
  it("renders product meta, reason, favorite count, and detail link", () => {
    render(
      <ProductCard
        id="product-1"
        title="二手耳机"
        description="九成新，支持校内面交"
        price="¥88"
        status="ACTIVE"
        category="数码设备"
        seller="张同学"
        imageUrl="/uploads/products/headset.jpg"
        favoriteCount={6}
        reason="热度推荐"
      />,
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/products/product-1");
    expect(screen.getByAltText("二手耳机")).toHaveAttribute("src", "/uploads/products/headset.jpg");
    expect(screen.getByText("数码设备")).toBeTruthy();
    expect(screen.getByText("在售")).toBeTruthy();
    expect(screen.getByText("热度推荐")).toBeTruthy();
    expect(screen.getByText(/6/)).toBeTruthy();
  });

  it("falls back to the default placeholder image", () => {
    render(
      <ProductCard
        id="product-2"
        title="教材"
        description="线代教材"
        price="¥15"
        status="OFFLINE"
        category="教材资料"
        seller="李同学"
      />,
    );

    expect(screen.getByText("无商品图片")).toBeTruthy();
  });
});
