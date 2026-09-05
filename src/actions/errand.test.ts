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
  txOrderUpdateMany,
  txUserUpdate,
  txExecuteRaw,
  txUserFindMany,
} = vi.hoisted(() => {
  const txExecuteRaw = vi.fn();
  const txUserFindMany = vi.fn();
  const txErrandTaskUpdate = vi.fn();
  const txErrandTaskUpdateMany = vi.fn();
  const txOrderCreate = vi.fn();
  const txOrderFindFirst = vi.fn();
  const txOrderUpdate = vi.fn();
  const txOrderUpdateMany = vi.fn();
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
      updateMany: txOrderUpdateMany,
    },
    user: {
      update: txUserUpdate,
      findMany: txUserFindMany,
    },
    $executeRaw: txExecuteRaw,
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
    txOrderUpdateMany,
    txUserUpdate,
    txExecuteRaw,
    txUserFindMany,
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
  withTransaction: transactionMock,
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
    txOrderUpdateMany.mockReset();
    txUserUpdate.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    containsBannedKeyword.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ campusId: "campus-1" });
    txErrandTaskUpdateMany.mockResolvedValue({ count: 1 });
    txOrderUpdateMany.mockResolvedValue({ count: 1 });

    // participant governance guard 默认全绿（锁查询 + 全员 ACTIVE）
    txExecuteRaw.mockReset().mockResolvedValue(0);
    txUserFindMany.mockReset().mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id: string) => ({ id, status: "ACTIVE", deletedAt: null, erasedAt: null })),
    );
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

  it("creates an errand with campus scope and notifications", async () => {
    errandCategoryFindUnique.mockResolvedValue({
      id: "errand-category-1",
      isActive: true,
    });
    errandTaskCreate.mockResolvedValue({ id: "errand-new" });

    const result = await createErrand(
      { success: false, message: "" },
      buildValidErrandFormData(),
    );

    expect(result.success).toBe(true);
    expect(errandTaskCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "帮我取快递",
        campusId: "campus-1",
        publisherId: "user-1",
      }),
    });
    expect(revalidatePath).toHaveBeenCalledWith("/errands");
  });

  it("rejects errand creation that hits a banned keyword", async () => {
    containsBannedKeyword.mockResolvedValue("代考");

    const result = await createErrand(
      { success: false, message: "" },
      buildValidErrandFormData(),
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("代考");
    expect(errandTaskCreate).not.toHaveBeenCalled();
  });

  it("rejects errand creation with invalid form data", async () => {
    const formData = buildValidErrandFormData();
    formData.set("reward", "not-a-number");

    const result = await createErrand({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(containsBannedKeyword).not.toHaveBeenCalled();
  });

  it("claims an open errand and creates an accepted order for the runner", async () => {
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "publisher-1",
      accepterId: null,
      status: "OPEN",
      reward: 8,
    });
    txOrderCreate.mockResolvedValue({ id: "order-1" });

    const formData = new FormData();
    formData.set("errandId", "errand-1");

    await claimErrand(formData);

    expect(txErrandTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "errand-1", status: "OPEN", accepterId: null },
      data: { accepterId: "user-1", status: "CLAIMED" },
    });
    expect(txOrderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "ERRAND",
        status: "ACCEPTED",
        buyerId: "publisher-1",
        sellerId: "user-1",
        errandTaskId: "errand-1",
      }),
    });
    expect(createNotifications).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ userId: "publisher-1" }),
        expect.objectContaining({ userId: "user-1" }),
      ]),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/errands/errand-1");
  });

  it("ignores claims for missing or non-open errands", async () => {
    errandTaskFindFirst.mockResolvedValue(null);
    const formData = new FormData();
    formData.set("errandId", "errand-1");
    await claimErrand(formData);
    expect(transactionMock).not.toHaveBeenCalled();

    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "publisher-1",
      accepterId: "runner-9",
      status: "OPEN",
      reward: 8,
    });
    await claimErrand(formData);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("lets the accepter start a claimed errand", async () => {
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "publisher-1",
      accepterId: "user-1",
      status: "CLAIMED",
    });
    txOrderFindFirst.mockResolvedValue({
      id: "order-1",
      buyerId: "publisher-1",
      sellerId: "user-1",
    });

    await updateErrandStatus(buildErrandStatusFormData("IN_PROGRESS"));

    expect(txErrandTaskUpdate).toHaveBeenCalledWith({
      where: { id: "errand-1" },
      data: { status: "IN_PROGRESS" },
    });
    expect(txOrderUpdate).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "IN_PROGRESS" },
    });
  });

  it("lets the accepter submit the errand for confirmation", async () => {
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "publisher-1",
      accepterId: "user-1",
      status: "IN_PROGRESS",
    });
    txOrderFindFirst.mockResolvedValue(null);

    await updateErrandStatus(buildErrandStatusFormData("PENDING_CONFIRMATION"));

    expect(txErrandTaskUpdate).toHaveBeenCalledWith({
      where: { id: "errand-1" },
      data: { status: "PENDING_CONFIRMATION" },
    });
    // 没有关联订单时仅更新任务并通知
    expect(txOrderUpdate).not.toHaveBeenCalled();
  });

  it("completes the errand via the canonical exactly-once transaction", async () => {
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "user-1",
      accepterId: "runner-1",
      status: "PENDING_CONFIRMATION",
    });
    txOrderFindFirst.mockResolvedValue({
      id: "order-1",
      buyerId: "user-1",
      sellerId: "runner-1",
    });

    await updateErrandStatus(buildErrandStatusFormData("COMPLETED"));

    // canonical 事务：条件流转 ErrandTask → Order，不做无条件 update
    expect(txErrandTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "errand-1", status: "PENDING_CONFIRMATION" },
      data: { status: "COMPLETED" },
    });
    expect(txOrderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "IN_PROGRESS" },
      data: { status: "COMPLETED", completedAt: expect.any(Date) },
    });
    expect(txOrderUpdate).not.toHaveBeenCalled();
    // 双方完成计数恰好各 +1
    expect(txUserUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: "user-1" },
      data: { completedOrdersCount: { increment: 1 } },
    });
    expect(txUserUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: "runner-1" },
      data: { completedOrdersCount: { increment: 1 } },
    });
    // canonical 完成通知：每个接收者恰好一条，无重复
    const completionCalls = createNotifications.mock.calls.filter((call) =>
      (call[1] as Array<{ title?: string }>).some((p) => p.title === "跑腿订单已完成"),
    );
    expect(completionCalls).toHaveLength(1);
    const payloads = completionCalls[0][1] as Array<{ userId: string }>;
    expect(payloads).toHaveLength(2);
    expect(payloads.map((p) => p.userId).sort()).toEqual(["runner-1", "user-1"]);
  });

  it("rejects premature completion when ErrandTask is still IN_PROGRESS (forged request)", async () => {
    // 伪造请求场景：Order 已 IN_PROGRESS 但接单者尚未提交完成
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "user-1",
      accepterId: "runner-1",
      status: "PENDING_CONFIRMATION",
    });
    txOrderFindFirst.mockResolvedValue({
      id: "order-1",
      buyerId: "user-1",
      sellerId: "runner-1",
    });
    // canonical 闸门：ErrandTask 非_PENDING_CONFIRMATION → count=0
    txErrandTaskUpdateMany.mockResolvedValue({ count: 0 });

    await updateErrandStatus(buildErrandStatusFormData("COMPLETED"));

    // Order / 计数 / 通知全部不得变更
    expect(txOrderUpdateMany).not.toHaveBeenCalled();
    expect(txUserUpdate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("is idempotent: re-submitting COMPLETED produces no duplicate side effects", async () => {
    // 已完成的任务再次提交完成：动作前置校验直接拒绝（no-op）
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "user-1",
      accepterId: "runner-1",
      status: "COMPLETED",
    });

    await updateErrandStatus(buildErrandStatusFormData("COMPLETED"));

    expect(txErrandTaskUpdateMany).not.toHaveBeenCalled();
    expect(txOrderUpdateMany).not.toHaveBeenCalled();
    expect(txUserUpdate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("ignores status changes that violate the state machine", async () => {
    // 接单者不能直接完成任务
    errandTaskFindFirst.mockResolvedValue({
      id: "errand-1",
      publisherId: "publisher-1",
      accepterId: "user-1",
      status: "IN_PROGRESS",
    });

    await updateErrandStatus(buildErrandStatusFormData("COMPLETED"));

    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("ignores invalid status payloads", async () => {
    const formData = new FormData();
    formData.set("errandId", "errand-1");
    formData.set("status", "NOT_A_STATUS");

    await updateErrandStatus(formData);

    expect(errandTaskFindFirst).not.toHaveBeenCalled();
  });

  it("creates an errand with advance pay fields when requested", async () => {
    errandCategoryFindUnique.mockResolvedValue({
      id: "errand-category-1",
      isActive: true,
    });
    errandTaskCreate.mockResolvedValue({ id: "errand-adv" });

    const formData = buildValidErrandFormData();
    formData.set("needsAdvancePay", "true");
    formData.set("advanceAmount", "12.5");

    const result = await createErrand({ success: false, message: "" }, formData);

    expect(result.success).toBe(true);
    expect(errandTaskCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        needsAdvancePay: true,
        advanceAmount: expect.anything(),
        contactNote: "到了发消息",
      }),
    });
  });

  it("rejects errand creation with a past deadline", async () => {
    const formData = buildValidErrandFormData();
    formData.set("deadline", "2020-01-01T10:00");

    const result = await createErrand({ success: false, message: "" }, formData);

    expect(result).toEqual({ success: false, message: "截止时间必须晚于当前时间" });
    expect(errandTaskCreate).not.toHaveBeenCalled();
  });

  it("rejects errand creation when the publisher record is missing", async () => {
    userFindUnique.mockResolvedValue(null);

    const result = await createErrand({ success: false, message: "" }, buildValidErrandFormData());

    expect(result).toEqual({ success: false, message: "用户不存在" });
  });

  it("updates an open errand for its publisher", async () => {
    errandTaskFindFirst.mockResolvedValue({ id: "errand-1", status: "OPEN" });
    errandCategoryFindUnique.mockResolvedValue({
      id: "errand-category-1",
      isActive: true,
    });

    const formData = buildValidErrandFormData();
    formData.set("errandId", "errand-1");
    formData.set("title", "帮我取顺丰快递");

    const result = await updateErrand({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: true,
      message: "任务已更新",
      redirectTo: "/errands/errand-1",
    });
    expect(errandTaskUpdate).toHaveBeenCalledWith({
      where: { id: "errand-1" },
      data: expect.objectContaining({ title: "帮我取顺丰快递" }),
    });
  });

  it("rejects updates without an errand id", async () => {
    const result = await updateErrand({ success: false, message: "" }, buildValidErrandFormData());

    expect(result).toEqual({ success: false, message: "任务不存在" });
  });

  it("rejects updates with a past deadline", async () => {
    const formData = buildValidErrandFormData();
    formData.set("errandId", "errand-1");
    formData.set("deadline", "2020-01-01T10:00");

    const result = await updateErrand({ success: false, message: "" }, formData);

    expect(result).toEqual({ success: false, message: "截止时间必须晚于当前时间" });
  });

  it("rejects updates for errands owned by others", async () => {
    errandTaskFindFirst.mockResolvedValue(null);

    const formData = buildValidErrandFormData();
    formData.set("errandId", "errand-2");

    const result = await updateErrand({ success: false, message: "" }, formData);

    expect(result).toEqual({ success: false, message: "无权修改该任务" });
  });

  it("rejects updates that hit a banned keyword", async () => {
    errandTaskFindFirst.mockResolvedValue({ id: "errand-1", status: "OPEN" });
    errandCategoryFindUnique.mockResolvedValue({
      id: "errand-category-1",
      isActive: true,
    });
    containsBannedKeyword.mockResolvedValue("刷单");

    const formData = buildValidErrandFormData();
    formData.set("errandId", "errand-1");

    const result = await updateErrand({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toContain("刷单");
    expect(errandTaskUpdate).not.toHaveBeenCalled();
  });
});
