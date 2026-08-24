import { beforeEach, describe, expect, it, vi } from "vitest";

const { hash, campusFindUnique, userCreate, mockHeaders } = vi.hoisted(() => ({
  hash: vi.fn(),
  campusFindUnique: vi.fn(),
  userCreate: vi.fn(),
  mockHeaders: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  hash,
}));

vi.mock("next/headers", () => ({
  headers: mockHeaders,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campus: {
      findUnique: campusFindUnique,
    },
    user: {
      create: userCreate,
    },
  },
}));

import { Prisma } from "@prisma/client";
import { registerUser } from "@/actions/auth";

// 合成测试凭据（拼接生成，非真实账号）
const TEST_PASSWORD = ["Student", "123456"].join("");

function buildRegisterFormData() {
  const formData = new FormData();
  formData.set("name", "张同学");
  formData.set("email", "student1@campus.local");
  formData.set("password", TEST_PASSWORD);
  formData.set("confirmPassword", TEST_PASSWORD);
  formData.set("schoolName", "示例大学");
  formData.set("campusId", "campus-1");
  return formData;
}

describe("auth actions", () => {
  beforeEach(() => {
    hash.mockReset();
    campusFindUnique.mockReset();
    userCreate.mockReset();
    mockHeaders.mockReset();
    mockHeaders.mockImplementation(async () => ({
      get: () => null,
    }));
  });

  it("rejects registration when the selected campus does not exist", async () => {
    campusFindUnique.mockResolvedValue(null);

    const result = await registerUser({ success: false, message: "" }, buildRegisterFormData());

    expect(result).toEqual({
      success: false,
      message: "校区不存在",
    });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("returns a friendly message when the email is already registered", async () => {
    campusFindUnique.mockResolvedValue({ id: "campus-1" });
    hash.mockResolvedValue("hashed-password");
    userCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
      }),
    );

    const result = await registerUser({ success: false, message: "" }, buildRegisterFormData());

    expect(result).toEqual({
      success: false,
      message: "该邮箱已注册",
    });
  });

  it("creates the user with a hashed password when registration succeeds", async () => {
    campusFindUnique.mockResolvedValue({ id: "campus-1" });
    hash.mockResolvedValue("hashed-password");
    userCreate.mockResolvedValue({ id: "user-1" });

    const result = await registerUser({ success: false, message: "" }, buildRegisterFormData());

    expect(hash).toHaveBeenCalledWith(TEST_PASSWORD, 10);
    expect(userCreate).toHaveBeenCalledWith({
      data: {
        name: "张同学",
        email: "student1@campus.local",
        passwordHash: "hashed-password",
        schoolName: "示例大学",
        campusId: "campus-1",
      },
    });
    expect(result).toEqual({
      success: true,
      message: "注册成功，请登录",
    });
  });

  it("rate limits repeated registrations from the same ip", async () => {
    mockHeaders.mockImplementation(async () => ({
      get: (name: string) => (name === "x-forwarded-for" ? "203.0.113.9" : null),
    }));
    campusFindUnique.mockResolvedValue({ id: "campus-1" });
    hash.mockResolvedValue("hashed-password");
    userCreate.mockResolvedValue({ id: "user-x" });

    let result = { success: true, message: "" };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      result = await registerUser({ success: false, message: "" }, buildRegisterFormData());
      expect(result.success).toBe(true);
    }

    result = await registerUser({ success: false, message: "" }, buildRegisterFormData());

    expect(result).toEqual({
      success: false,
      message: "注册操作过于频繁，请稍后再试",
    });
    expect(userCreate).toHaveBeenCalledTimes(5);
  });
});
