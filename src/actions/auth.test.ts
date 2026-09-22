import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  hash,
  registerActiveCampusUser,
  mockHeaders,
  isRateLimited,
} = vi.hoisted(() => ({
  hash: vi.fn(),
  registerActiveCampusUser: vi.fn(),
  mockHeaders: vi.fn(),
  isRateLimited: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  hash,
}));

vi.mock("next/headers", () => ({
  headers: mockHeaders,
}));

vi.mock("@/lib/rate-limit", () => ({
  isRateLimited,
}));

vi.mock("@/lib/registration-service", () => ({
  registerActiveCampusUser,
}));

import { Prisma } from "@prisma/client";
import { governanceError } from "@/lib/governance/domain-errors";
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

describe("auth actions（FR01：薄适配层；事务权威在 registration-service）", () => {
  beforeEach(() => {
    hash.mockReset();
    registerActiveCampusUser.mockReset();
    mockHeaders.mockReset();
    isRateLimited.mockReset();
    mockHeaders.mockImplementation(async () => ({
      get: () => null,
    }));
    isRateLimited.mockResolvedValue({ limited: false });
    hash.mockResolvedValue("hashed-password");
    registerActiveCampusUser.mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "student1@campus.local" },
    });
  });

  it("rejects registration without the explicit legal consent checkbox", async () => {
    const result = await registerUser(
      { success: false, message: "" },
      buildRegisterFormData({ agreeLegal: "" }),
    );

    expect(result.success).toBe(false);
    expect(registerActiveCampusUser).not.toHaveBeenCalled();
  });

  it("rejects registration when the selected campus does not exist（ok:false 同形拒绝）", async () => {
    registerActiveCampusUser.mockResolvedValue({ ok: false, reason: "CAMPUS_NOT_AVAILABLE" });

    const result = await registerUser({ success: false, message: "" }, buildRegisterFormData());

    expect(result).toEqual({
      success: false,
      message: "校区不存在",
    });
  });

  it("rejects registration for a deactivated campus（FR01：锁内 locked recheck 的 ok:false 同形拒绝）", async () => {
    // 停用校区与不存在校区统一 CAMPUS_NOT_AVAILABLE reason → 同一面文案
    // （无存在性 oracle）；锁内 isActive: true recheck 由
    // registration-service 单测 + 真 PG C-RACE-06 证明。
    registerActiveCampusUser.mockResolvedValue({ ok: false, reason: "CAMPUS_NOT_AVAILABLE" });

    const result = await registerUser({ success: false, message: "" }, buildRegisterFormData());

    expect(result).toEqual({
      success: false,
      message: "校区不存在",
    });
  });

  it("returns a friendly message when the email is already registered", async () => {
    registerActiveCampusUser.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const result = await registerUser({ success: false, message: "" }, buildRegisterFormData());

    expect(result).toEqual({
      success: false,
      message: "该邮箱已注册",
    });
  });

  it("hashes outside any transaction/lock window and delegates to the registration service", async () => {
    const result = await registerUser({ success: false, message: "" }, buildRegisterFormData());

    // FR01 hash discipline：bcrypt 在 CAMPUS 锁窗口之外完成后再进 service
    expect(hash).toHaveBeenCalledWith(TEST_PASSWORD, 10);
    expect(registerActiveCampusUser).toHaveBeenCalledWith({
      name: "张同学",
      email: "student1@campus.local",
      passwordHash: "hashed-password",
      schoolName: "示例大学",
      campusId: "campus-1",
      acceptedDocumentIds: CURRENT_POLICY_IDS,
    });
    expect(result).toEqual({
      success: true,
      message: "注册成功，请登录",
    });
  });

  it("surfaces policy version conflicts as registration failures (fail closed)", async () => {
    registerActiveCampusUser.mockRejectedValue(
      governanceError("LEGAL_DOCUMENT_VERSION_CHANGED"),
    );

    const result = await registerUser({ success: false, message: "" }, buildRegisterFormData());

    expect(result).toEqual({
      success: false,
      message: "协议版本已更新，请重新查看并确认",
    });
  });

  it("rate limits repeated registrations from the same ip", async () => {
    mockHeaders.mockImplementation(async () => ({
      get: (name: string) => (name === "x-forwarded-for" ? "203.0.113.9" : null),
    }));
    isRateLimited
      .mockResolvedValue({ limited: false })
      .mockResolvedValueOnce({ limited: false })
      .mockResolvedValueOnce({ limited: false })
      .mockResolvedValueOnce({ limited: false })
      .mockResolvedValueOnce({ limited: false })
      .mockResolvedValueOnce({ limited: false })
      .mockResolvedValueOnce({ limited: true });

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
    expect(registerActiveCampusUser).toHaveBeenCalledTimes(5);
  });
});
