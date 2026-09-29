import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/upload", () => ({
  isStoredImagePath: (value: string) => value.startsWith("/uploads/"),
}));

import { productFormSchema, productStatusSchema } from "@/validators/product";

describe("product validators", () => {
  it("accepts a valid product payload", () => {
    const result = productFormSchema.safeParse({
      title: "九成新高数教材",
      description: "教材保存完好，支持图书馆门口面交。",
      price: "25",
      originalPrice: "58",
      categoryId: "category-id",
      condition: "LIKE_NEW",
      locationText: "图书馆门口",
      imageUrls: [
        "https://example.com/textbook.jpg",
      ],
    });

    expect(result.success).toBe(true);
  });

  it("accepts stored upload paths", () => {
    const result = productFormSchema.safeParse({
      title: "九成新高数教材",
      description: "教材保存完好，支持图书馆门口面交。",
      price: "25",
      originalPrice: "58",
      categoryId: "category-id",
      condition: "LIKE_NEW",
      locationText: "图书馆门口",
      imageUrls: ["/uploads/products/book.jpg"],
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid image url input", () => {
    const result = productFormSchema.safeParse({
      title: "九成新高数教材",
      description: "教材保存完好，支持图书馆门口面交。",
      price: "25",
      originalPrice: "58",
      categoryId: "category-id",
      condition: "LIKE_NEW",
      locationText: "图书馆门口",
      imageUrls: ["not-a-url"],
    });

    expect(result.success).toBe(false);
  });
});

// Phase 8A-02（P8-B01）：seller status API 只接受 ACTIVE/OFFLINE——
// RESERVED/SOLD 是 system-owned Order lifecycle projection，卖家不得制造。
// 以运行时值（非 TS 类型）显式断言接受/拒绝。
describe("productStatusSchema（8A-02 seller status 权威收窄）", () => {
  function parseStatus(status: string) {
    return productStatusSchema.safeParse({ productId: "product-1", status });
  }

  it("accepts seller-owned targets", () => {
    expect(parseStatus("ACTIVE").success).toBe(true);
    expect(parseStatus("OFFLINE").success).toBe(true);
  });

  it("rejects system-owned RESERVED at runtime", () => {
    const result = parseStatus("RESERVED");
    expect(result.success).toBe(false);
  });

  it("rejects system-owned SOLD at runtime", () => {
    const result = parseStatus("SOLD");
    expect(result.success).toBe(false);
  });

  it("still rejects non-lifecycle statuses", () => {
    expect(parseStatus("BANNED").success).toBe(false);
    expect(parseStatus("").success).toBe(false);
  });
});
