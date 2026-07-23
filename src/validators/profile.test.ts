import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/upload", () => ({
  isStoredImagePath: (value: string) => value.startsWith("/uploads/"),
}));

import { profileFormSchema, verificationFormSchema } from "@/validators/profile";

describe("profile validators", () => {
  it("accepts a valid profile payload", () => {
    const result = profileFormSchema.safeParse({
      name: "张同学",
      bio: "喜欢做校园产品，也会接一些摄影和设计类服务。",
      college: "信息工程学院",
      grade: "2024级",
      phone: "18800001111",
      avatarUrl: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=600&q=80",
    });

    expect(result.success).toBe(true);
  });

  it("accepts uploaded image paths for verification", () => {
    const result = verificationFormSchema.safeParse({
      schoolName: "示例大学",
      campusName: "主校区",
      studentIdLast4: "1234",
      studentCardImage: "/uploads/verification/student-card.jpg",
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid verification payload", () => {
    const result = verificationFormSchema.safeParse({
      schoolName: "示例大学",
      campusName: "主校区",
      studentIdLast4: "12",
      studentCardImage: "not-a-url",
    });

    expect(result.success).toBe(false);
  });
});
