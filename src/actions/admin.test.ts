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
  adminLogCreate,
  createNotification,
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
  adminLogCreate: vi.fn(),
  createNotification: vi.fn(),
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
    adminLog: {
      create: adminLogCreate,
    },
    $transaction: transactionMock,
  },
}));

import {
  reviewReport,
  toggleErrandCategoryStatus,
  toggleModerationKeywordStatus,
  toggleServiceCategoryStatus,
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
    adminLogCreate.mockReset();
    createNotification.mockReset();
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (callback) =>
      callback({
        report: {
          update: reportUpdate,
        },
        adminLog: {
          create: adminLogCreate,
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
});
