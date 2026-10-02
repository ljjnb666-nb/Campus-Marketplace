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

  it("RESERVED（system projection，Phase 8F §42）不渲染任何 lifecycle mutation 操作", () => {
    // Phase 8F：RESERVED + active order 时 ACTIVE/OFFLINE 服务端一律 DENY
    // ——UI 不渲染必然失败的按钮；stale RESERVED 的唯一恢复路径（→ACTIVE）
    // 由 server fresh authority 判定，不依赖 UI 快照
    const { container } = render(
      <ProductStatusActions productId="product-1" currentStatus="RESERVED" />,
    );

    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "重新上架" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下架" })).toBeNull();
    expect(screen.queryByRole("button", { name: "标记预订" })).toBeNull();
    expect(screen.queryByRole("button", { name: "标记售出" })).toBeNull();
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
