import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema } from "@/validators/auth";

describe("auth validators", () => {
  it("accepts valid login payload", () => {
    const result = loginSchema.safeParse({
      email: "student1@campus.local",
      password: "Student123456",
    });

    expect(result.success).toBe(true);
  });

  it("rejects mismatched register passwords", () => {
    const result = registerSchema.safeParse({
      name: "Test User",
      email: "student1@campus.local",
      password: "Student123456",
      confirmPassword: "Student654321",
      schoolName: "Example University",
      campusId: "campus-id",
    });

    expect(result.success).toBe(false);
  });
});
