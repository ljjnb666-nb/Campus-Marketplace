import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  redirect,
  revalidatePath,
  requireUser,
  containsBannedKeyword,
  createNotifications,
  userFindUnique,
  errandCategoryFindUnique,
  errandTaskCreate,
  errandTaskFindFirst,
  errandTaskUpdate,
  transactionMock,
  txErrandTaskUpdate,
  txErrandTaskUpdateMany,
  txOrderCreate,
  txOrderFindFirst,
  txOrderUpdate,
  txUserUpdate,
} = vi.hoisted(() => {
  const txErrandTaskUpdate = vi.fn();
  const txErrandTaskUpdateMany = vi.fn();
  const txOrderCreate = vi.fn();
  const txOrderFindFirst = vi.fn();
  const txOrderUpdate = vi.fn();
  const txUserUpdate = vi.fn();
  const transactionClient = {
    errandTask: {
      update: txErrandTaskUpdate,
      updateMany: txErrandTaskUpdateMany,
    },
    order: {
      create: txOrderCreate,
      findFirst: txOrderFindFirst,
      update: txOrderUpdate,
    },
    user: {
      update: txUserUpdate,
    },
  };

  return {
    redirect: vi.fn((location: string) => {
      throw new Error(`REDIRECT:${location}`);
    }),
    revalidatePath: vi.fn(),
    requireUser: vi.fn(),
    containsBannedKeyword: vi.fn(),
    createNotifications: vi.fn(),
    userFindUnique: vi.fn(),
    errandCategoryFindUnique: vi.fn(),
    errandTaskCreate: vi.fn(),
    errandTaskFindFirst: vi.fn(),
    errandTaskUpdate: vi.fn(),
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txErrandTaskUpdate,
    txErrandTaskUpdateMany,
    txOrderCreate,
    txOrderFindFirst,
    txOrderUpdate,
    txUserUpdate,
  };
});

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

vi.mock("@/repositories/notification-repository", () => ({
  createNotifications,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
    },
    errandCategory: {
      findUnique: errandCategoryFindUnique,
    },
    errandTask: {
      create: errandTaskCreate,
      findFirst: errandTaskFindFirst,
      update: errandTaskUpdate,
    },
    $transaction: transactionMock,
  },
}));

import {
  claimErrand,
  createErrand,
  deleteErrand,
  updateErrand,
  updateErrandStatus,
} from "@/actions/errand";

function futureDeadline(days = 2) {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 16);
}

function buildValidErrandFormData() {
  const formData = new FormData();
  formData.set("title", "帮我取快递");
  formData.set("description", "东区快递站两个中号包裹，今晚前送到宿舍楼下。");
  formData.set("categoryId", "errand-category-1");
  formData.set("reward", "8");
  formData.set("pickupLocation", "东区快递站");
  formData.set("deliveryLocation", "6 号宿舍楼下");
  formData.set("deadline", futureDeadline());
  formData.set("contactNote", "到了发消息");
  formData.set("needsAdvancePay", "false");
  formData.set("advanceAmount", "");
  return formData;
}

function buildErrandStatusFormData(status: string) {
  const formData = new FormData();
  formData.set("errandId", "errand-1");
  formData.set("status", status);
  return formData;
}

describe("errand actions", () => {
  beforeEach(() => {
    redirect.mockClear();
    revalidatePath.mockReset();
    requireUser.mockReset();
    containsBannedKeyword.mockReset();
    createNotifications.mockReset();
    userFindUnique.mockReset();
    errandCategoryFindUnique.mockReset();
    errandTaskCreate.mockReset();
    errandTaskFindFirst.mockReset();
    errandTaskUpdate.mockReset();
    transactionMock.mockClear();
    txErrandTaskUpdate.mockReset();
    txErrandTaskUpdateMany.mockReset();
    txOrderCreate.mockReset();
    txOrderFindFirst.mockReset();
    txOrderUpdate.mockReset();
    txUserUpdate.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    containsBannedKeyword.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ campusId: "campus-1" });
    txErrandTaskUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("rejects errand creation when the selected category is inactive", async () => {
    errandCategoryFindUnique.mockResolvedValue({
      id: "errand-category-1",
      isActive: false,
    });

    const result = await createErrand(
      { success: false, message: "" },
      buildValidErrandFormData(),
    );

    expect(result).toEqual({
      success: false,
      message: "任务分类不存在或已停用",
    });
    expect(errandTaskCreate).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects errand update when the task is no longer open", async () => {
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      status: "CLAIMED",
    });

    const formData = buildValidErrandFormData();
    formData.set("errandId", "errand-1");

    const result = await updateErrand({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "只有待接单任务允许编辑",
    });
    expect(errandTaskUpdate).not.toHaveBeenCalled();
  });

  it("prevents users from claiming their own errand", async () => {
    const reward = { toString: () => "10" };
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "user-1",
      accepterId: null,
      status: "OPEN",
      reward,
    });

    const formData = new FormData();
    formData.set("errandId", "errand-1");

    await claimErrand(formData);

    expect(transactionMock).not.toHaveBeenCalled();
    expect(txErrandTaskUpdateMany).not.toHaveBeenCalled();
    expect(txOrderCreate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("does not create an order when the claim loses the race inside the transaction", async () => {
    const reward = { toString: () => "10" };
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "publisher-1",
      accepterId: null,
      status: "OPEN",
      reward,
    });
    txErrandTaskUpdateMany.mockResolvedValue({ count: 0 });

    const formData = new FormData();
    formData.set("errandId", "errand-1");

    await claimErrand(formData);

    expect(txErrandTaskUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "errand-1",
        status: "OPEN",
        accepterId: null,
      },
      data: {
        accepterId: "user-1",
        status: "CLAIMED",
      },
    });
    expect(txOrderCreate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/errands/errand-1");
  });

  it("does not reopen an errand after it has entered progress", async () => {
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "user-1",
      accepterId: "runner-1",
      status: "IN_PROGRESS",
    });

    await updateErrandStatus(buildErrandStatusFormData("OPEN"));

    expect(transactionMock).not.toHaveBeenCalled();
    expect(txErrandTaskUpdate).not.toHaveBeenCalled();
    expect(txOrderUpdate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("allows the publisher to reopen a newly claimed errand and cancel the latest order", async () => {
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "user-1",
      accepterId: "runner-1",
      status: "CLAIMED",
    });
    txOrderFindFirst.mockResolvedValue({
      id: "order-1",
      buyerId: "user-1",
      sellerId: "runner-1",
    });

    await updateErrandStatus(buildErrandStatusFormData("OPEN"));

    expect(txErrandTaskUpdate).toHaveBeenCalledWith({
      where: { id: "errand-1" },
      data: {
        status: "OPEN",
        accepterId: null,
      },
    });
    expect(txOrderUpdate).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: {
        status: "CANCELLED",
        cancelReason: "发布者撤销接单",
      },
    });
    expect(createNotifications).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/errands/errand-1");
    expect(revalidatePath).toHaveBeenCalledWith("/my/orders");
  });

  it("soft deletes an open errand for its publisher and redirects back to my errands", async () => {
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      status: "OPEN",
    });

    const formData = new FormData();
    formData.set("errandId", "errand-1");

    await expect(deleteErrand(formData)).rejects.toThrow("REDIRECT:/my/errands");

    expect(errandTaskUpdate).toHaveBeenCalledWith({
      where: { id: "errand-1" },
      data: {
        deletedAt: expect.any(Date),
        status: "CANCELLED",
        accepterId: null,
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/errands/errand-1");
    expect(revalidatePath).toHaveBeenCalledWith("/my/errands");
  });

  it("does not delete errands that are already in progress or owned by others", async () => {
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      status: "IN_PROGRESS",
    });

    const formData = new FormData();
    formData.set("errandId", "errand-1");

    await expect(deleteErrand(formData)).rejects.toThrow("REDIRECT:/my/errands");

    expect(errandTaskUpdate).not.toHaveBeenCalled();
  });
});
