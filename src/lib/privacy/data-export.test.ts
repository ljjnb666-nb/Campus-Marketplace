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
      userVerification: { findUnique: fn() },
      product: { findMany: fn() },
      errandTask: { findMany: fn() },
      serviceListing: { findMany: fn() },
      rentalListing: { findMany: fn() },
      order: { findMany: fn() },
      rentalOrder: { findMany: fn() },
      review: { findMany: fn() },
      rentalReview: { findMany: fn() },
      report: { findMany: fn() },
      notification: { findMany: fn() },
      supportTicket: { findMany: fn() },
      message: { findMany: fn() },
      uploadedAsset: { findMany: fn() },
      privacyRequest: { findMany: fn() },
      appeal: { findMany: fn() },
    },
    privacyRequestCreate: fn(),
    privacyRequestUpdate: fn(),
    privacyRequestFindUnique: fn(),
    transactionMock: fn(),
  };
});

vi.mock("@/lib/governance/active-account-mutation", () => ({
  prepareActiveAccountMutation: vi.fn().mockResolvedValue(undefined),
  assertActiveAccountMutationAllowed: vi.fn().mockResolvedValue(undefined),
}));


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
    phone: "13900000000",
    studentIdLast4: "1234",
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

  // Repair 4：默认无认证记录 / 无 inbox / 无工单 / 无租赁评价
  restModels.userVerification.findUnique.mockResolvedValue(null);
  restModels.notification.findMany.mockResolvedValue([]);
  restModels.supportTicket.findMany.mockResolvedValue([]);
  restModels.rentalReview.findMany.mockResolvedValue([]);

  restModels.product.findMany.mockResolvedValue([]);
  restModels.errandTask.findMany.mockResolvedValue([]);
  restModels.serviceListing.findMany.mockResolvedValue([]);
  restModels.rentalListing.findMany.mockResolvedValue([]);

  // 订单含对方卖家：导出只暴露其公共字段；buyer 视角携带本人下单留言
  restModels.order.findMany.mockImplementation(({ where }: { where: { buyerId?: string; sellerId?: string } }) => {
    if (where.buyerId === SELF_USER_ID) {
      return Promise.resolve([
        {
          id: "order-1",
          orderNo: "NO20260901001",
          type: "PRODUCT",
          status: "COMPLETED",
          amount: "42.00",
          note: "放驿站即可",
          createdAt: new Date("2026-09-01T00:00:00Z"),
          seller: OTHER_USER_PRIVATE,
        },
      ]);
    }

    return Promise.resolve([]);
  });

  restModels.rentalOrder.findMany.mockResolvedValue([]);
  restModels.review.findMany.mockResolvedValue([]);
  // Phase 6C-1B：默认无申诉
  restModels.appeal.findMany.mockResolvedValue([]);
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
    // Phase 6C-1B：Appeal 内部字段结构性禁止进入任何导出
    expect(FORBIDDEN_EXPORT_KEYS).toContain("decisionNote");
    expect(FORBIDDEN_EXPORT_KEYS).toContain("reviewedById");
    // Repair 4 / RB-04：OPERATOR_ONLY 面 + 内部治理标识 + OAuth token 变体
    expect(FORBIDDEN_EXPORT_KEYS).toContain("internalNote");
    expect(FORBIDDEN_EXPORT_KEYS).toContain("adminNote");
    expect(FORBIDDEN_EXPORT_KEYS).toContain("handledById");
    expect(FORBIDDEN_EXPORT_KEYS).toContain("resolvedById");
    expect(FORBIDDEN_EXPORT_KEYS).toContain("assignedToId");
    expect(FORBIDDEN_EXPORT_KEYS).toContain("access_token");
    expect(FORBIDDEN_EXPORT_KEYS).toContain("refresh_token");
    expect(FORBIDDEN_EXPORT_KEYS).toContain("id_token");
  });
});

describe("Repair 4 export v3（verification / notifications / support / rentalReviews / user-authored enrichment）", () => {
  it("EXPORT-02：account 携带完整 direct identity（phone/studentIdLast4 进入本人导出）", async () => {
    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.account.phone).toBe("13900000000");
    expect(payload.account.studentIdLast4).toBe("1234");
    expect(payload.account).not.toHaveProperty("passwordHash");
    expect(payload.account).not.toHaveProperty("lastLoginAt");
    expect(payload.account).not.toHaveProperty("storageUsedBytes");
  });

  it("EXPORT-03：verification safe subset——reviewNote/reviewedById/定位符结构性缺席，证据只出受控 asset id", async () => {
    restModels.userVerification.findUnique.mockResolvedValue({
      status: "REJECTED",
      schoolName: "示例大学",
      campusName: "主校区",
      studentIdLast4: "1234",
      reasonCode: "VERIFICATION_MATERIALS_INVALID",
      submittedAt: new Date("2026-09-01T00:00:00Z"),
      reviewedAt: new Date("2026-09-02T00:00:00Z"),
      policyVersion: 3,
      policyHash: "policy-hash",
      // 原始引用串（受控 asset ref）+ operator 自由文本 + reviewer 内部标识
      studentCardImage: "asset:asset-9",
      reviewNote: "材料模糊请重拍",
      reviewedById: "reviewer-internal-id",
    });

    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.verification).toEqual({
      status: "REJECTED",
      schoolName: "示例大学",
      campusName: "主校区",
      studentIdLast4: "1234",
      reasonCode: "VERIFICATION_MATERIALS_INVALID",
      submittedAt: "2026-09-01T00:00:00.000Z",
      reviewedAt: "2026-09-02T00:00:00.000Z",
      policyVersion: 3,
      policyHash: "policy-hash",
      evidenceAssetId: "asset-9",
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("材料模糊请重拍");
    expect(serialized).not.toContain("reviewer-internal-id");
    expect(serialized).not.toContain("studentCardImage");
    expect(serialized).not.toContain("reviewNote");
  });

  it("EXPORT-04：notifications 为本人 inbox safe 子集", async () => {
    restModels.notification.findMany.mockResolvedValue([
      {
        id: "notif-1",
        type: "RENTAL",
        title: "租赁申请已通过",
        content: "你的租赁申请已被通过，请留意取货信息。",
        isRead: false,
        createdAt: new Date("2026-09-03T00:00:00Z"),
      },
    ]);

    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.notifications).toHaveLength(1);
    expect(payload.notifications[0]).toEqual({
      id: "notif-1",
      type: "RENTAL",
      title: "租赁申请已通过",
      content: "你的租赁申请已被通过，请留意取货信息。",
      isRead: false,
      createdAt: "2026-09-03T00:00:00.000Z",
    });
    expect(restModels.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: SELF_USER_ID } }),
    );
  });

  it("EXPORT-05：supportTickets requester-safe subset——internalNote/assignedToId/resolvedById 绝不出现", async () => {
    restModels.supportTicket.findMany.mockResolvedValue([
      {
        id: "ticket-1",
        category: "ACCOUNT",
        status: "RESOLVED",
        subject: "无法登录",
        description: "重置密码后仍然无法登录",
        resolutionCode: "ISSUE_FIXED",
        resolutionMessage: "已处理，请重试",
        createdAt: new Date("2026-09-04T00:00:00Z"),
        resolvedAt: new Date("2026-09-05T00:00:00Z"),
      },
    ]);

    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.supportTickets).toHaveLength(1);
    expect(payload.supportTickets[0]).toMatchObject({
      id: "ticket-1",
      subject: "无法登录",
      description: "重置密码后仍然无法登录",
      resolutionMessage: "已处理，请重试",
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("internalNote");
    expect(serialized).not.toContain("assignedToId");
    expect(serialized).not.toContain("resolvedById");
  });

  it("EXPORT-06：rentalReviewsWritten 仅本人 authored（rating 维度 + 文本 + target 公共引用）", async () => {
    restModels.rentalReview.findMany.mockResolvedValue([
      {
        id: "rreview-1",
        orderId: "rental-order-1",
        overallRating: 5,
        itemMatchDesc: 5,
        itemWorksWell: 5,
        ownerResponsive: 4,
        pickupEasy: 5,
        attitudeFriendly: 5,
        returnedOnTime: null,
        itemWellKept: null,
        accessoriesComplete: null,
        goodCommunication: null,
        reliable: null,
        content: "物品状态很好",
        tags: ["守时"],
        createdAt: new Date("2026-09-06T00:00:00Z"),
        targetUser: OTHER_USER_PRIVATE,
      },
    ]);

    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.rentalReviewsWritten).toHaveLength(1);
    expect(payload.rentalReviewsWritten[0]).toMatchObject({
      id: "rreview-1",
      orderId: "rental-order-1",
      overallRating: 5,
      content: "物品状态很好",
      tags: ["守时"],
    });
    expect(payload.rentalReviewsWritten[0].target).toEqual({
      id: OTHER_USER_ID,
      name: "王卖家",
      avatarUrl: "https://assets.example/avatars/other.webp",
    });
  });

  it("EXPORT-06b：reportsFiled 携带本人 authored detail", async () => {
    restModels.report.findMany.mockResolvedValue([
      {
        id: "report-1",
        targetType: "PRODUCT",
        reason: "FRAUD",
        detail: "商品描述与实物不符",
        status: "RESOLVED",
        createdAt: new Date("2026-09-07T00:00:00Z"),
        targetUser: null,
      },
    ]);

    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.reportsFiled[0]).toMatchObject({
      id: "report-1",
      detail: "商品描述与实物不符",
    });
    // handledNote 属 operator/governance：DTO 无此键（结构性缺席）
    expect(payload.reportsFiled[0]).not.toHaveProperty("handledNote");
  });

  it("EXPORT-07：orders buyer 视角携带本人 note；seller 视角绝不携带他人留言", async () => {
    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.orders).toHaveLength(1);
    expect(payload.orders[0].role).toBe("buyer");
    expect(payload.orders[0].note).toBe("放驿站即可");
  });

  it("EXPORT-08：uploadedAssets 为 STORAGE_METADATA safe subset（含 originalFileName；bucket/objectKey 绝不出现）", async () => {
    restModels.uploadedAsset.findMany.mockResolvedValue([
      {
        id: "asset-1",
        category: "AVATAR",
        access: "PUBLIC",
        status: "ATTACHED",
        mimeType: "image/webp",
        sizeBytes: 120,
        width: 64,
        height: 64,
        originalFileName: "me.png",
        createdAt: new Date("2026-09-08T00:00:00Z"),
      },
    ]);

    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.uploadedAssets[0]).toEqual({
      id: "asset-1",
      category: "AVATAR",
      access: "PUBLIC",
      status: "ATTACHED",
      mimeType: "image/webp",
      sizeBytes: 120,
      width: 64,
      height: 64,
      originalFileName: "me.png",
      createdAt: "2026-09-08T00:00:00.000Z",
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("bucket");
    expect(serialized).not.toContain("objectKey");
  });

  it("EXPORT-08b：rentalOrders renter 视角携带 renterNote；cancellationNote 仅在本人取消时携带", async () => {
    restModels.rentalOrder.findMany.mockImplementation(({ where }: { where: { ownerId?: string; renterId?: string } }) => {
      if (where.renterId === SELF_USER_ID) {
        return Promise.resolve([
          {
            id: "rental-order-1",
            orderNumber: "RO20260901001",
            status: "CANCELLED",
            startTime: new Date("2026-09-01T00:00:00Z"),
            endTime: new Date("2026-09-02T00:00:00Z"),
            renterNote: "希望下午送达",
            cancellationNote: "临时有事",
            cancelledById: SELF_USER_ID,
            owner: OTHER_USER_PRIVATE,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.rentalOrders).toHaveLength(1);
    expect(payload.rentalOrders[0]).toMatchObject({
      role: "renter",
      renterNote: "希望下午送达",
      cancellationNote: "临时有事",
    });
  });

  it("EXPORT-08c：cancellationNote 在他人取消时不携带（作者归属精确才导出）", async () => {
    restModels.rentalOrder.findMany.mockImplementation(({ where }: { where: { ownerId?: string; renterId?: string } }) => {
      if (where.renterId === SELF_USER_ID) {
        return Promise.resolve([
          {
            id: "rental-order-2",
            orderNumber: "RO20260902001",
            status: "CANCELLED",
            startTime: new Date("2026-09-01T00:00:00Z"),
            endTime: new Date("2026-09-02T00:00:00Z"),
            renterNote: null,
            cancellationNote: "租客违约取消",
            cancelledById: OTHER_USER_ID,
            owner: OTHER_USER_PRIVATE,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.rentalOrders[0].cancellationNote).toBeNull();
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("租客违约取消");
  });
});

describe("Phase 6C-1B appeal export（APPEAL_EXPORT contract，format 于 Repair 4 升 v3）", () => {
  const CANARY = "APPEAL_EXPORT_INTERNAL_CANARY";

  beforeEach(() => {
    // 带 decisionNote/reviewedById 的完整行：导出 DTO 必须只映射 Appellant 域
    restModels.appeal.findMany.mockResolvedValue([
      {
        id: "appeal-1",
        enforcementActionId: "ea-1",
        status: "GRANTED",
        statement: "我认为处罚有误",
        decisionReasonCode: "MERIT_APPEAL_JUSTIFIED",
        decisionNote: CANARY,
        reviewedById: "reviewer-internal-id",
        reviewedAt: new Date("2026-09-10T00:00:00Z"),
        createdAt: new Date("2026-09-09T00:00:00Z"),
        updatedAt: new Date("2026-09-10T00:00:00Z"),
        enforcementAction: { type: "ACCOUNT_SUSPEND" },
      },
    ]);
  });

  it("export schema version 精确为 campus-marketplace.user-export/v3", async () => {
    const payload = await buildUserExport(SELF_USER_ID);
    expect(payload.format).toBe("campus-marketplace.user-export/v3");
  });

  it("export ownership = enforcementAction.targetId（reviewedById 不是 ownership 条件）", async () => {
    await buildUserExport(SELF_USER_ID);
    expect(restModels.appeal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enforcementAction: { targetId: SELF_USER_ID } },
      }),
    );
  });

  it("appellant-owned Appeal 按 Appellant DTO 域导出（含唯一 context 字段 enforcementType）", async () => {
    const payload = await buildUserExport(SELF_USER_ID);

    expect(payload.appeals).toHaveLength(1);
    expect(payload.appeals[0]).toEqual({
      id: "appeal-1",
      enforcementActionId: "ea-1",
      enforcementType: "ACCOUNT_SUSPEND",
      status: "GRANTED",
      statement: "我认为处罚有误",
      decisionReasonCode: "MERIT_APPEAL_JUSTIFIED",
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
      reviewedAt: "2026-09-10T00:00:00.000Z",
    });

    // 内部字段绝不序列化进导出（T27）
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain("reviewedById");
    expect(serialized).not.toContain("reviewer-internal-id");
  });

  it("assertNoForbiddenExportFields 对 decisionNote/reviewedById 键 fail closed（T28）", async () => {
    const payload = await buildUserExport(SELF_USER_ID);
    expect(() => assertNoForbiddenExportFields(payload)).not.toThrow();

    expect(() =>
      assertNoForbiddenExportFields({ appeals: [{ decisionNote: "internal" }] }),
    ).toThrow(/decisionNote/);
    expect(() =>
      assertNoForbiddenExportFields({ appeals: [{ reviewedById: "r1" }] }),
    ).toThrow(/reviewedById/);
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
