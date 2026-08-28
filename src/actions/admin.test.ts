import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireAdmin,
  reportUpdate,
  productCategoryCreate,
  productCategoryUpdate,
  errandCategoryCreate,
  errandCategoryUpdate,
  serviceCategoryCreate,
  serviceCategoryUpdate,
  moderationKeywordCreate,
  moderationKeywordUpdate,
  userVerificationUpdate,
  userFindUnique,
  userUpdate,
  productUpdate,
  errandTaskUpdate,
  serviceListingUpdate,
  adminLogCreate,
  createNotification,
  applyVerificationAssetRetention,
  transactionMock,
} = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireAdmin: vi.fn(),
  reportUpdate: vi.fn(),
  productCategoryCreate: vi.fn(),
  productCategoryUpdate: vi.fn(),
  errandCategoryCreate: vi.fn(),
  errandCategoryUpdate: vi.fn(),
  serviceCategoryCreate: vi.fn(),
  serviceCategoryUpdate: vi.fn(),
  moderationKeywordCreate: vi.fn(),
  moderationKeywordUpdate: vi.fn(),
  userVerificationUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  productUpdate: vi.fn(),
  errandTaskUpdate: vi.fn(),
  serviceListingUpdate: vi.fn(),
  adminLogCreate: vi.fn(),
  createNotification: vi.fn(),
  applyVerificationAssetRetention: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/server-auth", () => ({
  requireAdmin,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotification,
}));

vi.mock("@/lib/upload", () => ({
  applyVerificationAssetRetention,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    report: {
      update: reportUpdate,
    },
    productCategory: {
      create: productCategoryCreate,
      update: productCategoryUpdate,
    },
    errandCategory: {
      create: errandCategoryCreate,
      update: errandCategoryUpdate,
    },
    serviceCategory: {
      create: serviceCategoryCreate,
      update: serviceCategoryUpdate,
    },
    moderationKeyword: {
      create: moderationKeywordCreate,
      update: moderationKeywordUpdate,
    },
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
    },
    userVerification: {
      update: userVerificationUpdate,
    },
    product: {
      update: productUpdate,
    },
    errandTask: {
      update: errandTaskUpdate,
    },
    serviceListing: {
      update: serviceListingUpdate,
    },
    adminLog: {
      create: adminLogCreate,
    },
    $transaction: transactionMock,
  },
  withTransaction: transactionMock,
}));

import {
  moderateListing,
  reviewReport,
  reviewVerification,
  toggleErrandCategoryStatus,
  toggleModerationKeywordStatus,
  toggleProductCategoryStatus,
  toggleServiceCategoryStatus,
  toggleUserStatus,
  upsertErrandCategory,
  upsertModerationKeyword,
  upsertProductCategory,
  upsertServiceCategory,
} from "@/actions/admin";

describe("admin actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireAdmin.mockReset();
    reportUpdate.mockReset();
    productCategoryCreate.mockReset();
    productCategoryUpdate.mockReset();
    errandCategoryCreate.mockReset();
    errandCategoryUpdate.mockReset();
    serviceCategoryCreate.mockReset();
    serviceCategoryUpdate.mockReset();
    moderationKeywordCreate.mockReset();
    moderationKeywordUpdate.mockReset();
    userVerificationUpdate.mockReset();
    userFindUnique.mockReset();
    userUpdate.mockReset();
    productUpdate.mockReset();
    errandTaskUpdate.mockReset();
    serviceListingUpdate.mockReset();
    adminLogCreate.mockReset();
    createNotification.mockReset();
    applyVerificationAssetRetention.mockReset().mockResolvedValue(0);
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (callback) =>
      callback({
        report: {
          update: reportUpdate,
        },
        adminLog: {
          create: adminLogCreate,
        },
        userVerification: {
          update: userVerificationUpdate,
        },
        user: {
          update: userUpdate,
        },
        product: {
          update: productUpdate,
        },
        errandTask: {
          update: errandTaskUpdate,
        },
        serviceListing: {
          update: serviceListingUpdate,
        },
      }),
    );

    requireAdmin.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
  });

  it("sends an in-review notification when a report is marked as processing", async () => {
    reportUpdate.mockResolvedValue({ reporterId: "user-2" });

    const formData = new FormData();
    formData.set("reportId", "report-1");
    formData.set("status", "IN_REVIEW");
    formData.set("handledNote", "已转交值班管理员复核");

    await reviewReport(formData);

    expect(createNotification).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        userId: "user-2",
        type: "REPORT",
        title: "举报处理中",
        content: "你提交的举报正在处理中。处理说明：已转交值班管理员复核",
      }),
    );
  });

  it("returns an error state and skips the transaction when report input is invalid", async () => {
    const formData = new FormData();
    formData.set("reportId", "report-1");
    formData.set("status", "PENDING");

    const result = await reviewReport(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("creates an errand category and writes an admin log", async () => {
    const formData = new FormData();
    formData.set("name", "代取快递");
    formData.set("slug", "pickup");
    formData.set("description", "快递代取类任务");
    formData.set("sortOrder", "2");
    formData.set("isActive", "true");

    await upsertErrandCategory(formData);

    expect(errandCategoryCreate).toHaveBeenCalledWith({
      data: {
        name: "代取快递",
        slug: "pickup",
        description: "快递代取类任务",
        sortOrder: 2,
        isActive: true,
      },
    });
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: {
        adminId: "admin-1",
        action: "CREATE_ERRAND_CATEGORY",
        targetType: "ERRAND_CATEGORY",
        targetId: "pickup",
        detail: "代取快递",
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/categories");
    expect(revalidatePath).toHaveBeenCalledWith("/errands");
  });

  it("updates an existing errand category and records the update action", async () => {
    const formData = new FormData();
    formData.set("categoryId", "errand-category-1");
    formData.set("name", "代取快递");
    formData.set("slug", "pickup");
    formData.set("description", "");
    formData.set("sortOrder", "2");
    formData.set("isActive", "true");

    await upsertErrandCategory(formData);

    expect(errandCategoryUpdate).toHaveBeenCalledWith({
      where: { id: "errand-category-1" },
      data: {
        name: "代取快递",
        slug: "pickup",
        description: null,
        sortOrder: 2,
        isActive: true,
      },
    });
    expect(errandCategoryCreate).not.toHaveBeenCalled();
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: {
        adminId: "admin-1",
        action: "UPDATE_ERRAND_CATEGORY",
        targetType: "ERRAND_CATEGORY",
        targetId: "errand-category-1",
        detail: "代取快递",
      },
    });
  });

  it("creates a product category through the shared upsert helper", async () => {
    const formData = new FormData();
    formData.set("name", "教材资料");
    formData.set("slug", "books");
    formData.set("description", "教材与笔记");
    formData.set("sortOrder", "1");
    formData.set("isActive", "true");

    await upsertProductCategory(formData);

    expect(productCategoryCreate).toHaveBeenCalledWith({
      data: {
        name: "教材资料",
        slug: "books",
        description: "教材与笔记",
        sortOrder: 1,
        isActive: true,
      },
    });
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: {
        adminId: "admin-1",
        action: "CREATE_PRODUCT_CATEGORY",
        targetType: "PRODUCT_CATEGORY",
        targetId: "books",
        detail: "教材资料",
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/categories");
    expect(revalidatePath).toHaveBeenCalledWith("/products");
  });

  it("returns an error state when category input is invalid", async () => {
    const formData = new FormData();
    formData.set("name", "");
    formData.set("slug", "pickup");
    formData.set("sortOrder", "2");
    formData.set("isActive", "true");

    const result = await upsertErrandCategory(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(errandCategoryCreate).not.toHaveBeenCalled();
    expect(errandCategoryUpdate).not.toHaveBeenCalled();
    expect(adminLogCreate).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("toggles errand category status and records the correct action", async () => {
    const formData = new FormData();
    formData.set("categoryId", "errand-category-2");
    formData.set("isActive", "false");

    await toggleErrandCategoryStatus(formData);

    expect(errandCategoryUpdate).toHaveBeenCalledWith({
      where: { id: "errand-category-2" },
      data: { isActive: false },
    });
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: {
        adminId: "admin-1",
        action: "DISABLE_ERRAND_CATEGORY",
        targetType: "ERRAND_CATEGORY",
        targetId: "errand-category-2",
      },
    });
  });

  it("creates a service category and revalidates the service plaza", async () => {
    const formData = new FormData();
    formData.set("name", "编程辅导");
    formData.set("slug", "coding");
    formData.set("description", "代码答疑与项目辅导");
    formData.set("sortOrder", "3");
    formData.set("isActive", "true");

    await upsertServiceCategory(formData);

    expect(serviceCategoryCreate).toHaveBeenCalledWith({
      data: {
        name: "编程辅导",
        slug: "coding",
        description: "代码答疑与项目辅导",
        sortOrder: 3,
        isActive: true,
      },
    });
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: {
        adminId: "admin-1",
        action: "CREATE_SERVICE_CATEGORY",
        targetType: "SERVICE_CATEGORY",
        targetId: "coding",
        detail: "编程辅导",
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/services");
  });

  it("toggles service category status and records the correct action", async () => {
    const formData = new FormData();
    formData.set("categoryId", "service-category-2");
    formData.set("isActive", "false");

    await toggleServiceCategoryStatus(formData);

    expect(serviceCategoryUpdate).toHaveBeenCalledWith({
      where: { id: "service-category-2" },
      data: { isActive: false },
    });
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: {
        adminId: "admin-1",
        action: "DISABLE_SERVICE_CATEGORY",
        targetType: "SERVICE_CATEGORY",
        targetId: "service-category-2",
      },
    });
  });

  it("returns an error state when toggle input is invalid", async () => {
    const formData = new FormData();
    formData.set("categoryId", "service-category-2");
    formData.set("isActive", "yes");

    const result = await toggleServiceCategoryStatus(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(serviceCategoryUpdate).not.toHaveBeenCalled();
    expect(adminLogCreate).not.toHaveBeenCalled();
  });

  it("creates a moderation keyword with the admin as creator", async () => {
    const formData = new FormData();
    formData.set("keyword", "代考");
    formData.set("targetType", "GLOBAL");
    formData.set("isEnabled", "true");

    await upsertModerationKeyword(formData);

    expect(moderationKeywordCreate).toHaveBeenCalledWith({
      data: {
        keyword: "代考",
        targetType: "GLOBAL",
        isEnabled: true,
        createdById: "admin-1",
      },
    });
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: {
        adminId: "admin-1",
        action: "CREATE_MODERATION_KEYWORD",
        targetType: "MODERATION_KEYWORD",
        targetId: "代考",
        detail: "GLOBAL",
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/keywords");
  });

  it("returns an error state when the keyword is missing", async () => {
    const formData = new FormData();
    formData.set("keyword", "");
    formData.set("targetType", "GLOBAL");
    formData.set("isEnabled", "true");

    const result = await upsertModerationKeyword(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(moderationKeywordCreate).not.toHaveBeenCalled();
    expect(adminLogCreate).not.toHaveBeenCalled();
  });

  it("toggles a moderation keyword and records the enable action", async () => {
    const formData = new FormData();
    formData.set("keywordId", "keyword-1");
    formData.set("isEnabled", "true");

    await toggleModerationKeywordStatus(formData);

    expect(moderationKeywordUpdate).toHaveBeenCalledWith({
      where: { id: "keyword-1" },
      data: { isEnabled: true },
    });
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: {
        adminId: "admin-1",
        action: "ENABLE_MODERATION_KEYWORD",
        targetType: "MODERATION_KEYWORD",
        targetId: "keyword-1",
      },
    });
  });

  it("approves a verification and notifies the user", async () => {
    userVerificationUpdate.mockResolvedValue({});
    userUpdate.mockResolvedValue({});

    const formData = new FormData();
    formData.set("verificationId", "verification-1");
    formData.set("userId", "user-2");
    formData.set("status", "VERIFIED");
    formData.set("reviewNote", "材料齐全");

    await reviewVerification(formData);

    expect(userVerificationUpdate).toHaveBeenCalledWith({
      where: { id: "verification-1" },
      data: expect.objectContaining({ status: "VERIFIED", reviewNote: "材料齐全" }),
    });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-2" },
      data: { verificationStatus: "VERIFIED" },
    });
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "APPROVE_VERIFICATION",
        targetType: "USER_VERIFICATION",
      }),
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-2", title: "校园认证已通过" }),
    );
    // 审核出结果后为学生证材料设置保留期（到期由 cleanup 删除原图，认证结论保留）
    expect(applyVerificationAssetRetention).toHaveBeenCalledWith(
      expect.anything(),
      "verification-1",
      expect.any(Date),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/admin/verifications");
  });

  it("rejects a verification with the review note as the reason", async () => {
    const formData = new FormData();
    formData.set("verificationId", "verification-1");
    formData.set("userId", "user-2");
    formData.set("status", "REJECTED");
    formData.set("reviewNote", "学生证照片模糊");

    await reviewVerification(formData);

    expect(createNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "校园认证未通过",
        content: expect.stringContaining("学生证照片模糊"),
      }),
    );
  });

  it("returns an error state for invalid verification input", async () => {
    const formData = new FormData();
    formData.set("verificationId", "verification-1");
    formData.set("userId", "user-2");
    formData.set("status", "PENDING");

    const result = await reviewVerification(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("suspends a student account and notifies them", async () => {
    userFindUnique.mockResolvedValue({ role: "STUDENT" });

    const formData = new FormData();
    formData.set("userId", "user-2");
    formData.set("nextStatus", "SUSPENDED");

    await toggleUserStatus(formData);

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-2" },
      data: { status: "SUSPENDED" },
    });
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "SUSPEND_USER", targetId: "user-2" }),
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-2", title: "账号已被停用" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/admin/users");
  });

  it("refuses to suspend the admin's own account or other admins", async () => {
    const formData = new FormData();
    formData.set("userId", "admin-1");
    formData.set("nextStatus", "SUSPENDED");

    let result = await toggleUserStatus(formData);
    expect(result).toEqual({ success: false, error: "不能停用或恢复自己的账号" });

    userFindUnique.mockResolvedValue({ role: "ADMIN" });
    formData.set("userId", "admin-2");
    result = await toggleUserStatus(formData);
    expect(result).toEqual({ success: false, error: "不能停用或恢复其他管理员账号" });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("refuses to toggle a missing user", async () => {
    userFindUnique.mockResolvedValue(null);

    const formData = new FormData();
    formData.set("userId", "ghost");
    formData.set("nextStatus", "ACTIVE");

    const result = await toggleUserStatus(formData);

    expect(result).toEqual({ success: false, error: "用户不存在" });
  });

  it("takes products offline through moderation", async () => {
    const formData = new FormData();
    formData.set("targetType", "PRODUCT");
    formData.set("targetId", "product-1");

    await moderateListing(formData);

    expect(productUpdate).toHaveBeenCalledWith({
      where: { id: "product-1" },
      data: { status: "OFFLINE" },
    });
    expect(errandTaskUpdate).not.toHaveBeenCalled();
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "MODERATE_LISTING", targetId: "product-1" }),
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/products");
  });

  it("cancels errand tasks and offlines services through moderation", async () => {
    let formData = new FormData();
    formData.set("targetType", "ERRAND");
    formData.set("targetId", "errand-1");
    await moderateListing(formData);
    expect(errandTaskUpdate).toHaveBeenCalledWith({
      where: { id: "errand-1" },
      data: { status: "CANCELLED" },
    });

    formData = new FormData();
    formData.set("targetType", "SERVICE");
    formData.set("targetId", "service-1");
    await moderateListing(formData);
    expect(serviceListingUpdate).toHaveBeenCalledWith({
      where: { id: "service-1" },
      data: { status: "OFFLINE" },
    });
  });

  it("returns an error state for invalid moderation input", async () => {
    const formData = new FormData();
    formData.set("targetType", "MESSAGE");
    formData.set("targetId", "message-1");

    const result = await moderateListing(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("notifies the reporter with resolved and rejected report copy", async () => {
    reportUpdate.mockResolvedValue({ reporterId: "user-2" });

    const formData = new FormData();
    formData.set("reportId", "report-1");
    formData.set("status", "RESOLVED");
    formData.set("handledNote", "已下架违规商品");

    await reviewReport(formData);

    expect(createNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "举报已处理",
        content: "你提交的举报已处理完成。处理说明：已下架违规商品",
      }),
    );

    formData.set("status", "REJECTED");
    formData.set("handledNote", "");
    await reviewReport(formData);

    expect(createNotification).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "举报处理结果已更新",
        content: "你提交的举报未通过。如有需要可补充更完整的信息后再次提交。",
      }),
    );
  });

  it("returns an error state when review transactions fail", async () => {
    transactionMock.mockRejectedValue(new Error("db down"));

    const formData = new FormData();
    formData.set("verificationId", "verification-1");
    formData.set("userId", "user-2");
    formData.set("status", "VERIFIED");
    formData.set("reviewNote", "");

    const verificationResult = await reviewVerification(formData);
    expect(verificationResult?.success).toBe(false);

    formData.delete("verificationId");
    formData.set("reportId", "report-1");
    formData.set("status", "IN_REVIEW");
    const reportResult = await reviewReport(formData);
    expect(reportResult?.success).toBe(false);

    formData.delete("reportId");
    formData.delete("status");
    formData.set("targetType", "PRODUCT");
    formData.set("targetId", "product-1");
    const moderateResult = await moderateListing(formData);
    expect(moderateResult?.success).toBe(false);
  });

  it("returns an error state when toggle user status input is invalid", async () => {
    const formData = new FormData();
    formData.set("userId", "user-2");
    formData.set("nextStatus", "BANNED");

    const result = await toggleUserStatus(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("restores a suspended account with a friendly notification", async () => {
    userFindUnique.mockResolvedValue({ role: "STUDENT" });

    const formData = new FormData();
    formData.set("userId", "user-2");
    formData.set("nextStatus", "ACTIVE");

    await toggleUserStatus(formData);

    expect(adminLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "RESTORE_USER", targetId: "user-2" }),
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-2", title: "账号已恢复正常" }),
    );
  });

  it("creates product and service categories with typed admin logs", async () => {
    const formData = new FormData();
    formData.set("name", "数码设备");
    formData.set("slug", "digital");
    formData.set("description", "数码类商品");
    formData.set("sortOrder", "1");
    formData.set("isActive", "true");

    await upsertProductCategory(formData);

    expect(productCategoryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "数码设备", slug: "digital" }),
    });
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CREATE_PRODUCT_CATEGORY",
        targetType: "PRODUCT_CATEGORY",
      }),
    });

    formData.set("name", "编程辅导");
    formData.set("slug", "coding");
    await upsertServiceCategory(formData);

    expect(serviceCategoryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ slug: "coding" }),
    });
  });

  it("toggles product category status and records the disable action", async () => {
    const formData = new FormData();
    formData.set("categoryId", "category-1");
    formData.set("isActive", "false");

    await toggleProductCategoryStatus(formData);

    expect(productCategoryUpdate).toHaveBeenCalledWith({
      where: { id: "category-1" },
      data: { isActive: false },
    });
    expect(adminLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: expect.stringContaining("PRODUCT_CATEGORY"),
      }),
    });
  });

  it("updates an existing moderation keyword", async () => {
    const formData = new FormData();
    formData.set("keywordId", "keyword-1");
    formData.set("keyword", "更新后的关键词");
    formData.set("targetType", "GLOBAL");
    formData.set("isEnabled", "true");

    await upsertModerationKeyword(formData);

    expect(moderationKeywordUpdate).toHaveBeenCalledWith({
      where: { id: "keyword-1" },
      data: expect.objectContaining({ keyword: "更新后的关键词" }),
    });
    expect(moderationKeywordCreate).not.toHaveBeenCalled();
  });
});
