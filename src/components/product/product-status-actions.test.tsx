import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductStatusActions } from "@/components/product/product-status-actions";

vi.mock("@/actions/product", () => ({
  updateProductStatus: vi.fn(),
}));

// Phase 8A-02（P8-B01）：RESERVED/SOLD 是 system-owned Order lifecycle
// projection——卖家 UI 不得再提供"标记预订"/"标记售出"；SOLD 为
// seller-terminal，不渲染任何 lifecycle mutation 操作。
describe("ProductStatusActions", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders only seller-owned lifecycle actions（ACTIVE/OFFLINE）", () => {
    const { container } = render(
      <ProductStatusActions productId="product-1" currentStatus="ACTIVE" />,
    );

    expect(screen.queryByRole("button", { name: "重新上架" })).toBeNull();
    expect(screen.queryByRole("button", { name: "标记预订" })).toBeNull();
    expect(screen.queryByRole("button", { name: "标记售出" })).toBeNull();
    expect(screen.getByRole("button", { name: "下架" })).toBeTruthy();
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(container.querySelectorAll('input[name="productId"][value="product-1"]')).toHaveLength(1);
    expect(container.querySelector('input[name="status"][value="OFFLINE"]')).toBeTruthy();
  });

  it("RESERVED（system projection）只提供 wind-down，无 RESERVED/SOLD 主动操作", () => {
    const { container } = render(
      <ProductStatusActions productId="product-1" currentStatus="RESERVED" />,
    );

    expect(screen.getByRole("button", { name: "重新上架" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下架" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "标记预订" })).toBeNull();
    expect(screen.queryByRole("button", { name: "标记售出" })).toBeNull();
    // 服务端仍以 active order 为权威拒绝（不依赖按钮隐藏保证 correctness）
    expect(container.querySelector('input[name="status"][value="ACTIVE"]')).toBeTruthy();
    expect(container.querySelectorAll("form")).toHaveLength(2);
  });

  it("SOLD（seller-terminal）不渲染任何 lifecycle mutation 操作", () => {
    const { container } = render(
      <ProductStatusActions productId="product-1" currentStatus="SOLD" />,
    );

    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "重新上架" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下架" })).toBeNull();
  });

  it("OFFLINE 只提供重新上架（wind-down 幂等不重复渲染）", () => {
    const { container } = render(
      <ProductStatusActions productId="product-1" currentStatus="OFFLINE" />,
    );

    expect(screen.getByRole("button", { name: "重新上架" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "下架" })).toBeNull();
    expect(screen.queryByRole("button", { name: "标记预订" })).toBeNull();
    expect(screen.queryByRole("button", { name: "标记售出" })).toBeNull();
    expect(container.querySelectorAll("form")).toHaveLength(1);
  });
});
