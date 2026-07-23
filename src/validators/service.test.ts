import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/upload", () => ({
  isStoredImagePath: (value: string) => value.startsWith("/uploads/"),
}));

import { serviceFormSchema } from "@/validators/service";

describe("service validators", () => {
  it("accepts a valid service payload", () => {
    const result = serviceFormSchema.safeParse({
      title: "校园摄影约拍",
      description: "提供毕业照、社团活动拍摄和基础修图，支持校园内约时间面谈。",
      categoryId: "service-category-1",
      price: "88",
      pricingUnit: "PER_SESSION",
      locationText: "图书馆南门",
      availableSchedule: "工作日晚间和周末全天可约",
      coverImageUrl:
        "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=1200&q=80",
    });

    expect(result.success).toBe(true);
  });

  it("accepts stored upload cover image paths", () => {
    const result = serviceFormSchema.safeParse({
      title: "校园摄影约拍",
      description: "提供毕业照、社团活动拍摄和基础修图，支持校园内约时间面谈。",
      categoryId: "service-category-1",
      price: "88",
      pricingUnit: "PER_SESSION",
      locationText: "图书馆南门",
      availableSchedule: "工作日晚间和周末全天可约",
      coverImageUrl: "/uploads/services/cover.jpg",
    });

    expect(result.success).toBe(true);
  });

  it("rejects missing category selection", () => {
    const result = serviceFormSchema.safeParse({
      title: "校园摄影约拍",
      description: "提供毕业照、社团活动拍摄和基础修图，支持校园内约时间面谈。",
      categoryId: "",
      price: "88",
      pricingUnit: "PER_SESSION",
      locationText: "图书馆南门",
      availableSchedule: "工作日晚间和周末全天可约",
      coverImageUrl:
        "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=1200&q=80",
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid image url input", () => {
    const result = serviceFormSchema.safeParse({
      title: "校园摄影约拍",
      description: "提供毕业照、社团活动拍摄和基础修图，支持校园内约时间面谈。",
      categoryId: "service-category-1",
      price: "88",
      pricingUnit: "PER_SESSION",
      locationText: "图书馆南门",
      availableSchedule: "工作日晚间和周末全天可约",
      coverImageUrl: "not-a-url",
    });

    expect(result.success).toBe(false);
  });
});
