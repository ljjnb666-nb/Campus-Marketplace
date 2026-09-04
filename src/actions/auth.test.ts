import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  hash,
  campusFindUnique,
  userCreate,
  mockHeaders,
  transactionMock,
  recordSignupAcceptances,
} = vi.hoisted(() => ({
  hash: vi.fn(),
  campusFindUnique: vi.fn(),
  userCreate: vi.fn(),
  mockHeaders: vi.fn(),
  transactionMock: vi.fn(),
  recordSignupAcceptances: vi.fn(),
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
  },
  withTransaction: transactionMock,
}));

vi.mock("@/lib/legal/policy-service", () => ({
  recordSignupAcceptances,
}));

import { Prisma } from "@prisma/client";
import { registerUser } from "@/actions/auth";

// 合成测试凭据（拼接生成，非真实账号）
const TEST_PASSWORD = ["Student", "123456"].join("");

const CURRENT_POLICY_IDS = ["doc-terms-1", "doc-privacy-1", "doc-rules-1", "doc-prohibited-1"];

function buildRegisterFormData(overrides?: { agreeLegal?: string; documentIds?: string[] }) {
  const formData = new FormData();
  formData.set("name", "张同学");
  formData.set("email", "student1@campus.local");
  formData.set("password", TEST_PASSWORD);
  formData.set("confirmPassword", TEST_PASSWORD);
  formData.set("schoolName", "示例大学");
  formData.set("campusId", "campus-1");
  if (overrides?.agreeLegal !== undefined) {
    formData.set("agreeLegal", overrides.agreeLegal);
  } else {
    formData.set("agreeLegal", "on");
  }
  for (const documentId of overrides?.documentIds ?? CURRENT_POLICY_IDS) {
    formData.append("acceptedDocumentIds", documentId);
  }
  return formData;
}

describe("auth actions", () => {
  beforeEach(() => {
    hash.mockReset();
    campusFindUnique.mockReset();
    userCreate.mockReset();
    mockHeaders.mockReset();
    transactionMock.mockReset();
    recordSignupAcceptances.mockReset();
    mockHeaders.mockImplementation(async () => ({
      get: () => null,
    }));
    userCreate.mockResolvedValue({ id: "user-1" });
    recordSignupAcceptances.mockResolvedValue({ created: 4, skipped: 0 });
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ user: { create: userCreate } }),
    );
  });

  it("rejects registration without the explicit legal consent checkbox", async () => {
    campusFindUnique.mockResolvedValue({ id: "campus-1" });

    const result = await registerUser(
      { success: false, message: "" },
      buildRegisterFormData({ agreeLegal: "" }),
    );

    expect(result.success).toBe(false);
    expect(userCreate).not.toHaveBeenCalled();
    expect(recordSignupAcceptances).not.toHaveBeenCalled();
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

  it("creates the user and bound acceptance evidence in the same transaction", async () => {
    campusFindUnique.mockResolvedValue({ id: "campus-1" });
    hash.mockResolvedValue("hashed-password");

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
    // 同意证据与用户创建同事务，绑定实际提交的当前 required 文档集合
    expect(recordSignupAcceptances).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      CURRENT_POLICY_IDS,
    );
    expect(result).toEqual({
      success: true,
      message: "注册成功，请登录",
    });
  });

  it("surfaces policy version conflicts as registration failures (fail closed)", async () => {
    campusFindUnique.mockResolvedValue({ id: "campus-1" });
    hash.mockResolvedValue("hashed-password");
    // 提交期间 required 集合变化：同意记录失败 → 整体失败（事务回滚，不留无同意的账号）
    recordSignupAcceptances.mockRejectedValue(
      Object.assign(new Error("协议版本已更新，请重新查看并确认"), {
        code: "LEGAL_DOCUMENT_VERSION_CHANGED",
      }),
    );

    const result = await registerUser({ success: false, message: "" }, buildRegisterFormData());

    expect(result.success).toBe(false);
  });

  it("rate limits repeated registrations from the same ip", async () => {
    mockHeaders.mockImplementation(async () => ({
      get: (name: string) => (name === "x-forwarded-for" ? "203.0.113.9" : null),
    }));
    campusFindUnique.mockResolvedValue({ id: "campus-1" });
    hash.mockResolvedValue("hashed-password");

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
