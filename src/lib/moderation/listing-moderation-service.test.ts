import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  txQueryRaw,
  txListingModerationFindFirst,
  txListingModerationCreate,
  txListingModerationUpdateMany,
  txUserFindUnique,
  acquireGovernanceSubjectLocks,
  recordAdminAudit,
  loadAuthorizationContextMock,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  txQueryRaw: vi.fn(),
  txListingModerationFindFirst: vi.fn(),
  txListingModerationCreate: vi.fn(),
  txListingModerationUpdateMany: vi.fn(),
  txUserFindUnique: vi.fn(),
  acquireGovernanceSubjectLocks: vi.fn(),
  recordAdminAudit: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: withTransactionMock,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
}));

vi.mock("@/lib/governance/admin-audit", () => ({
  recordAdminAudit,
}));

vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return {
    ...actual,
    loadAuthorizationContext: loadAuthorizationContextMock,
  };
});

import type { Prisma } from "@prisma/client";
import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  moderateProductListing,
  restoreProductListing,
} from "@/lib/moderation/listing-moderation-service";
import { isModerationError } from "@/lib/moderation/errors";

const txStub = {
  $queryRaw: txQueryRaw,
  listingModeration: {
    findFirst: txListingModerationFindFirst,
    create: txListingModerationCreate,
    updateMany: txListingModerationUpdateMany,
  },
  user: { findUnique: txUserFindUnique },
};

withTransactionMock.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
  run(txStub),
);

const tx = txStub as unknown as Prisma.TransactionClient;

const LOCKED_ACTIVE_ROW = {
  id: "product-1",
  campusId: "campus-1",
  status: "ACTIVE",
  updatedAt: new Date("2026-09-13T10:00:00.000Z"),
  deletedAt: null,
  ownerId: "seller-1",
};

function globalModerator(): AuthorizationContext {
  return {
    userId: "moderator-1",
    accountActive: true,
    activeCampusIds: [],
    grants: [
      {
        roleKey: "PLATFORM_ADMIN",
        scope: "GLOBAL",
        campusId: null,
        permissionKeys: ["listing.moderate"],
      },
    ],
  };
}

function campusModerator(campusId: string): AuthorizationContext {
  return {
    userId: "moderator-1",
    accountActive: true,
    activeCampusIds: [campusId],
    grants: [
      {
        roleKey: "CAMPUS_CONTENT_MODERATOR",
        scope: "CAMPUS",
        campusId,
        permissionKeys: ["listing.moderate"],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  withTransactionMock.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
    run(txStub),
  );
  txQueryRaw.mockResolvedValue([LOCKED_ACTIVE_ROW]);
  acquireGovernanceSubjectLocks.mockResolvedValue(undefined);
  loadAuthorizationContextMock.mockResolvedValue(globalModerator());
  txListingModerationFindFirst.mockResolvedValue(null);
  txListingModerationCreate.mockResolvedValue({ id: "moderation-1" });
  txListingModerationUpdateMany.mockResolvedValue({ count: 1 });
  txUserFindUnique.mockResolvedValue({
    id: "seller-1",
    deletedAt: null,
    erasedAt: null,
  });
});

describe("Phase 7C listing moderation service（R2 冻结合同）", () => {
  it("takedown：USER:moderator 锁先于行锁；活跃行携带 observedStatus/campus；审计仅机器 metadata", async () => {
    const calls: string[] = [];
    acquireGovernanceSubjectLocks.mockImplementation(async () => {
      calls.push("user-lock");
    });
    txQueryRaw.mockImplementation(async () => {
      calls.push("row-lock");
      return [LOCKED_ACTIVE_ROW];
    });

    const result = await moderateProductListing({
      moderatorId: "moderator-1",
      listingId: "product-1",
      reasonCode: "PROHIBITED_ITEM",
      note: "  违禁品  ",
    });

    expect(result).toEqual({ outcome: "TAKEDOWN", moderationId: "moderation-1" });
    expect(calls).toEqual(["user-lock", "row-lock"]);
    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(tx, [
      { subjectType: "USER", subjectId: "moderator-1" },
    ]);
    expect(txListingModerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetType: "PRODUCT",
          productId: "product-1",
          serviceListingId: null,
          errandTaskId: null,
          rentalListingId: null,
          campusId: "campus-1",
          observedStatus: "ACTIVE",
          reasonCode: "PROHIBITED_ITEM",
          note: "违禁品",
        }),
        select: { id: true },
      }),
    );
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LISTING_TAKEDOWN",
        targetType: "LISTING",
        targetId: "product-1",
        campusId: "campus-1",
        metadata: { listingType: "PRODUCT", moderationId: "moderation-1", reasonCode: "PROHIBITED_ITEM" },
      }),
      tx,
    );
  });

  it("takedown：重复处置幂等（ALREADY_MODERATED，零新行零新审计）", async () => {
    txListingModerationFindFirst.mockResolvedValue({ id: "existing-1", createdAt: new Date() });

    const result = await moderateProductListing({
      moderatorId: "moderator-1",
      listingId: "product-1",
      reasonCode: "OTHER",
    });

    expect(result).toEqual({ outcome: "ALREADY_MODERATED", moderationId: "existing-1" });
    expect(txListingModerationCreate).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it("takedown：SELF_MODERATION = DENY（零例外）", async () => {
    await expect(
      moderateProductListing({
        moderatorId: "seller-1",
        listingId: "product-1",
        reasonCode: "OTHER",
      }),
    ).rejects.toSatisfy((error: unknown) => isModerationError(error) && error.code === "MODERATION_SELF_DENIED");
    expect(txListingModerationCreate).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it("takedown：账号非激活 → AUTH_ACCOUNT_INACTIVE；授权在锁后重读", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "moderator-1",
      accountActive: false,
      activeCampusIds: [],
      grants: [],
    });

    await expect(
      moderateProductListing({
        moderatorId: "moderator-1",
        listingId: "product-1",
        reasonCode: "OTHER",
      }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
    expect(txListingModerationCreate).not.toHaveBeenCalled();
  });

  it("takedown：campus moderator exact campus 放行；跨校区 AUTH_CAMPUS_SCOPE_MISMATCH", async () => {
    loadAuthorizationContextMock.mockResolvedValue(campusModerator("campus-1"));
    await expect(
      moderateProductListing({
        moderatorId: "moderator-1",
        listingId: "product-1",
        reasonCode: "OTHER",
      }),
    ).resolves.toEqual({ outcome: "TAKEDOWN", moderationId: "moderation-1" });

    loadAuthorizationContextMock.mockResolvedValue(campusModerator("campus-2"));
    await expect(
      moderateProductListing({
        moderatorId: "moderator-1",
        listingId: "product-1",
        reasonCode: "OTHER",
      }),
    ).rejects.toMatchObject({ code: "AUTH_CAMPUS_SCOPE_MISMATCH" });
    expect(recordAdminAudit).toHaveBeenCalledTimes(1);
  });

  it("restore：moderationId 失配 → STALE_MODERATION_REVIEW（ABA 关闭，零 resolve 零审计）", async () => {
    txListingModerationFindFirst.mockResolvedValue({ id: "moderation-2", createdAt: new Date() });

    await expect(
      restoreProductListing({
        moderatorId: "moderator-1",
        listingId: "product-1",
        moderationId: "moderation-1",
        expectedListingUpdatedAt: LOCKED_ACTIVE_ROW.updatedAt,
      }),
    ).rejects.toSatisfy((error: unknown) => isModerationError(error) && error.code === "STALE_MODERATION_REVIEW");
    expect(txListingModerationUpdateMany).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it("restore：updatedAt 失配 → STALE（owner 隐藏期编辑后旧 token 失效）", async () => {
    txListingModerationFindFirst.mockResolvedValue({ id: "moderation-1", createdAt: new Date() });

    await expect(
      restoreProductListing({
        moderatorId: "moderator-1",
        listingId: "product-1",
        moderationId: "moderation-1",
        expectedListingUpdatedAt: new Date("2026-09-13T09:00:00.000Z"),
      }),
    ).rejects.toSatisfy((error: unknown) => isModerationError(error) && error.code === "STALE_MODERATION_REVIEW");
    expect(txListingModerationUpdateMany).not.toHaveBeenCalled();
  });

  it("restore：owner 已删除/注销 → RESTORE_NOT_RESTORABLE（M 保持 active，零审计）", async () => {
    txListingModerationFindFirst.mockResolvedValue({ id: "moderation-1", createdAt: new Date() });
    txUserFindUnique.mockResolvedValue({
      id: "seller-1",
      deletedAt: null,
      erasedAt: new Date("2026-09-13T11:00:00.000Z"),
    });

    await expect(
      restoreProductListing({
        moderatorId: "moderator-1",
        listingId: "product-1",
        moderationId: "moderation-1",
        expectedListingUpdatedAt: LOCKED_ACTIVE_ROW.updatedAt,
      }),
    ).rejects.toSatisfy((error: unknown) => isModerationError(error) && error.code === "RESTORE_NOT_RESTORABLE");
    expect(txListingModerationUpdateMany).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it("restore：双 token 精确匹配 → resolve + LISTING_RESTORED 审计", async () => {
    txListingModerationFindFirst.mockResolvedValue({ id: "moderation-1", createdAt: new Date() });

    const result = await restoreProductListing({
      moderatorId: "moderator-1",
      listingId: "product-1",
      moderationId: "moderation-1",
      expectedListingUpdatedAt: LOCKED_ACTIVE_ROW.updatedAt,
    });

    expect(result).toEqual({ outcome: "RESTORED", moderationId: "moderation-1" });
    expect(txListingModerationUpdateMany).toHaveBeenCalledWith({
      where: { id: "moderation-1", resolvedAt: null },
      data: expect.objectContaining({ resolvedById: "moderator-1" }),
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LISTING_RESTORED",
        metadata: { listingType: "PRODUCT", moderationId: "moderation-1" },
      }),
      tx,
    );
  });

  it("takedown：listing 缺失/已删除 → MODERATION_TARGET_NOT_FOUND", async () => {
    txQueryRaw.mockResolvedValue([]);
    await expect(
      moderateProductListing({
        moderatorId: "moderator-1",
        listingId: "product-404",
        reasonCode: "OTHER",
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isModerationError(error) && error.code === "MODERATION_TARGET_NOT_FOUND",
    );
  });

  it("note 超长 fail closed（≤500 冻结）", async () => {
    await expect(
      moderateProductListing({
        moderatorId: "moderator-1",
        listingId: "product-1",
        reasonCode: "OTHER",
        note: "x".repeat(501),
      }),
    ).rejects.toThrow("备注不能超过 500 字");
  });
});

// ── FR-05 branch 补全：SERVICE/ERRAND/RENTAL typed seams + restore 全域 ──────

describe("Phase 7C 四域 typed seams（dispatch 分支覆盖）", () => {
  it("moderateServiceListing：SERVICE FK 落位 + observedStatus", async () => {
    txQueryRaw.mockResolvedValue([
      { ...LOCKED_ACTIVE_ROW, campusId: "campus-9", status: "ACTIVE", ownerId: "provider-1" },
    ]);
    loadAuthorizationContextMock.mockResolvedValue(globalModerator());

    const result = await (await import("@/lib/moderation/listing-moderation-service"))
      .moderateServiceListing({
        moderatorId: "moderator-1",
        listingId: "service-1",
        reasonCode: "SPAM_ADVERTISEMENT",
      });

    expect(result.outcome).toBe("TAKEDOWN");
    expect(txListingModerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetType: "SERVICE",
          productId: null,
          serviceListingId: "service-1",
          errandTaskId: null,
          rentalListingId: null,
        }),
      }),
    );
  });

  it("moderateErrandListing：ERRAND FK 落位", async () => {
    txQueryRaw.mockResolvedValue([
      { ...LOCKED_ACTIVE_ROW, ownerId: "publisher-1" },
    ]);
    const result = await (await import("@/lib/moderation/listing-moderation-service"))
      .moderateErrandListing({
        moderatorId: "moderator-1",
        listingId: "errand-1",
        reasonCode: "OTHER",
      });
    expect(txListingModerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetType: "ERRAND",
          errandTaskId: "errand-1",
          productId: null,
          serviceListingId: null,
          rentalListingId: null,
        }),
      }),
    );
  });

  it("moderateRentalListing：RENTAL FK 落位", async () => {
    txQueryRaw.mockResolvedValue([
      { ...LOCKED_ACTIVE_ROW, ownerId: "rental-owner-1" },
    ]);
    await (await import("@/lib/moderation/listing-moderation-service"))
      .moderateRentalListing({
        moderatorId: "moderator-1",
        listingId: "rental-1",
        reasonCode: "OTHER",
      });
    expect(txListingModerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetType: "RENTAL",
          rentalListingId: "rental-1",
          productId: null,
          serviceListingId: null,
          errandTaskId: null,
        }),
      }),
    );
  });

  it("racePoint seam：注入时在行锁后真实执行", async () => {
    const calls: string[] = [];
    txQueryRaw.mockImplementation(async () => {
      calls.push("row-lock");
      return [{ ...LOCKED_ACTIVE_ROW }];
    });
    await moderateProductListing({
      moderatorId: "moderator-1",
      listingId: "product-1",
      reasonCode: "OTHER",
      racePoint: async () => {
        calls.push("race");
      },
    });
    expect(calls).toEqual(["row-lock", "race"]);
  });

  it("restore 竞态 belt-and-braces：updateMany count!==1 → STALE", async () => {
    txListingModerationFindFirst.mockResolvedValue({ id: "moderation-1", createdAt: new Date() });
    txListingModerationUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      restoreProductListing({
        moderatorId: "moderator-1",
        listingId: "product-1",
        moderationId: "moderation-1",
        expectedListingUpdatedAt: LOCKED_ACTIVE_ROW.updatedAt,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isModerationError(error) && error.code === "STALE_MODERATION_REVIEW",
    );
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe("Phase 7C restore seams：SERVICE/ERRAND/RENTAL（FR-05 branch 补全）", () => {
  it("restoreServiceListing：全分支路径 resolve+审计", async () => {
    txQueryRaw.mockResolvedValue([
      { ...LOCKED_ACTIVE_ROW, campusId: "campus-5", status: "PAUSED", ownerId: "provider-1" },
    ]);
    txListingModerationFindFirst.mockResolvedValue({ id: "m-s", createdAt: new Date() });

    const result = await (await import("@/lib/moderation/listing-moderation-service"))
      .restoreServiceListing({
        moderatorId: "moderator-1",
        listingId: "service-1",
        moderationId: "m-s",
        expectedListingUpdatedAt: LOCKED_ACTIVE_ROW.updatedAt,
      });
    expect(result.outcome).toBe("RESTORED");
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LISTING_RESTORED", metadata: { listingType: "SERVICE", moderationId: "m-s" } }),
      tx,
    );
  });

  it("restoreErrandListing：resolve", async () => {
    txListingModerationFindFirst.mockResolvedValue({ id: "m-e", createdAt: new Date() });
    const result = await (await import("@/lib/moderation/listing-moderation-service"))
      .restoreErrandListing({
        moderatorId: "moderator-1",
        listingId: "errand-1",
        moderationId: "m-e",
        expectedListingUpdatedAt: LOCKED_ACTIVE_ROW.updatedAt,
      });
    expect(result).toEqual({ outcome: "RESTORED", moderationId: "m-e" });
  });

  it("restoreRentalListing：resolve", async () => {
    txListingModerationFindFirst.mockResolvedValue({ id: "m-r", createdAt: new Date() });
    const result = await (await import("@/lib/moderation/listing-moderation-service"))
      .restoreRentalListing({
        moderatorId: "moderator-1",
        listingId: "rental-1",
        moderationId: "m-r",
        expectedListingUpdatedAt: LOCKED_ACTIVE_ROW.updatedAt,
      });
    expect(result).toEqual({ outcome: "RESTORED", moderationId: "m-r" });
  });

  it("moderationError overrides：string 与对象两种形态（errors.ts 两分支）", async () => {
    const { moderationError } = await import("@/lib/moderation/errors");
    const strForm = moderationError("STALE_MODERATION_REVIEW", "字符串覆盖");
    expect(strForm.message).toBe("字符串覆盖");
    const objForm = moderationError("RESTORE_NOT_RESTORABLE", { userMessage: "对象覆盖" });
    expect(objForm.message).toBe("对象覆盖");
  });
});
