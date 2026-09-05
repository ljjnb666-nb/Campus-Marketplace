import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireUser,
  uploadImageAsset,
  resolveSingleImageToken,
  resolveImageTokens,
  markAssetsForValuesPendingDelete,
  createNotification,
  userUpdate,
  userFindUnique,
  verificationFindUnique,
  transactionMock,
  txUserUpdate,
  txUserVerificationUpsert,
  txUserVerificationUpdate,
  submitMembershipVerification,
} = vi.hoisted(() => {
  const txUserUpdate = vi.fn();
  const txUserVerificationUpsert = vi.fn();
  const txUserVerificationUpdate = vi.fn();
  const transactionClient = {
    user: {
      update: txUserUpdate,
    },
    userVerification: {
      upsert: txUserVerificationUpsert,
      update: txUserVerificationUpdate,
    },
  };

  return {
    revalidatePath: vi.fn(),
    requireUser: vi.fn(),
    uploadImageAsset: vi.fn(),
    resolveSingleImageToken: vi.fn(),
    resolveImageTokens: vi.fn(),
    markAssetsForValuesPendingDelete: vi.fn(),
    createNotification: vi.fn(),
    userUpdate: vi.fn(),
    userFindUnique: vi.fn(),
    verificationFindUnique: vi.fn(),
    submitMembershipVerification: vi.fn(),
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txUserUpdate,
    txUserVerificationUpsert,
    txUserVerificationUpdate,
  };
});

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/lib/campus/verification-service", () => ({
  submitMembershipVerification,
}));

vi.mock("@/lib/upload", () => ({
  buildAssetReference: (assetId: string) => `asset:${assetId}`,
  uploadImageAsset,
  resolveSingleImageToken,
  resolveImageTokens,
  markAssetsForValuesPendingDelete,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotification,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      update: userUpdate,
      findUnique: userFindUnique,
    },
    userVerification: {
      findUnique: verificationFindUnique,
    },
    $transaction: transactionMock,
  },
  withTransaction: transactionMock,
}));

import { submitVerification, updateProfile } from "@/actions/user";

describe("user actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireUser.mockReset();
    uploadImageAsset.mockReset();
    resolveSingleImageToken.mockReset();
    resolveImageTokens.mockReset();
    markAssetsForValuesPendingDelete.mockReset().mockResolvedValue(0);
    createNotification.mockReset();
    userUpdate.mockReset();
    userFindUnique.mockReset().mockResolvedValue({ avatarUrl: null });
    verificationFindUnique.mockReset().mockResolvedValue(null);
    submitMembershipVerification.mockReset().mockResolvedValue({ id: "verification-1" });
    transactionMock.mockReset();
    txUserUpdate.mockReset();
    txUserVerificationUpsert.mockReset().mockResolvedValue({ id: "verification-1" });
    txUserVerificationUpdate.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    uploadImageAsset.mockResolvedValue({
      assetId: "asset-9",
      access: "PRIVATE",
      url: null,
      mimeType: "image/webp",
      sizeBytes: 100,
    });
    // 单 token 解析：空值 → null；asset 引用按公开/私有返回规范化值；其余透传
    resolveSingleImageToken.mockImplementation(async ({ token }: { token: string }) => {
      const trimmed = token.trim();
      if (!trimmed) return null;
      if (trimmed === "asset:asset-1") {
        return "http://localhost:9100/campus-public/public/avatars/user-1/me.webp";
      }
      return trimmed;
    });
    resolveImageTokens.mockImplementation(async ({ tokens }: { tokens: string[] }) =>
      tokens.map((token) => token.trim()).filter(Boolean),
    );
  });

  it("updates profile fields and normalizes empty optional fields to null", async () => {
    const formData = new FormData();
    formData.set("name", "张同学");
    formData.set("bio", "");
    formData.set("college", "信息工程学院");
    formData.set("grade", "");
    formData.set("phone", "");
    formData.set("avatarUrl", "");

    const result = await updateProfile({ success: false, message: "" }, formData);

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        name: "张同学",
        bio: null,
        college: "信息工程学院",
        grade: null,
        phone: null,
        avatarUrl: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        bio: true,
        college: true,
        grade: true,
        phone: true,
      },
    });
    expect(result).toEqual({
      success: true,
      message: "个人资料已更新",
      redirectTo: "/profile",
    });
  });

  it("submits verification materials through the central lifecycle service（Phase 6A）", async () => {
    const formData = new FormData();
    formData.set("schoolName", "示例大学");
    formData.set("campusName", "主校区");
    formData.set("studentIdLast4", "1234");
    formData.set("studentCardImage", "https://example.com/student-card.jpg");

    const result = await submitVerification({ success: false, message: "" }, formData);

    expect(submitMembershipVerification).toHaveBeenCalledWith({
      userId: "user-1",
      schoolName: "示例大学",
      campusName: "主校区",
      studentIdLast4: "1234",
      studentCardImageToken: "https://example.com/student-card.jpg",
    });
    expect(result).toEqual({
      success: true,
      message: "认证材料已提交，等待审核",
      redirectTo: "/verification",
    });
  });

  it("supports uploading a local student card image as a private asset reference", async () => {
    const formData = new FormData();
    formData.set("schoolName", "示例大学");
    formData.set("campusName", "主校区");
    formData.set("studentIdLast4", "1234");
    formData.set(
      "studentCardImageFile",
      new File(["binary"], "student-card.png", { type: "image/png" }),
    );

    await submitVerification({ success: false, message: "" }, formData);

    expect(uploadImageAsset).toHaveBeenCalledWith({
      userId: "user-1",
      category: "verification",
      file: expect.any(File),
    });
    // 学生证材料以 asset: 引用进入认证流程，禁止保存任何永久公开 URL
    expect(submitMembershipVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        studentCardImageToken: "asset:asset-9",
      }),
    );
  });

  it("marks replaced verification materials for deletion when resubmitting", async () => {
    verificationFindUnique.mockResolvedValue({
      studentCardImage: "asset:asset-old",
    });

    const formData = new FormData();
    formData.set("schoolName", "示例大学");
    formData.set("campusName", "主校区");
    formData.set("studentIdLast4", "1234");
    formData.set("studentCardImage", "asset:asset-new");

    await submitVerification({ success: false, message: "" }, formData);

    expect(markAssetsForValuesPendingDelete).toHaveBeenCalledWith("user-1", ["asset:asset-old"]);
  });

  it("rejects verification submissions with invalid form data", async () => {
    const formData = new FormData();
    formData.set("schoolName", "示例大学");
    formData.set("campusName", "主校区");
    formData.set("studentIdLast4", "12");
    formData.set("studentCardImage", "/uploads/verification/card.jpg");

    const result = await submitVerification({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(submitMembershipVerification).not.toHaveBeenCalled();
  });

  it("returns a friendly message when verification submission fails", async () => {
    const formData = new FormData();
    formData.set("schoolName", "示例大学");
    formData.set("campusName", "主校区");
    formData.set("studentIdLast4", "1234");
    formData.set("studentCardImage", "/uploads/verification/card.jpg");
    submitMembershipVerification.mockRejectedValue(new Error("db down"));

    const result = await submitVerification({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it("rejects profile updates with invalid form data", async () => {
    const formData = new FormData();
    formData.set("name", "");
    formData.set("bio", "");
    formData.set("college", "");
    formData.set("grade", "");
    formData.set("phone", "");
    formData.set("avatarUrl", "");

    const result = await updateProfile({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("returns a friendly message when the profile update fails", async () => {
    const formData = new FormData();
    formData.set("name", "李同学");
    formData.set("bio", "大三");
    formData.set("college", "信息学院");
    formData.set("grade", "2023");
    formData.set("phone", "");
    formData.set("avatarUrl", "");
    userUpdate.mockRejectedValue(new Error("db down"));

    const result = await updateProfile({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it("updates the avatar through an uploaded file", async () => {
    uploadImageAsset.mockResolvedValue({
      assetId: "asset-1",
      access: "PUBLIC",
      url: "http://localhost:9100/campus-public/public/avatars/user-1/me.webp",
      mimeType: "image/webp",
      sizeBytes: 120,
    });
    userFindUnique.mockResolvedValue({
      avatarUrl: "http://localhost:9100/campus-public/public/avatars/user-1/old.webp",
    });

    const formData = new FormData();
    formData.set("name", "李同学");
    formData.set("bio", "");
    formData.set("college", "");
    formData.set("grade", "");
    formData.set("phone", "");
    formData.set(
      "avatarFile",
      new File(["binary"], "me.png", { type: "image/png" }),
    );

    const result = await updateProfile({ success: false, message: "" }, formData);

    expect(result.success).toBe(true);
    expect(uploadImageAsset).toHaveBeenCalledWith({
      userId: "user-1",
      category: "avatar",
      file: expect.any(File),
    });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({
        name: "李同学",
        avatarUrl: "http://localhost:9100/campus-public/public/avatars/user-1/me.webp",
        bio: null,
      }),
      select: expect.anything(),
    });
    // 旧头像被替换时标记待删除
    expect(markAssetsForValuesPendingDelete).toHaveBeenCalledWith("user-1", [
      "http://localhost:9100/campus-public/public/avatars/user-1/old.webp",
    ]);
  });
});
