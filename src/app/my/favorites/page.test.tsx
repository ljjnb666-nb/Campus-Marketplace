import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MyFavoritesPage from "@/app/my/favorites/page";

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

vi.mock("@/components/product/product-card", () => ({
  ProductCard: ({
    title,
    price,
    seller,
  }: {
    title: string;
    price: string;
    seller: string;
  }) => (
    <article>
      <h2>{title}</h2>
      <p>{price}</p>
      <p>{seller}</p>
    </article>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MyFavoritesPage Unified Component Suite", () => {
  beforeEach(() => {
    global.fetch = vi.fn((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/api/favorites/products")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ favorites: [] }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ favorites: [] }),
      } as Response);
    });
  });

  it("renders empty state when there are no product favorites", async () => {
    render(<MyFavoritesPage />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "我的收藏" })).toBeTruthy();
      expect(screen.getByText("暂无收藏")).toBeTruthy();
    });
  });

  it("renders favorite products when API returns list", async () => {
    global.fetch = vi.fn((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/api/favorites/products")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              favorites: [
                {
                  id: "favorite-1",
                  product: {
                    id: "product-1",
                    title: "高数教材",
                    description: "九成新教材",
                    price: "35.00",
                    status: "ACTIVE",
                    category: { name: "教材资料" },
                    seller: { name: "张同学" },
                    images: [{ url: "/uploads/products/book.jpg" }],
                    favoriteCount: 8,
                  },
                },
              ],
            }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ favorites: [] }),
      } as Response);
    });

    render(<MyFavoritesPage />);

    await waitFor(() => {
      expect(screen.getByText("高数教材")).toBeTruthy();
      expect(screen.getByText("张同学")).toBeTruthy();
    });
  });
});
