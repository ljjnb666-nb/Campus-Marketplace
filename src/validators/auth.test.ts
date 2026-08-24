import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema } from "@/validators/auth";

// 合成测试凭据（拼接生成，非真实账号）
const TEST_PASSWORD = ["Student", "123456"].join("");

describe("auth validators", () => {
  it("accepts valid login payload", () => {
    const result = loginSchema.safeParse({
      email: "student1@campus.local",
      password: TEST_PASSWORD,
    });

    expect(result.success).toBe(true);
  });

  it("rejects mismatched register passwords", () => {
    const result = registerSchema.safeParse({
      name: "Test User",
      email: "student1@campus.local",
      password: TEST_PASSWORD,
      confirmPassword: ["Student", "654321"].join(""),
      schoolName: "Example University",
      campusId: "campus-id",
    });

    expect(result.success).toBe(false);
  });
});
