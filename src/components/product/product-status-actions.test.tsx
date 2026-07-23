import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProductStatusActions } from "@/components/product/product-status-actions";

vi.mock("@/actions/product", () => ({
  updateProductStatus: vi.fn(),
}));

describe("ProductStatusActions", () => {
  it("renders one form for each allowed next product status", () => {
    const { container } = render(
      <ProductStatusActions productId="product-1" currentStatus="ACTIVE" />,
    );

    expect(screen.queryByRole("button", { name: "重新上架" })).toBeNull();
    expect(screen.getByRole("button", { name: "标记预订" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "标记售出" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下架" })).toBeTruthy();
    expect(container.querySelectorAll("form")).toHaveLength(3);
    expect(container.querySelectorAll('input[name="productId"][value="product-1"]')).toHaveLength(3);
    expect(container.querySelector('input[name="status"][value="RESERVED"]')).toBeTruthy();
    expect(container.querySelector('input[name="status"][value="SOLD"]')).toBeTruthy();
    expect(container.querySelector('input[name="status"][value="OFFLINE"]')).toBeTruthy();
  });
});
