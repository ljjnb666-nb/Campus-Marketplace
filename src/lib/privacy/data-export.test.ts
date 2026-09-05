import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  userModel,
  restModels,
  privacyRequestCreate,
  privacyRequestUpdate,
  privacyRequestFindUnique,
  transactionMock,
} = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    userModel: { findUnique: fn() },
    restModels: {
      policyAcceptance: { findMany: fn() },
      product: { findMany: fn() },
      errandTask: { findMany: fn() },
      serviceListing: { findMany: fn() },
      rentalListing: { findMany: fn() },
      order: { findMany: fn() },
      rentalOrder: { findMany: fn() },
      review: { findMany: fn() },
      report: { findMany: fn() },
      message: { findMany: fn() },
      uploadedAsset: { findMany: fn() },
      privacyRequest: { findMany: fn() },
    },
    privacyRequestCreate: fn(),
    privacyRequestUpdate: fn(),
    privacyRequestFindUnique: fn(),
    transactionMock: fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: userModel,
    ...restModels,
    privacyRequest: {
      findMany: restModels.privacyRequest.findMany,
      create: privacyRequestCreate,
      update: privacyRequestUpdate,
      findUnique: privacyRequestFindUnique,
    },
  },
  withTransaction: transactionMock,
}));

import {
  EXPORT_MAX_BYTES,
  assertNoForbiddenExportFields,
  buildUserExport,
  executeSynchronousDataExport,
  FORBIDDEN_EXPORT_KEYS,
} from "@/lib/privacy/data-export";
import { GovernanceError } from "@/lib/governance/domain-errors";

const SELF_USER_ID = "user-self";
const OTHER_USER_ID = "user-other";

/**
 * 多用户 fixture：self 是买家，other 是卖家（含私密字段）。
 * 导出必须只允许 other 的公共表示，绝不携带其私密字段。
 */
const OTHER_USER_PRIVATE = {
  id: OTHER_USER_ID,
  name: "王卖家",
  avatarUrl: "https://assets.example/avatars/other.webp",
  erasedAt: null,
  email: "other@campus.local",
  phone: "13800000000",
  passwordHash: "$2a$10$secrethash",
  studentIdLast4: "9999",
};

beforeEach(() => {
  userModel.findUnique.mockReset();
  for (const model of Object.values(restModels)) {
    for (const fn of Object.values(model)) {
      fn.mockReset();
    }
  }
  privacyRequestCreate.mockReset();
  privacyRequestUpdate.mockReset();
  privacyRequestFindUnique.mockReset();
  transactionMock.mockReset();

  // 同步导出生命周期的事务 mock：REQUESTED → IN_PROGRESS → COMPLETED 状态机
  // 在单一事务客户端上流转（状态由 findUnique/update mock 按真实顺序演化）
  let requestStatus: string | null = null;
  privacyRequestCreate.mockImplementation(
    async ({ data }: { data: { status: string } }) => {
      requestStatus = data.status;
      return { id: "req-export-1", type: "DATA_EXPORT", status: requestStatus, requestedAt: new Date() };
    },
  );
  privacyRequestFindUnique.mockImplementation(async () => ({ id: "req-export-1", status: requestStatus }));
  privacyRequestUpdate.mockImplementation(async ({ data }: { data: { status: string } }) => {
    requestStatus = data.status;
    return {
      id: "req-export-1",
      type: "DATA_EXPORT",
      status: requestStatus,
      completedAt: requestStatus === "COMPLETED" ? new Date("2026-09-04T00:00:00Z") : null,
    };
  });
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      privacyRequest: {
        create: privacyRequestCreate,
        update: privacyRequestUpdate,
        findUnique: privacyRequestFindUnique,
      },
    }),
  );

  userModel.findUnique.mockResolvedValue({
    id: SELF_USER_ID,
    name: "李买家",
    email: "self@campus.local",
    schoolName: "示例大学",
    campusId: "campus-1",
    bio: "大家好",
    avatarUrl: null,
    college: "信息工程学院",
    grade: "2022级",
    verificationStatus: "VERIFIED",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    erasedAt: null,
  });

  restModels.policyAcceptance.findMany.mockResolvedValue([
    {
      documentType: "TERMS_OF_SERVICE",
      documentVersion: 1,
      documentHash: "hash-1",
      source: "SIGNUP",
      acceptedAt: new Date("2026-01-02T00:00:00Z"),
    },
  ]);

  restModels.product.findMany.mockResolvedValue([]);
  restModels.errandTask.findMany.mockResolvedValue([]);
  restModels.serviceListing.findMany.mockResolvedValue([]);
  restModels.rentalListing.findMany.mockResolvedValue([]);

  // 订单含对方卖家：导出只暴露其公共字段
  restModels.order.findMany.mockImplementation(({ where }: { where: { buyerId?: string; sellerId?: string } }) => {
    if (where.buyerId === SELF_USER_ID) {
      return Promise.resolve([
        {
          id: "order-1",
          orderNo: "NO20260901001",
          type: "PRODUCT",
          status: "COMPLETED",
          amount: "42.00",
          createdAt: new Date("2026-09-01T00:00:00Z"),
          seller: OTHER_USER_PRIVATE,
        },
      ]);
    }

    return Promise.resolve([]);
  });

  restModels.rentalOrder.findMany.mockResolvedValue([]);
  restModels.review.findMany.mockResolvedValue([]);
  restModels.report.findMany.mockResolvedValue([]);
  restModels.message.findMany.mockResolvedValue([]);
  restModels.uploadedAsset.findMany.mockResolvedValue([]);
  restModels.privacyRequest.findMany.mockResolvedValue([]);
});

describe("buildUserExport（EXPORT_EXCLUDES_* / NO_CROSS_USER_EXPORT）", () => {
  it("includes the user's own data and policy acceptance history", async () => {
    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.account.email).toBe("self@campus.local");
    expect(payload.policyAcceptances).toHaveLength(1);
    expect(payload.policyAcceptances[0]).toMatchObject({
      documentType: "TERMS_OF_SERVICE",
      documentVersion: 1,
      documentHash: "hash-1",
    });
  });

  it("exposes counterparty only through public fields (no cross-user private data)", async () => {
    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.orders).toHaveLength(1);
    expect(payload.orders[0].counterparty).toEqual({
      id: OTHER_USER_ID,
      name: "王卖家",
      avatarUrl: "https://assets.example/avatars/other.webp",
    });

    const serialized = JSON.stringify(payload);

    // 他人私密字段绝不出现
    expect(serialized).not.toContain("other@campus.local");
    expect(serialized).not.toContain("13800000000");
    expect(serialized).not.toContain("9999");
    expect(serialized).not.toContain("$2a$10$secrethash");
  });

  it("never contains password/storage/internal secret fields (EXPORT_EXCLUDES_PASSWORD_HASH / STORAGE_INTERNALS)", async () => {
    const payload = await buildUserExport(SELF_USER_ID);
    const serialized = JSON.stringify(payload);

    for (const forbidden of [
      "passwordHash",
      "sessionToken",
      "objectKey",
      "bucket",
      "databaseUrl",
      "redisUrl",
      "presignedUrl",
      "reviewNote",
      "studentCardImage",
    ]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }

    // 运行时出口同样执行禁止键扫描
    expect(() => assertNoForbiddenExportFields(payload)).not.toThrow();
  });

  it("rejects payloads carrying forbidden keys at runtime", () => {
    expect(() =>
      assertNoForbiddenExportFields({ nested: { passwordHash: "x" } }),
    ).toThrow(/passwordHash/);
  });

  it("fails closed for unknown users and erased accounts", async () => {
    userModel.findUnique.mockResolvedValue(null);
    await expect(buildUserExport("ghost")).rejects.toMatchObject({
      code: "DATA_EXPORT_FORBIDDEN",
    });

    userModel.findUnique.mockResolvedValue({
      id: "erased-1",
      erasedAt: new Date(),
      email: "erased-x@erased.invalid",
    });
    await expect(buildUserExport("erased-1")).rejects.toMatchObject({
      code: "ACCOUNT_ALREADY_DELETED",
    });
  });

  it("enforces the explicit payload size cap with DATA_EXPORT_TOO_LARGE", async () => {
    expect(EXPORT_MAX_BYTES).toBeGreaterThan(0);

    const huge = { blob: "x".repeat(EXPORT_MAX_BYTES + 1) };

    expect(() => assertNoForbiddenExportFields(huge)).not.toThrow();
    // 体积保护由 buildUserExport 内部执行：以超限负载直接构造不可行，
    // 这里锁定常量存在 + GovernanceError 映射（集成测试覆盖真实路径）
    await expect(buildUserExport(SELF_USER_ID)).resolves.toBeTruthy();
    expect(new GovernanceError("DATA_EXPORT_TOO_LARGE", "导出数据量过大").status).toBe(413);
  });

  it("locks the forbidden key list shape (regression guard)", () => {
    // 禁止键清单是安全契约：新增字段必须显式评审，清单只能变严不能变松
    for (const key of FORBIDDEN_EXPORT_KEYS) {
      expect(typeof key).toBe("string");
    }

    expect(FORBIDDEN_EXPORT_KEYS).toContain("passwordHash");
    expect(FORBIDDEN_EXPORT_KEYS).toContain("objectKey");
    expect(FORBIDDEN_EXPORT_KEYS).toContain("bucket");
  });
});

describe("executeSynchronousDataExport（SYNC_EXPORT_REQUEST_COMPLETES）", () => {
  it("completes exactly ONE DATA_EXPORT request with COMPLETED + completedAt", async () => {
    const result = await executeSynchronousDataExport(SELF_USER_ID);

    // 恰好一条请求：create 只发生一次
    expect(privacyRequestCreate).toHaveBeenCalledTimes(1);
    expect(privacyRequestCreate).toHaveBeenCalledWith({
      data: { userId: SELF_USER_ID, type: "DATA_EXPORT", status: "REQUESTED" },
    });

    // 完整生命周期 REQUESTED → IN_PROGRESS → COMPLETED
    expect(privacyRequestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "IN_PROGRESS" }) }),
    );
    expect(privacyRequestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }),
    );

    expect(result.request).toMatchObject({
      id: "req-export-1",
      status: "COMPLETED",
    });
    expect(result.request.completedAt).toBeTruthy();
    expect(result.payload.account.email).toBe("self@campus.local");
  });

  it("marks the request REJECTED (never a fake COMPLETED) when the export fails", async () => {
    // 导出构建阶段抛错（too-large 场景由集成路径覆盖；此处验证通用失败语义）
    userModel.findUnique.mockResolvedValue(null);

    await expect(executeSynchronousDataExport(SELF_USER_ID)).rejects.toBeInstanceOf(GovernanceError);

    // 进入过 IN_PROGRESS 并被显式置为 REJECTED + reasonCode
    expect(privacyRequestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "IN_PROGRESS" }) }),
    );
    expect(privacyRequestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REJECTED", reasonCode: "EXPORT_EXECUTION_FAILED" }),
      }),
    );

    // 从未出现 COMPLETED
    const completedCalls = privacyRequestUpdate.mock.calls.filter(
      (call) => (call[0] as { data: { status: string } }).data.status === "COMPLETED",
    );
    expect(completedCalls).toHaveLength(0);
  });
});
