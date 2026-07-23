import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/upload", () => ({
  isStoredImagePath: (value: string) => value.startsWith("/uploads/"),
}));

import { productFormSchema } from "@/validators/product";

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
        "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1200&q=80",
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
