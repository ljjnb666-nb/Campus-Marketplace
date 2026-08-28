import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  redirect,
  revalidatePath,
  requireUser,
  containsBannedKeyword,
  uploadImageAsset,
  resolveSingleImageToken,
  markAssetsForValuesPendingDelete,
  userFindUnique,
  serviceCategoryFindFirst,
  serviceListingFindFirst,
  serviceListingCreate,
  serviceListingUpdate,
} = vi.hoisted(() => ({
  redirect: vi.fn((location: string) => {
    throw new Error(`REDIRECT:${location}`);
  }),
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  containsBannedKeyword: vi.fn(),
  uploadImageAsset: vi.fn(),
  resolveSingleImageToken: vi.fn(),
  markAssetsForValuesPendingDelete: vi.fn(),
  userFindUnique: vi.fn(),
  serviceCategoryFindFirst: vi.fn(),
  serviceListingFindFirst: vi.fn(),
  serviceListingCreate: vi.fn(),
  serviceListingUpdate: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("next/navigation", () => ({
  redirect,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/lib/moderation", () => ({
  containsBannedKeyword,
}));

vi.mock("@/lib/upload", () => ({
  buildAssetReference: (assetId: string) => `asset:${assetId}`,
  uploadImageAsset,
  resolveSingleImageToken,
  markAssetsForValuesPendingDelete,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
    },
    serviceCategory: {
      findFirst: serviceCategoryFindFirst,
    },
    serviceListing: {
      create: serviceListingCreate,
      findFirst: serviceListingFindFirst,
      update: serviceListingUpdate,
    },
  },
}));

import { createService, deleteService, updateService, updateServiceStatus } from "@/actions/service";

function buildValidServiceFormData() {
  const formData = new FormData();
  formData.set("title", "高数一对一辅导");
  formData.set("description", "可辅导高数和线代，支持晚间在图书馆面谈。");
  formData.set("categoryId", "service-category-1");
  formData.set("price", "50");
  formData.set("pricingUnit", "PER_HOUR");
  formData.set("locationText", "图书馆自习区");
  formData.set("availableSchedule", "工作日晚 7 点后");
  formData.set("coverImageUrl", "https://example.com/cover.jpg");
  return formData;
}

describe("service actions", () => {
  beforeEach(() => {
    redirect.mockClear();
    revalidatePath.mockReset();
    requireUser.mockReset();
    containsBannedKeyword.mockReset();
    uploadImageAsset.mockReset();
    resolveSingleImageToken.mockReset();
    markAssetsForValuesPendingDelete.mockReset().mockResolvedValue(0);
    userFindUnique.mockReset();
    serviceCategoryFindFirst.mockReset();
    serviceListingFindFirst.mockReset();
    serviceListingCreate.mockReset();
    serviceListingUpdate.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    uploadImageAsset.mockResolvedValue({
      assetId: "asset-1",
      access: "PUBLIC",
      url: "http://localhost:9100/campus-public/public/services/user-1/cover.webp",
      mimeType: "image/webp",
      sizeBytes: 1024,
    });
    // 单 token 解析 mock：asset 引用 → 公开 URL；其余透传；空值 → null
    resolveSingleImageToken.mockImplementation(async ({ token }: { token: string }) => {
      const trimmed = token.trim();
      if (!trimmed) return null;
      if (trimmed === "asset:asset-1") {
        return "http://localhost:9100/campus-public/public/services/user-1/cover.webp";
      }
      return trimmed;
    });
    userFindUnique.mockResolvedValue({ campusId: "campus-1" });
    serviceCategoryFindFirst.mockResolvedValue({ id: "service-category-1" });
    serviceListingCreate.mockResolvedValue({ id: "service-1" });
  });

  it("rejects service creation when the content matches a banned keyword", async () => {
    containsBannedKeyword.mockResolvedValue("代考");

    const result = await createService({ success: false, message: "" }, buildValidServiceFormData());

    expect(result).toEqual({
      success: false,
      message: "内容命中违规关键词：代考",
    });
    expect(userFindUnique).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects service creation when category is inactive", async () => {
    containsBannedKeyword.mockResolvedValue(null);
    serviceCategoryFindFirst.mockResolvedValue(null);

    const result = await createService({ success: false, message: "" }, buildValidServiceFormData());

    expect(result).toEqual({
      success: false,
      message: "服务分类不存在或已停用",
    });
    expect(serviceListingCreate).not.toHaveBeenCalled();
  });

  it("prefers uploaded cover images over raw urls", async () => {
    containsBannedKeyword.mockResolvedValue(null);

    const formData = buildValidServiceFormData();
    formData.set("coverImageFile", new File(["binary"], "cover.png", { type: "image/png" }));

    await createService({ success: false, message: "" }, formData);

    expect(uploadImageAsset).toHaveBeenCalledWith({
      userId: "user-1",
      category: "service",
      file: expect.any(File),
    });
    // 创建时先落库再写入规范化后的封面 URL
    expect(serviceListingCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "高数一对一辅导",
      }),
    });
    expect(serviceListingUpdate).toHaveBeenCalledWith({
      where: { id: "service-1" },
      data: {
        coverImageUrl: "http://localhost:9100/campus-public/public/services/user-1/cover.webp",
      },
    });
  });

  it("rejects service update when the user does not own the listing", async () => {
    containsBannedKeyword.mockResolvedValue(null);
    serviceListingFindFirst.mockResolvedValue(null);

    const formData = buildValidServiceFormData();
    formData.set("serviceId", "service-1");

    const result = await updateService({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "无权修改该服务",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("updates service category together with editable fields", async () => {
    containsBannedKeyword.mockResolvedValue(null);
    serviceListingFindFirst.mockResolvedValue({ id: "service-1" });

    const formData = buildValidServiceFormData();
    formData.set("serviceId", "service-1");

    const result = await updateService({ success: false, message: "" }, formData);

    expect(serviceListingUpdate).toHaveBeenCalledWith({
      where: { id: "service-1" },
      data: expect.objectContaining({
        categoryId: "service-category-1",
        title: "高数一对一辅导",
      }),
    });
    expect(result).toEqual({
      success: true,
      message: "服务已更新",
      redirectTo: "/services/service-1",
    });
  });

  it("soft deletes the owner's service and redirects back to my services", async () => {
    serviceListingFindFirst.mockResolvedValue({ id: "service-1" });

    const formData = new FormData();
    formData.set("serviceId", "service-1");

    await expect(deleteService(formData)).rejects.toThrow("REDIRECT:/my/services");

    expect(serviceListingUpdate).toHaveBeenCalledWith({
      where: { id: "service-1" },
      data: {
        status: "OFFLINE",
        deletedAt: expect.any(Date),
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/services/service-1");
    expect(revalidatePath).toHaveBeenCalledWith("/my/services");
  });

  it("does not delete services owned by other users", async () => {
    serviceListingFindFirst.mockResolvedValue(null);

    const formData = new FormData();
    formData.set("serviceId", "service-1");

    await expect(deleteService(formData)).rejects.toThrow("REDIRECT:/my/services");

    expect(serviceListingUpdate).not.toHaveBeenCalled();
  });

  it("redirects when deleting without a service id", async () => {
    const formData = new FormData();

    await expect(deleteService(formData)).rejects.toThrow("REDIRECT:/my/services");

    expect(serviceListingFindFirst).not.toHaveBeenCalled();
  });

  it("creates a service with parsed fields and campus of the provider", async () => {
    containsBannedKeyword.mockResolvedValue(null);

    const result = await createService({ success: false, message: "" }, buildValidServiceFormData());

    expect(result).toEqual({
      success: true,
      message: "服务已发布",
      redirectTo: "/services/service-1",
    });
    expect(serviceListingCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "高数一对一辅导",
        categoryId: "service-category-1",
        pricingUnit: "PER_HOUR",
        campusId: "campus-1",
        providerId: "user-1",
      }),
    });
    expect(revalidatePath).toHaveBeenCalledWith("/services/service-1");
  });

  it("rejects service creation with invalid form data", async () => {
    const formData = buildValidServiceFormData();
    formData.set("price", "not-a-number");

    const result = await createService({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
    expect(containsBannedKeyword).not.toHaveBeenCalled();
  });

  it("rejects service creation when the provider record is missing", async () => {
    containsBannedKeyword.mockResolvedValue(null);
    userFindUnique.mockResolvedValue(null);

    const result = await createService({ success: false, message: "" }, buildValidServiceFormData());

    expect(result).toEqual({ success: false, message: "用户不存在" });
  });

  it("returns a friendly message when creation throws", async () => {
    containsBannedKeyword.mockResolvedValue(null);
    serviceListingCreate.mockRejectedValue(new Error("db down"));

    const result = await createService({ success: false, message: "" }, buildValidServiceFormData());

    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it("rejects service update without a service id", async () => {
    containsBannedKeyword.mockResolvedValue(null);

    const result = await updateService({ success: false, message: "" }, buildValidServiceFormData());

    expect(result).toEqual({ success: false, message: "服务不存在" });
  });

  it("rejects service update when the category is inactive", async () => {
    containsBannedKeyword.mockResolvedValue(null);
    serviceListingFindFirst.mockResolvedValue({ id: "service-1" });
    serviceCategoryFindFirst.mockResolvedValue(null);

    const formData = buildValidServiceFormData();
    formData.set("serviceId", "service-1");

    const result = await updateService({ success: false, message: "" }, formData);

    expect(result).toEqual({ success: false, message: "服务分类不存在或已停用" });
    expect(serviceListingUpdate).not.toHaveBeenCalled();
  });

  it("rejects service update with invalid form data", async () => {
    const formData = buildValidServiceFormData();
    formData.set("title", "短");
    formData.set("serviceId", "service-1");

    const result = await updateService({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
    expect(serviceListingFindFirst).not.toHaveBeenCalled();
  });

  describe("updateServiceStatus", () => {
    it("updates the status of an owned service", async () => {
      serviceListingFindFirst.mockResolvedValue({ id: "service-1" });

      const formData = new FormData();
      formData.set("serviceId", "service-1");
      formData.set("status", "PAUSED");

      await updateServiceStatus(formData);

      expect(serviceListingUpdate).toHaveBeenCalledWith({
        where: { id: "service-1" },
        data: { status: "PAUSED" },
      });
      expect(revalidatePath).toHaveBeenCalledWith("/services/service-1");
    });

    it("ignores invalid status values", async () => {
      const formData = new FormData();
      formData.set("serviceId", "service-1");
      formData.set("status", "NOT_A_STATUS");

      await updateServiceStatus(formData);

      expect(serviceListingFindFirst).not.toHaveBeenCalled();
      expect(serviceListingUpdate).not.toHaveBeenCalled();
    });

    it("ignores services owned by others", async () => {
      serviceListingFindFirst.mockResolvedValue(null);

      const formData = new FormData();
      formData.set("serviceId", "service-1");
      formData.set("status", "PAUSED");

      await updateServiceStatus(formData);

      expect(serviceListingUpdate).not.toHaveBeenCalled();
    });
  });
});
