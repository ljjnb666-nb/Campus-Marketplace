import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireUser,
  saveUploadedImage,
  createNotification,
  userUpdate,
  transactionMock,
  txUserUpdate,
  txUserVerificationUpsert,
} = vi.hoisted(() => {
  const txUserUpdate = vi.fn();
  const txUserVerificationUpsert = vi.fn();
  const transactionClient = {
    user: {
      update: txUserUpdate,
    },
    userVerification: {
      upsert: txUserVerificationUpsert,
    },
  };

  return {
    revalidatePath: vi.fn(),
    requireUser: vi.fn(),
    saveUploadedImage: vi.fn(),
    createNotification: vi.fn(),
    userUpdate: vi.fn(),
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txUserUpdate,
    txUserVerificationUpsert,
  };
});

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/lib/upload", () => ({
  saveUploadedImage,
  isStoredImagePath: (value: string) => value.startsWith("/uploads/"),
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotification,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      update: userUpdate,
    },
    $transaction: transactionMock,
  },
}));

import { submitVerification, updateProfile } from "@/actions/user";

describe("user actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireUser.mockReset();
    saveUploadedImage.mockReset();
    createNotification.mockReset();
    userUpdate.mockReset();
    transactionMock.mockClear();
    txUserUpdate.mockReset();
    txUserVerificationUpsert.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    saveUploadedImage.mockResolvedValue("/uploads/verification/student-card.jpg");
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

  it("submits verification materials and creates a pending verification record", async () => {
    const formData = new FormData();
    formData.set("schoolName", "示例大学");
    formData.set("campusName", "主校区");
    formData.set("studentIdLast4", "1234");
    formData.set("studentCardImage", "https://example.com/student-card.jpg");

    const result = await submitVerification({ success: false, message: "" }, formData);

    expect(txUserUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        schoolName: "示例大学",
        studentIdLast4: "1234",
        verificationStatus: "PENDING",
      },
    });
    expect(txUserVerificationUpsert).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      update: expect.objectContaining({
        schoolName: "示例大学",
        campusName: "主校区",
        studentIdLast4: "1234",
        studentCardImage: "https://example.com/student-card.jpg",
        status: "PENDING",
        reviewNote: null,
        reviewedAt: null,
      }),
      create: {
        userId: "user-1",
        schoolName: "示例大学",
        campusName: "主校区",
        studentIdLast4: "1234",
        studentCardImage: "https://example.com/student-card.jpg",
        status: "PENDING",
      },
    });
    expect(createNotification).toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      message: "认证材料已提交，等待审核",
      redirectTo: "/verification",
    });
  });

  it("supports uploading a local student card image", async () => {
    const formData = new FormData();
    formData.set("schoolName", "示例大学");
    formData.set("campusName", "主校区");
    formData.set("studentIdLast4", "1234");
    formData.set(
      "studentCardImageFile",
      new File(["binary"], "student-card.png", { type: "image/png" }),
    );

    await submitVerification({ success: false, message: "" }, formData);

    expect(saveUploadedImage).toHaveBeenCalled();
    expect(txUserVerificationUpsert).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      update: expect.objectContaining({
        studentCardImage: "/uploads/verification/student-card.jpg",
      }),
      create: expect.objectContaining({
        studentCardImage: "/uploads/verification/student-card.jpg",
      }),
    });
  });
});
