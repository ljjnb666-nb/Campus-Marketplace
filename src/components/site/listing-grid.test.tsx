import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListingGrid } from "@/components/site/listing-grid";

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

afterEach(() => {
  cleanup();
});

const items = [
  { id: "1", href: "/products/1", title: "商品 1", subtitle: "描述 1", price: "¥10", meta: "今天", imageUrl: "/1.jpg" },
  { id: "2", href: "/products/2", title: "商品 2", subtitle: "描述 2", price: "¥20", meta: "今天" },
  { id: "3", href: "/products/3", title: "商品 3", subtitle: "描述 3", price: "¥30", meta: "今天" },
  { id: "4", href: "/products/4", title: "商品 4", subtitle: "描述 4", price: "¥40", meta: "今天", reason: "编辑推荐" },
];

describe("ListingGrid", () => {
  it("renders the first page of cards and the more link", () => {
    render(
      <ListingGrid
        title="最新商品"
        description="本校区最近上新的二手好物"
        items={items}
        moreHref="/products"
      />,
    );

    expect(screen.getByText("最新商品")).toBeTruthy();
    expect(screen.getByText("本校区最近上新的二手好物")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看更多" })).toHaveAttribute("href", "/products");
    expect(screen.getByText("商品 1")).toBeTruthy();
    expect(screen.getByText("商品 2")).toBeTruthy();
    expect(screen.getByText("商品 3")).toBeTruthy();
    expect(screen.queryByText("商品 4")).toBeNull();
  });

  it("cycles to the next batch when clicking the pager button", () => {
    render(
      <ListingGrid
        title="最新商品"
        description="本校区最近上新的二手好物"
        items={items}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "换一批" }));

    expect(screen.getByText("商品 4")).toBeTruthy();
    expect(screen.getByText("编辑推荐")).toBeTruthy();
    expect(screen.queryByText("商品 1")).toBeNull();
  });
});
