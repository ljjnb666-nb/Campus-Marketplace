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
  errandRowHolder,
  activeOrderRowsHolder,
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
  const txErrandTaskCreate = vi.fn();
  const errandTaskFindFirst = vi.fn();

  // AUDIT2-RB02：状态/编辑/删除走 canonical lifecycle 的 $queryRaw 行权威——
  // ErrandTask candidate discovery + FOR UPDATE 与 active Order FOR UPDATE
  // 按表分发；行内容由测试用例通过 holder 配置
  const errandRowHolder = {
    row: {
      id: "errand-1",
      campusId: "campus-1",
      status: "OPEN",
      reward: "10",
      publisherId: "publisher-1",
      accepterId: null,
      deletedAt: null,
    } as Record<string, unknown> | null,
  };
  const activeOrderRowsHolder = { rows: [] as Record<string, unknown>[] };

  const transactionClient = {
    errandTask: {
      create: txErrandTaskCreate,
      // RB-03 REVIEW FIX：updateErrandStatusTx 的 fresh read 在 tx 内
      findFirst: errandTaskFindFirst,
      update: txErrandTaskUpdate,
      updateMany: txErrandTaskUpdateMany,
    },
    campusMembership: {
      findFirst: vi.fn().mockResolvedValue({ id: "m-1" }),
    },
    riskState: {
      findMany: vi.fn().mockResolvedValue([]),
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
    // Phase 7C：ErrandTask 行锁（FOR UPDATE）+ 活跃 moderation 复查；
    // AUDIT2-RB02：canonical lifecycle 行权威按表分发
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (sql.includes('FROM "ErrandTask"')) {
        const row = errandRowHolder.row;
        if (sql.includes("FOR UPDATE")) {
          return row ? [row] : [];
        }
        return row && row.deletedAt == null ? [row] : [];
      }
      if (sql.includes('FROM "Order"')) {
        return activeOrderRowsHolder.rows;
      }
      return [];
    }),
    listingModeration: {
      findFirst: vi.fn(async () => null),
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
    errandTaskCreate: txErrandTaskCreate,
    errandTaskFindFirst,
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
    errandRowHolder,
    activeOrderRowsHolder,
  };
});

vi.mock("@/lib/governance/active-account-mutation", () => ({
  prepareActiveAccountMutation: vi.fn().mockResolvedValue(undefined),
  // AUDIT2-RB02：canonical lifecycle 使用 checks-only 变体（锁由路径自持）
  assertActiveAccountMutationAllowed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/enforcement/capability-gate", () => ({
  enforceMarketplaceCapability: vi.fn().mockResolvedValue(undefined),
  requireMarketplaceCapability: vi.fn().mockResolvedValue(undefined),
  requireParticipantsMarketplaceEligible: vi.fn().mockResolvedValue(undefined),
  marketplaceObligationValidator: vi.fn(() => async () => undefined),
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

    // canonical lifecycle 行权威默认行（claim 路径契约不变）
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "OPEN",
      reward: "10",
      publisherId: "publisher-1",
      accepterId: null,
      deletedAt: null,
    };
    activeOrderRowsHolder.rows = [];

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
      campusId: "campus-1",
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
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "IN_PROGRESS",
      publisherId: "user-1",
      accepterId: "runner-1",
      deletedAt: null,
    };

    await updateErrandStatus(buildErrandStatusFormData("OPEN"));

    // RB-03 REVIEW FIX：拒绝权威在事务内 fresh 复核（事务总是进入）
    expect(transactionMock).toHaveBeenCalled();
    expect(txErrandTaskUpdateMany).not.toHaveBeenCalled();
    expect(txOrderUpdateMany).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("allows the publisher to reopen a newly claimed errand and cancel the accepted order", async () => {
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "CLAIMED",
      publisherId: "user-1",
      accepterId: "runner-1",
      deletedAt: null,
    };
    activeOrderRowsHolder.rows = [
      { id: "order-1", status: "ACCEPTED", buyerId: "user-1", sellerId: "runner-1" },
    ];

    await updateErrandStatus(buildErrandStatusFormData("OPEN"));

    // AUDIT2-RB02：canonical pair 写入（Task 先行 + Order ACCEPTED → CANCELLED）
    expect(txErrandTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "errand-1", status: "CLAIMED" },
      data: {
        status: "OPEN",
        accepterId: null,
      },
    });
    expect(txOrderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "ACCEPTED" },
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
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "OPEN",
      publisherId: "user-1",
      accepterId: null,
      deletedAt: null,
    };

    const formData = new FormData();
    formData.set("errandId", "errand-1");

    await expect(deleteErrand(formData)).rejects.toThrow("REDIRECT:/my/errands");

    // AUDIT2-RB02：删除走事务级 domain helper（锁内 fresh 权威）
    expect(txErrandTaskUpdate).toHaveBeenCalledWith({
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

  it("does not delete errands that are in progress, completed, or owned by others", async () => {
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "IN_PROGRESS",
      publisherId: "user-1",
      accepterId: "runner-1",
      deletedAt: null,
    };

    const formData = new FormData();
    formData.set("errandId", "errand-1");

    await expect(deleteErrand(formData)).rejects.toThrow("REDIRECT:/my/errands");

    expect(txErrandTaskUpdate).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();

    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "OPEN",
      publisherId: "someone-else",
      accepterId: null,
      deletedAt: null,
    };
    await expect(deleteErrand(formData)).rejects.toThrow("REDIRECT:/my/errands");
    expect(txErrandTaskUpdate).not.toHaveBeenCalled();
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
      campusId: "campus-1",
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
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "CLAIMED",
      publisherId: "publisher-1",
      accepterId: "user-1",
      deletedAt: null,
    };
    activeOrderRowsHolder.rows = [
      { id: "order-1", status: "ACCEPTED", buyerId: "publisher-1", sellerId: "user-1" },
    ];

    await updateErrandStatus(buildErrandStatusFormData("IN_PROGRESS"));

    expect(txErrandTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "errand-1", status: "CLAIMED" },
      data: { status: "IN_PROGRESS" },
    });
    expect(txOrderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "ACCEPTED" },
      data: { status: "IN_PROGRESS" },
    });
  });

  it("lets the accepter submit the errand for confirmation", async () => {
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "IN_PROGRESS",
      publisherId: "publisher-1",
      accepterId: "user-1",
      deletedAt: null,
    };
    activeOrderRowsHolder.rows = [
      { id: "order-1", status: "IN_PROGRESS", buyerId: "publisher-1", sellerId: "user-1" },
    ];

    await updateErrandStatus(buildErrandStatusFormData("PENDING_CONFIRMATION"));

    expect(txErrandTaskUpdateMany).toHaveBeenCalledWith({
      where: { id: "errand-1", status: "IN_PROGRESS" },
      data: { status: "PENDING_CONFIRMATION" },
    });
    // canonical pair：Order 保持 IN_PROGRESS 不变
    expect(txOrderUpdateMany).not.toHaveBeenCalled();
  });

  it("completes the errand via the canonical exactly-once transaction", async () => {
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "PENDING_CONFIRMATION",
      publisherId: "user-1",
      accepterId: "runner-1",
      deletedAt: null,
    };
    activeOrderRowsHolder.rows = [
      { id: "order-1", status: "IN_PROGRESS", buyerId: "user-1", sellerId: "runner-1" },
    ];

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
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "IN_PROGRESS",
      publisherId: "user-1",
      accepterId: "runner-1",
      deletedAt: null,
    };
    activeOrderRowsHolder.rows = [
      { id: "order-1", status: "IN_PROGRESS", buyerId: "user-1", sellerId: "runner-1" },
    ];

    await updateErrandStatus(buildErrandStatusFormData("COMPLETED"));

    // canonical pair 谓词拒绝（Task IN_PROGRESS ≠ COMPLETED 前置）：
    // Order / 计数 / 通知全部不得变更
    expect(txErrandTaskUpdateMany).not.toHaveBeenCalled();
    expect(txOrderUpdateMany).not.toHaveBeenCalled();
    expect(txUserUpdate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("is idempotent: re-submitting COMPLETED produces no duplicate side effects", async () => {
    // 已完成的任务再次提交完成：动作前置校验直接拒绝（no-op）
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "COMPLETED",
      publisherId: "user-1",
      accepterId: "runner-1",
      deletedAt: null,
    };

    await updateErrandStatus(buildErrandStatusFormData("COMPLETED"));

    expect(txErrandTaskUpdateMany).not.toHaveBeenCalled();
    expect(txOrderUpdateMany).not.toHaveBeenCalled();
    expect(txUserUpdate).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("ignores status changes that violate the state machine", async () => {
    // 接单者不能直接完成任务
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "IN_PROGRESS",
      publisherId: "publisher-1",
      accepterId: "user-1",
      deletedAt: null,
    };

    await updateErrandStatus(buildErrandStatusFormData("COMPLETED"));

    expect(transactionMock).toHaveBeenCalled();
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
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "OPEN",
      publisherId: "user-1",
      accepterId: null,
      deletedAt: null,
    };
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
    // AUDIT2-RB02：编辑写权威 = updateErrandContentTx（锁内 fresh OPEN 谓词）
    expect(txErrandTaskUpdate).toHaveBeenCalledWith({
      where: { id: "errand-1" },
      data: expect.objectContaining({ title: "帮我取顺丰快递" }),
    });
  });

  it("rejects edits when the task was claimed after the stale OPEN snapshot", async () => {
    // 事务外 pre-read 看到 OPEN；锁内 fresh 已是 CLAIMED → 稳定业务错误，零写
    errandTaskFindFirst.mockResolvedValue({ id: "errand-1", status: "OPEN" });
    errandCategoryFindUnique.mockResolvedValue({
      id: "errand-category-1",
      isActive: true,
    });
    errandRowHolder.row = {
      id: "errand-1",
      campusId: "campus-1",
      status: "CLAIMED",
      publisherId: "user-1",
      accepterId: "runner-1",
      deletedAt: null,
    };

    const formData = buildValidErrandFormData();
    formData.set("errandId", "errand-1");

    const result = await updateErrand({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "只有待接单任务允许编辑",
    });
    expect(txErrandTaskUpdate).not.toHaveBeenCalled();
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
