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

  it("accepts controlled asset references for verification (RB-01)", () => {
    const result = verificationFormSchema.safeParse({
      schoolName: "示例大学",
      campusName: "主校区",
      studentIdLast4: "1234",
      studentCardImage: "asset:ckv0123456789abcdef",
    });

    expect(result.success).toBe(true);
  });

  it("rejects legacy /uploads, external and malformed evidence values (RB-01 fail-closed)", () => {
    for (const studentCardImage of [
      "/uploads/verification/student-card.jpg",
      "https://example.com/card.jpg",
      "http://example.com/card.jpg",
      "javascript:alert(1)",
      "legacy",
      "asset:",
      "asset:***",
      "",
    ]) {
      const result = verificationFormSchema.safeParse({
        schoolName: "示例大学",
        campusName: "主校区",
        studentIdLast4: "1234",
        studentCardImage,
      });

      expect(result.success).toBe(false);
    }
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
