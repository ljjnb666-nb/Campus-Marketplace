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
      avatarUrl: "https://example.com/avatar.jpg",
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
