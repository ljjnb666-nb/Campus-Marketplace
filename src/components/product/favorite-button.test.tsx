import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FavoriteButton } from "@/components/product/favorite-button";

vi.mock("@/actions/product", () => ({
  toggleFavorite: vi.fn(),
}));

describe("FavoriteButton", () => {
  it("renders the unfavorited state with hidden product id", () => {
    render(<FavoriteButton productId="product-1" isFavorited={false} count={12} />);

    expect(screen.getByDisplayValue("product-1")).toHaveAttribute("type", "hidden");
    expect(screen.getByRole("button", { name: /收藏 12/i })).toBeTruthy();
    expect(screen.getByText("收藏")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("renders the favorited state copy and filled style hook", () => {
    const { container } = render(<FavoriteButton productId="product-1" isFavorited count={13} />);

    expect(screen.getByText("已收藏")).toBeTruthy();
    expect(screen.getByText("13")).toBeTruthy();
    expect(container.querySelector("svg.fill-current")).toBeInTheDocument();
  });
});
