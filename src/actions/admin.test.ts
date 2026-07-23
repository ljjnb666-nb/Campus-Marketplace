import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireAdmin,
  reportUpdate,
  errandCategoryCreate,
  errandCategoryUpdate,
  serviceCategoryCreate,
  serviceCategoryUpdate,
  adminLogCreate,
  createNotification,
  transactionMock,
} = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireAdmin: vi.fn(),
  reportUpdate: vi.fn(),
  errandCategoryCreate: vi.fn(),
  errandCategoryUpdate: vi.fn(),
  serviceCategoryCreate: vi.fn(),
  serviceCategoryUpdate: vi.fn(),
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
    errandCategory: {
      create: errandCategoryCreate,
      update: errandCategoryUpdate,
    },
    serviceCategory: {
      create: serviceCategoryCreate,
      update: serviceCategoryUpdate,
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
  toggleServiceCategoryStatus,
  upsertErrandCategory,
  upsertServiceCategory,
} from "@/actions/admin";

describe("admin actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireAdmin.mockReset();
    reportUpdate.mockReset();
    errandCategoryCreate.mockReset();
    errandCategoryUpdate.mockReset();
    serviceCategoryCreate.mockReset();
    serviceCategoryUpdate.mockReset();
    adminLogCreate.mockReset();
    createNotification.mockReset();
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
});
