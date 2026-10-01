import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  redirect,
  revalidatePath,
  requireUser,
  createNotification,
  containsBannedKeyword,
  userFindMany,
  productFindFirst,
  errandTaskFindFirst,
  serviceListingFindFirst,
  rentalListingFindFirst,
  orderFindFirst,
  rentalOrderFindFirst,
  conversationFindFirst,
  conversationFindUnique,
  transactionMock,
  txConversationFindFirst,
  txConversationFindUnique,
  txBlockedUserFindUnique,
  txOrderFindFirst,
  txOrderFindUnique,
  txRentalOrderFindFirst,
  txRentalOrderFindUnique,
  txErrandTaskFindUnique,
  txProductFindFirst,
  txErrandTaskFindFirst,
  txServiceListingFindFirst,
  txRentalListingFindFirst,
  acquireGovernanceSubjectLocks,
  gateRequireMarketplaceCapability,
  gateRequireParticipantsEligible,
  txConversationCreate,
  txMessageCreate,
  txConversationUpdate,
  txConversationParticipantUpdateMany,
} = vi.hoisted(() => {
  const txConversationCreate = vi.fn();
  const txMessageCreate = vi.fn();
  const txConversationUpdate = vi.fn();
  const txConversationParticipantUpdateMany = vi.fn();
  const transactionClient = {
    conversation: {
      create: txConversationCreate,
      update: txConversationUpdate,
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    message: {
      create: txMessageCreate,
    },
    conversationParticipant: {
      updateMany: txConversationParticipantUpdateMany,
    },
    product: {
      findFirst: vi.fn(),
    },
    errandTask: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    serviceListing: {
      findFirst: vi.fn(),
    },
    rentalListing: {
      findFirst: vi.fn(),
    },
    order: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    rentalOrder: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    // 8A-03：pair block 派生读取（communication policy）
    blockedUser: {
      findUnique: vi.fn(),
    },
    // Phase 7C：rereadListingForConversation——listing 行锁 + 活跃 moderation 复查。
    // 锁内 SELECT 行由各域既有 findFirst mock 派生（场景可控）。
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join("|") : String(strings);
      const withDeleted = (row: Record<string, unknown> | null) =>
        row ? [{ ...row, deletedAt: row.deletedAt ?? null }] : [];
      // Phase 8F：rereadListingForConversation 的 SELECT 含 status 列
      // （新 contact 线程的 exposure fresh 判定）
      if (sql.includes("ErrandTask")) {
        const row = (await transactionClient.errandTask.findFirst({} as never)) as Record<
          string,
          unknown
        > | null;
        return withDeleted(
          row
            ? {
                id: "errand-1",
                campusId: row.campusId,
                ownerId: row.publisherId,
                counterpartId: row.accepterId ?? null,
                status: row.status ?? "OPEN",
              }
            : null,
        );
      }
      if (sql.includes("ServiceListing")) {
        const row = (await transactionClient.serviceListing.findFirst({} as never)) as Record<
          string,
          unknown
        > | null;
        return withDeleted(
          row
            ? { id: "service-1", campusId: row.campusId, ownerId: row.providerId, status: row.status ?? "ACTIVE" }
            : null,
        );
      }
      if (sql.includes("RentalListing")) {
        const row = (await transactionClient.rentalListing.findFirst({} as never)) as Record<
          string,
          unknown
        > | null;
        return withDeleted(
          row
            ? { id: "rental-1", campusId: row.campusId, ownerId: row.ownerId, status: row.status ?? "AVAILABLE" }
            : null,
        );
      }
      const row = (await transactionClient.product.findFirst({} as never)) as Record<
        string,
        unknown
      > | null;
      return withDeleted(
        row
          ? { id: "product-1", campusId: row.campusId, ownerId: row.sellerId, status: row.status ?? "ACTIVE" }
          : null,
      );
    }),
    listingModeration: {
      findFirst: vi.fn(async () => null),
    },
  };

  return {
    redirect: vi.fn((location: string) => {
      throw new Error(`REDIRECT:${location}`);
    }),
    revalidatePath: vi.fn(),
    requireUser: vi.fn(),
    createNotification: vi.fn(),
    containsBannedKeyword: vi.fn(),
    userFindMany: vi.fn(),
    productFindFirst: vi.fn(),
    errandTaskFindFirst: vi.fn(),
    serviceListingFindFirst: vi.fn(),
    rentalListingFindFirst: vi.fn(),
    orderFindFirst: vi.fn(),
    rentalOrderFindFirst: vi.fn(),
    conversationFindFirst: vi.fn(),
    conversationFindUnique: vi.fn(),
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txConversationFindFirst: transactionClient.conversation.findFirst,
    txConversationFindUnique: transactionClient.conversation.findUnique,
    txBlockedUserFindUnique: transactionClient.blockedUser.findUnique,
    txOrderFindFirst: transactionClient.order.findFirst,
    txOrderFindUnique: transactionClient.order.findUnique,
    txRentalOrderFindFirst: transactionClient.rentalOrder.findFirst,
    txRentalOrderFindUnique: transactionClient.rentalOrder.findUnique,
    txErrandTaskFindUnique: transactionClient.errandTask.findUnique,
    txProductFindFirst: transactionClient.product.findFirst,
    txErrandTaskFindFirst: transactionClient.errandTask.findFirst,
    txServiceListingFindFirst: transactionClient.serviceListing.findFirst,
    txRentalListingFindFirst: transactionClient.rentalListing.findFirst,
    acquireGovernanceSubjectLocks: vi.fn(),
    gateRequireMarketplaceCapability: vi.fn(),
    gateRequireParticipantsEligible: vi.fn(),
    txConversationCreate,
    txMessageCreate,
    txConversationUpdate,
    txConversationParticipantUpdateMany,
  };
});

vi.mock("@/lib/governance/active-account-mutation", () => ({
  prepareActiveAccountMutation: vi.fn().mockResolvedValue(undefined),
  assertActiveAccountMutationAllowed: vi.fn().mockResolvedValue(undefined),
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
  createNotification,
}));

// Phase 6C-3：gate/governance-lock 以 mock 注入——本文件聚焦会话串行化与
// 错误面控制流；gate 判定本身由 capability-gate.test.ts 与真 PG 集成覆盖
vi.mock("@/lib/enforcement/capability-gate", () => ({
  requireMarketplaceCapability: gateRequireMarketplaceCapability,
  requireParticipantsMarketplaceEligible: gateRequireParticipantsEligible,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
}));

vi.mock("@/lib/prisma", () => ({
    prisma: {
      user: {
        findMany: userFindMany,
      },
      product: {
        findFirst: productFindFirst,
      },
      errandTask: {
        findFirst: errandTaskFindFirst,
      },
      serviceListing: {
        findFirst: serviceListingFindFirst,
      },
      rentalListing: {
        findFirst: rentalListingFindFirst,
      },
      order: {
        findFirst: orderFindFirst,
      },
      rentalOrder: {
        findFirst: rentalOrderFindFirst,
      },
      conversation: {
        findFirst: conversationFindFirst,
        findUnique: conversationFindUnique,
      },
      $transaction: transactionMock,
    },
    withTransaction: transactionMock,
  }));

import {
  createOrOpenErrandConversation,
  createOrOpenOrderConversation,
  createOrOpenProductConversation,
  createOrOpenRentalConversation,
  createOrOpenServiceConversation,
  sendMessage,
} from "@/actions/conversation";
import {
  enforcementError,
  type EnforcementError,
} from "@/lib/enforcement/errors";

function p2002Error() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

function asEnforcementError(error: EnforcementError): EnforcementError {
  return error;
}

describe("conversation actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
      return (where?.id?.in || []).map((id: string) => ({ id }));
    });
    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT", name: "测试同学" });
    containsBannedKeyword.mockResolvedValue(null);
    conversationFindUnique.mockResolvedValue(null);
    txConversationFindUnique.mockResolvedValue(null);
    // 8A-03：sendMessageTx 事务内 discovery / pair block 派生默认无 block
    txConversationFindFirst.mockResolvedValue(null);
    txBlockedUserFindUnique.mockResolvedValue(null);
    txOrderFindFirst.mockResolvedValue(null);
    txOrderFindUnique.mockResolvedValue(null);
    txRentalOrderFindFirst.mockResolvedValue(null);
    txRentalOrderFindUnique.mockResolvedValue(null);
    txErrandTaskFindUnique.mockResolvedValue(null);
    txProductFindFirst.mockResolvedValue({ campusId: "campus-1", sellerId: "seller-1" });
    txErrandTaskFindFirst.mockResolvedValue(null);
    txServiceListingFindFirst.mockResolvedValue({ campusId: "campus-1", providerId: "provider-1" });
    txRentalListingFindFirst.mockResolvedValue({ campusId: "campus-1", ownerId: "owner-1" });
    acquireGovernanceSubjectLocks.mockResolvedValue(undefined);
    gateRequireMarketplaceCapability.mockResolvedValue(undefined);
    gateRequireParticipantsEligible.mockResolvedValue(undefined);
    txConversationCreate.mockResolvedValue({ id: "conversation-new" });
    txMessageCreate.mockResolvedValue({ id: "message-1" });
    txConversationUpdate.mockResolvedValue({});
    txConversationParticipantUpdateMany.mockResolvedValue({ count: 1 });
    createNotification.mockResolvedValue({});
  });

  describe("createOrOpenProductConversation", () => {
    it("redirects to the product page when the form is invalid", async () => {
      const formData = new FormData();

      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/products",
      );
      expect(productFindFirst).not.toHaveBeenCalled();
    });

    it("redirects when the product is missing or owned by the current user", async () => {
      productFindFirst.mockResolvedValue(null);
      let formData = new FormData();
      formData.set("productId", "product-1");
      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/products/product-1",
      );

      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "user-1" });
      formData = new FormData();
      formData.set("productId", "product-1");
      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/products/product-1",
      );
    });

    it("reuses an existing product conversation via the fast path（不触发 gate）", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      conversationFindUnique.mockResolvedValue({ id: "conversation-existing" });

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-existing",
      );
      expect(txConversationCreate).not.toHaveBeenCalled();
      expect(acquireGovernanceSubjectLocks).not.toHaveBeenCalled();
      expect(gateRequireMarketplaceCapability).not.toHaveBeenCalled();
    });

    it("creates a product conversation with an initial message and notification", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "高数教材", sellerId: "seller-1" });

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-new",
      );

      const createData = txConversationCreate.mock.calls[0][0].data;
      expect(createData.title).toBe("商品咨询：高数教材");
      expect(createData.productId).toBe("product-1");
      expect(createData.messages.create.senderId).toBe("user-1");
      expect(createNotification).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ userId: "seller-1", type: "MESSAGE" }),
      );
      expect(revalidatePath).toHaveBeenCalledWith("/messages/conversation-new");
      // MARKETPLACE_LISTING 路径：完整参与方锁 + 锁内校验（actor + 参与方）
      expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(
        expect.anything(),
        [
          { subjectType: "USER", subjectId: "user-1" },
          { subjectType: "USER", subjectId: "seller-1" },
        ],
      );
      expect(gateRequireMarketplaceCapability).toHaveBeenCalledTimes(1);
      expect(gateRequireParticipantsEligible).toHaveBeenCalledTimes(1);
    });

    it("resolves to EXISTING when the conversation appears after lock acquisition（RACE-8d 语义）", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      // 事务外 fast path miss
      conversationFindUnique.mockResolvedValue(null);
      // 锁后重读命中（并发首建者已提交）
      txConversationFindUnique.mockResolvedValue({ id: "conversation-winner" });

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-winner",
      );
      // 既有沟通放行：不做任何 gate、不写新会话
      expect(gateRequireMarketplaceCapability).not.toHaveBeenCalled();
      expect(gateRequireParticipantsEligible).not.toHaveBeenCalled();
      expect(txConversationCreate).not.toHaveBeenCalled();
    });

    it("returns the unified counterparty denial when the seller is restricted（409 合同）", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      gateRequireParticipantsEligible.mockRejectedValue(
        enforcementError("MARKETPLACE_COUNTERPARTY_UNAVAILABLE"),
      );

      const formData = new FormData();
      formData.set("productId", "product-1");

      const result = await createOrOpenProductConversation(null, formData);

      expect(result).toEqual({
        success: false,
        message: "对方当前无法开始新的交易，请稍后再试",
      });
      expect(txConversationCreate).not.toHaveBeenCalled();
    });

    it("returns the actor-specific denial when the actor is restricted（403 合同）", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      const actorError = asEnforcementError(enforcementError("MARKETPLACE_RESTRICTED"));
      gateRequireMarketplaceCapability.mockRejectedValue(actorError);

      const formData = new FormData();
      formData.set("productId", "product-1");

      const result = await createOrOpenProductConversation(null, formData);

      expect(result).toEqual({
        success: false,
        message: "当前无法开始新的交易活动，如有疑问请联系平台管理员",
      });
      expect(txConversationCreate).not.toHaveBeenCalled();
    });

    it("fails closed to the existing redirect when the participant set changed after lock（stale counterpart）", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      // 锁后重读发现 seller 已变化（资源易主）
      txProductFindFirst.mockResolvedValue({ campusId: "campus-1", sellerId: "seller-2" });

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/products/product-1",
      );
      expect(gateRequireMarketplaceCapability).not.toHaveBeenCalled();
      expect(txConversationCreate).not.toHaveBeenCalled();
    });

    it("falls back to the existing conversation on a P2002 race", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      txConversationCreate.mockRejectedValue(p2002Error());
      conversationFindUnique.mockResolvedValue({ id: "conversation-winner" });

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-winner",
      );
    });

    it("redirects back when the counterpart account no longer exists", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "ghost" });
      userFindMany.mockResolvedValue([{ id: "user-1" }]);

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/products/product-1",
      );
    });

    it("redirects back when the listing vanished after lock acquisition（资源失效语义，非 409）", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      txProductFindFirst.mockResolvedValue(null);

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/products/product-1",
      );
      expect(gateRequireMarketplaceCapability).not.toHaveBeenCalled();
      expect(txConversationCreate).not.toHaveBeenCalled();
    });
  });

  describe("createOrOpenErrandConversation", () => {
    it("redirects to the errands hub when the errand is missing（line-121 branch）", async () => {
      errandTaskFindFirst.mockResolvedValue(null);

      const formData = new FormData();
      formData.set("errandId", "errand-missing");

      await expect(createOrOpenErrandConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/errands",
      );
      expect(acquireGovernanceSubjectLocks).not.toHaveBeenCalled();
    });

    it("reuses an existing errand conversation for the same publisher and visitor", async () => {
      errandTaskFindFirst.mockResolvedValue({
        id: "errand-1",
        title: "帮我取快递",
        publisherId: "publisher-1",
        accepterId: null,
      });
      conversationFindUnique.mockResolvedValue({
        id: "conversation-1",
      });

      const formData = new FormData();
      formData.set("errandId", "errand-1");

      await expect(createOrOpenErrandConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-1",
      );
    });

    it("creates a new errand conversation after revalidating the dynamic publisher/accepter relation", async () => {
      errandTaskFindFirst.mockResolvedValue({
        id: "errand-1",
        title: "帮我取快递",
        publisherId: "publisher-1",
        accepterId: null,
      });
      conversationFindUnique.mockResolvedValue(null);
      // 锁后重读：同一参与关系
      txErrandTaskFindFirst.mockResolvedValue({
        campusId: "campus-1",
        publisherId: "publisher-1",
        accepterId: null,
      });
      txConversationCreate.mockResolvedValue({
        id: "conversation-2",
      });

      const formData = new FormData();
      formData.set("errandId", "errand-1");

      await expect(createOrOpenErrandConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-2",
      );
      expect(gateRequireMarketplaceCapability).toHaveBeenCalledTimes(1);
      expect(gateRequireParticipantsEligible).toHaveBeenCalledWith(
        expect.anything(),
        ["user-1", "publisher-1"],
        "campus-1",
        "START_NEW_MARKETPLACE_ACTIVITY",
      );
    });

    it("fails closed when the errand participant relation changed after lock（§14）", async () => {
      // 发起方 = publisher：counterpart 取 accepter（动态参与关系）
      errandTaskFindFirst.mockResolvedValue({
        id: "errand-1",
        title: "帮我取快递",
        publisherId: "user-1",
        accepterId: "accepter-1",
      });
      conversationFindUnique.mockResolvedValue(null);
      // 锁后重读：accepter 已变化 → 参与关系失效 → 不给 stale counterpart 建会话
      txErrandTaskFindFirst.mockResolvedValue({
        campusId: "campus-1",
        publisherId: "user-1",
        accepterId: "accepter-2",
      });

      const formData = new FormData();
      formData.set("errandId", "errand-1");

      await expect(createOrOpenErrandConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/errands/errand-1",
      );
      expect(gateRequireMarketplaceCapability).not.toHaveBeenCalled();
      expect(txConversationCreate).not.toHaveBeenCalled();
    });

    it("redirects when the errand is missing", async () => {
      errandTaskFindFirst.mockResolvedValue(null);

      const formData = new FormData();
      formData.set("errandId", "errand-x");

      await expect(createOrOpenErrandConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/errands",
      );
    });

    it("redirects when the publisher has no accepted counterpart yet", async () => {
      errandTaskFindFirst.mockResolvedValue({
        id: "errand-1",
        title: "帮我取快递",
        publisherId: "user-1",
        accepterId: null,
      });

      const formData = new FormData();
      formData.set("errandId", "errand-1");

      await expect(createOrOpenErrandConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/errands/errand-1",
      );
    });
  });

  describe("createOrOpenServiceConversation", () => {
    it("creates a service conversation with the provider", async () => {
      serviceListingFindFirst.mockResolvedValue({
        id: "service-1",
        title: "高数辅导",
        providerId: "provider-1",
      });

      const formData = new FormData();
      formData.set("serviceId", "service-1");

      await expect(createOrOpenServiceConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-new",
      );

      const createData = txConversationCreate.mock.calls[0][0].data;
      expect(createData.serviceListingId).toBe("service-1");
      expect(createData.title).toBe("服务咨询：高数辅导");
    });

    it("returns the unified counterparty denial when the provider is restricted（409 合同，service catch）", async () => {
      serviceListingFindFirst.mockResolvedValue({
        id: "service-1",
        title: "高数辅导",
        providerId: "provider-1",
      });
      gateRequireParticipantsEligible.mockRejectedValue(
        enforcementError("MARKETPLACE_COUNTERPARTY_UNAVAILABLE"),
      );

      const formData = new FormData();
      formData.set("serviceId", "service-1");

      const result = await createOrOpenServiceConversation(null, formData);

      expect(result).toEqual({
        success: false,
        message: "对方当前无法开始新的交易，请稍后再试",
      });
      expect(txConversationCreate).not.toHaveBeenCalled();
    });

    it("redirects for a missing service or one owned by the current user", async () => {
      serviceListingFindFirst.mockResolvedValue(null);
      let formData = new FormData();
      formData.set("serviceId", "service-1");
      await expect(createOrOpenServiceConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/services/service-1",
      );

      serviceListingFindFirst.mockResolvedValue({
        id: "service-1",
        title: "辅导",
        providerId: "user-1",
      });
      formData = new FormData();
      formData.set("serviceId", "service-1");
      await expect(createOrOpenServiceConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/services/service-1",
      );
    });
  });

  describe("createOrOpenRentalConversation", () => {
    it("creates a rental conversation with the owner", async () => {
      rentalListingFindFirst.mockResolvedValue({
        id: "rental-1",
        title: "相机出租",
        ownerId: "owner-1",
      });

      const formData = new FormData();
      formData.set("rentalListingId", "rental-1");

      await expect(createOrOpenRentalConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-new",
      );

      const createData = txConversationCreate.mock.calls[0][0].data;
      expect(createData.rentalListingId).toBe("rental-1");
      expect(createData.title).toBe("租赁咨询：相机出租");
    });

    it("redirects for a missing rental listing or one owned by the current user", async () => {
      rentalListingFindFirst.mockResolvedValue(null);
      let formData = new FormData();
      formData.set("rentalListingId", "rental-1");
      await expect(createOrOpenRentalConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/rentals/rental-1",
      );

      rentalListingFindFirst.mockResolvedValue({
        id: "rental-1",
        title: "相机",
        ownerId: "user-1",
      });
      formData = new FormData();
      formData.set("rentalListingId", "rental-1");
      await expect(createOrOpenRentalConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/rentals/rental-1",
      );
    });
  });

  describe("createOrOpenOrderConversation", () => {
    it("creates a conversation for a product order between buyer and seller（pair 未 block → 不做义务 gate）", async () => {
      orderFindFirst.mockResolvedValue({
        id: "order-1",
        orderNo: "CM2026082100000001",
        buyerId: "user-1",
        sellerId: "seller-1",
      });

      const formData = new FormData();
      formData.set("orderId", "order-1");
      formData.set("orderType", "PRODUCT");

      await expect(createOrOpenOrderConversation(formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-new",
      );

      const createData = txConversationCreate.mock.calls[0][0].data;
      expect(createData.orderId).toBe("order-1");
      expect(createData.title).toContain("CM2026082100000001");
      // 8A-03：既有义务沟通与 block/send 同一 sorted pair USER 锁域；
      // pair 未 block → 不做义务复核、不做 marketplace gate
      expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(expect.anything(), [
        { subjectType: "USER", subjectId: "user-1" },
        { subjectType: "USER", subjectId: "seller-1" },
      ]);
      expect(gateRequireMarketplaceCapability).not.toHaveBeenCalled();
      expect(gateRequireParticipantsEligible).not.toHaveBeenCalled();
      expect(txOrderFindUnique).not.toHaveBeenCalled();
    });

    it("creates a conversation for a rental order between owner and renter", async () => {
      rentalOrderFindFirst.mockResolvedValue({
        id: "rental-order-1",
        orderNumber: "RT2026082100000001",
        ownerId: "user-1",
        renterId: "renter-1",
      });

      const formData = new FormData();
      formData.set("orderId", "rental-order-1");
      formData.set("orderType", "RENTAL");

      await expect(createOrOpenOrderConversation(formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-new",
      );

      const createData = txConversationCreate.mock.calls[0][0].data;
      expect(createData.rentalOrderId).toBe("rental-order-1");
      expect(createData.title).toContain("RT2026082100000001");
    });

    it("redirects to the order center when the order is not visible", async () => {
      orderFindFirst.mockResolvedValue(null);

      const formData = new FormData();
      formData.set("orderId", "order-x");
      formData.set("orderType", "PRODUCT");

      await expect(createOrOpenOrderConversation(formData)).rejects.toThrow(
        "REDIRECT:/my/orders",
      );
    });

    // §41：pair blocked + active obligation → 允许创建订单会话（保留履约渠道）
    it("allows creating the order conversation when pair blocked but obligation active（§41）", async () => {
      orderFindFirst.mockResolvedValue({
        id: "order-1",
        orderNo: "CM2026082100000002",
        buyerId: "user-1",
        sellerId: "seller-1",
      });
      // 锁内 pair block 派生命中（任意单向行即可）
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });
      // 锁后义务复核：order 存在 + exact pair + ACTIVE
      txOrderFindUnique.mockResolvedValue({
        buyerId: "user-1",
        sellerId: "seller-1",
        status: "PENDING",
      });

      const formData = new FormData();
      formData.set("orderId", "order-1");
      formData.set("orderType", "PRODUCT");

      await expect(createOrOpenOrderConversation(formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-new",
      );
      expect(txConversationCreate).toHaveBeenCalledTimes(1);
      expect(createNotification).toHaveBeenCalledTimes(1);
    });

    // §41：pair blocked + terminal order → 新订单会话 DENY
    it("denies creating the order conversation when pair blocked and order terminal（§41）", async () => {
      orderFindFirst.mockResolvedValue({
        id: "order-1",
        orderNo: "CM2026082100000003",
        buyerId: "user-1",
        sellerId: "seller-1",
      });
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });
      txOrderFindUnique.mockResolvedValue({
        buyerId: "user-1",
        sellerId: "seller-1",
        status: "COMPLETED",
      });

      const formData = new FormData();
      formData.set("orderId", "order-1");
      formData.set("orderType", "PRODUCT");

      await expect(createOrOpenOrderConversation(formData)).rejects.toThrow(
        "REDIRECT:/my/orders",
      );
      expect(txConversationCreate).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
    });

    // §41：pair blocked + rental obligation active → ALLOW
    it("allows the rental order conversation when pair blocked and rental active（§41）", async () => {
      rentalOrderFindFirst.mockResolvedValue({
        id: "rental-order-1",
        orderNumber: "RT2026082100000002",
        ownerId: "owner-1",
        renterId: "user-1",
      });
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });
      txRentalOrderFindUnique.mockResolvedValue({
        ownerId: "owner-1",
        renterId: "user-1",
        status: "IN_RENTAL",
      });

      const formData = new FormData();
      formData.set("orderId", "rental-order-1");
      formData.set("orderType", "RENTAL");

      await expect(createOrOpenOrderConversation(formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-new",
      );
      expect(txConversationCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendMessage（8A-03 事务内 authority）", () => {
    function messageFormData(content: string) {
      const formData = new FormData();
      formData.set("conversationId", "conversation-1");
      formData.set("content", content);
      return formData;
    }

    function mockConversationDiscovery(
      participants: Array<{ userId: string }>,
      refs: Record<string, string | null> = {},
    ) {
      // 事务内 discovery + POST-LOCK 重读（两读同一 mock，场景一致）
      txConversationFindFirst.mockResolvedValue({
        participants,
      });
      txConversationFindUnique.mockResolvedValue({
        productId: null,
        errandTaskId: null,
        serviceListingId: null,
        rentalListingId: null,
        orderId: null,
        rentalOrderId: null,
        participants,
        ...refs,
      });
    }

    it("BLOCK-SEND-04：sender not conversation participant → DENY", async () => {
      txConversationFindFirst.mockResolvedValue(null);

      const result = await sendMessage({ success: false, message: "" }, messageFormData("你好"));

      expect(result).toEqual({
        success: false,
        message: "无权在该会话中发送消息",
      });
      expect(txMessageCreate).not.toHaveBeenCalled();
      expect(acquireGovernanceSubjectLocks).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("BLOCK-SEND-02：counterpart blocks sender → DENY（事务内 authority）", async () => {
      mockConversationDiscovery([{ userId: "user-1" }, { userId: "user-2" }]);
      // sender 查询自己是否被对方拉黑命中
      txBlockedUserFindUnique.mockImplementation(async (args: {
        where: { blockerId_blockedUserId: { blockerId: string; blockedUserId: string } };
      }) =>
        args.where.blockerId_blockedUserId.blockerId === "user-2" ? { id: "block-1" } : null,
      );

      const result = await sendMessage({ success: false, message: "" }, messageFormData("你好"));

      expect(result).toEqual({
        success: false,
        message: "你们之间存在消息屏蔽，无法发送消息",
      });
      expect(txMessageCreate).not.toHaveBeenCalled();
      // authority 位于事务 + pair 锁边界内
      expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(expect.anything(), [
        { subjectType: "USER", subjectId: "user-1" },
        { subjectType: "USER", subjectId: "user-2" },
      ]);
    });

    it("BLOCK-SEND-01：sender blocks counterpart → 也 DENY（关闭单向漏洞）", async () => {
      mockConversationDiscovery([{ userId: "user-1" }, { userId: "user-2" }]);
      txBlockedUserFindUnique.mockImplementation(async (args: {
        where: { blockerId_blockedUserId: { blockerId: string; blockedUserId: string } };
      }) =>
        args.where.blockerId_blockedUserId.blockerId === "user-1" ? { id: "block-1" } : null,
      );

      const result = await sendMessage({ success: false, message: "" }, messageFormData("你好"));

      expect(result).toEqual({
        success: false,
        message: "你们之间存在消息屏蔽，无法发送消息",
      });
      expect(txMessageCreate).not.toHaveBeenCalled();
    });

    it("BLOCK-SEND-03：no block → normal send PASS", async () => {
      mockConversationDiscovery([{ userId: "user-1" }, { userId: "user-2" }]);

      const result = await sendMessage(
        { success: false, message: "" },
        messageFormData("明天下午可以吗？"),
      );

      expect(result).toEqual({ success: true, message: "发送成功" });
      expect(txMessageCreate).toHaveBeenCalledWith({
        data: {
          conversationId: "conversation-1",
          senderId: "user-1",
          type: "DIRECT",
          content: "明天下午可以吗？",
        },
        select: { id: true },
      });
      expect(txConversationParticipantUpdateMany).toHaveBeenCalledWith({
        where: { conversationId: "conversation-1", userId: "user-1" },
        data: { lastReadAt: expect.any(Date) },
      });
      expect(revalidatePath).toHaveBeenCalledWith("/messages/conversation-1");
    });

    it("OBL-SEND：blocked + active PRODUCT obligation（productId 反查 exact pair）→ send allowed", async () => {
      mockConversationDiscovery([{ userId: "user-1" }, { userId: "user-2" }], {
        productId: "product-1",
      });
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });
      // PRODUCT listing 反查命中 active PRODUCT Order（exact pair）
      txOrderFindFirst.mockResolvedValue({ id: "order-p1" });

      const result = await sendMessage(
        { success: false, message: "" },
        messageFormData("交接时间明天可以吗？"),
      );

      expect(result).toEqual({ success: true, message: "发送成功" });
      expect(txMessageCreate).toHaveBeenCalledTimes(1);
      // 反查谓词绑定 exact pair
      const where = txOrderFindFirst.mock.calls[0][0].where as Record<string, unknown>;
      expect(where).toMatchObject({ type: "PRODUCT", productId: "product-1" });
    });

    it("OBL-SEND：blocked + active RENTAL obligation（rentalOrderId 直连）→ send allowed", async () => {
      mockConversationDiscovery([{ userId: "user-1" }, { userId: "user-2" }], {
        rentalOrderId: "ro-1",
      });
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });
      txRentalOrderFindUnique.mockResolvedValue({
        ownerId: "user-2",
        renterId: "user-1",
        status: "IN_RENTAL",
      });

      const result = await sendMessage(
        { success: false, message: "" },
        messageFormData("明天取货可以吗？"),
      );

      expect(result).toEqual({ success: true, message: "发送成功" });
    });

    it("OBL-SEND：blocked + active ERRAND obligation（errandTaskId 直连 exact pair）→ send allowed", async () => {
      mockConversationDiscovery([{ userId: "user-1" }, { userId: "user-2" }], {
        errandTaskId: "errand-1",
      });
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });
      txErrandTaskFindUnique.mockResolvedValue({
        publisherId: "user-1",
        accepterId: "user-2",
        status: "IN_PROGRESS",
      });

      const result = await sendMessage(
        { success: false, message: "" },
        messageFormData("已取到件，下午送过去。"),
      );

      expect(result).toEqual({ success: true, message: "发送成功" });
    });

    it("OBL-SEND：blocked + active SERVICE obligation（serviceListingId 反查）→ send allowed", async () => {
      mockConversationDiscovery([{ userId: "user-1" }, { userId: "user-2" }], {
        serviceListingId: "service-1",
      });
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });
      txOrderFindFirst.mockResolvedValue({ id: "order-s1" });

      const result = await sendMessage(
        { success: false, message: "" },
        messageFormData("辅导时间确认一下。"),
      );

      expect(result).toEqual({ success: true, message: "发送成功" });
    });

    it("OBL-SEND：blocked + active obligation（orderId 直连 ACTIVE）→ send allowed 双向", async () => {
      mockConversationDiscovery([{ userId: "user-1" }, { userId: "user-2" }], {
        orderId: "order-1",
      });
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });
      txConversationFindUnique.mockResolvedValue({
        productId: null,
        errandTaskId: null,
        serviceListingId: null,
        rentalListingId: null,
        orderId: "order-1",
        rentalOrderId: null,
        participants: [{ userId: "user-1" }, { userId: "user-2" }],
      });
      txOrderFindUnique.mockResolvedValue({
        buyerId: "user-1",
        sellerId: "user-2",
        status: "ACCEPTED",
      });

      const result = await sendMessage(
        { success: false, message: "" },
        messageFormData("交接时间明天可以吗？"),
      );

      expect(result).toEqual({ success: true, message: "发送成功" });
      expect(txMessageCreate).toHaveBeenCalledTimes(1);
    });

    it("OBL-SEND：blocked + terminal obligation（orderId COMPLETED）→ DENY（历史订单非 bypass token）", async () => {
      mockConversationDiscovery([{ userId: "user-1" }, { userId: "user-2" }], {
        orderId: "order-1",
      });
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });
      txConversationFindUnique.mockResolvedValue({
        productId: null,
        errandTaskId: null,
        serviceListingId: null,
        rentalListingId: null,
        orderId: "order-1",
        rentalOrderId: null,
        participants: [{ userId: "user-1" }, { userId: "user-2" }],
      });
      txOrderFindUnique.mockResolvedValue({
        buyerId: "user-1",
        sellerId: "user-2",
        status: "COMPLETED",
      });

      const result = await sendMessage({ success: false, message: "" }, messageFormData("你好"));

      expect(result).toEqual({
        success: false,
        message: "你们之间存在消息屏蔽，无法发送消息",
      });
      expect(txMessageCreate).not.toHaveBeenCalled();
    });

    it("rejects message content that hits a banned keyword（事务外 precheck）", async () => {
      containsBannedKeyword.mockResolvedValue("违禁词");

      const result = await sendMessage({ success: false, message: "" }, messageFormData("加微信"));

      expect(result).toEqual({
        success: false,
        message: "消息包含敏感违规内容，发送失败",
      });
      expect(txMessageCreate).not.toHaveBeenCalled();
      expect(txConversationFindFirst).not.toHaveBeenCalled();
    });

    it("rejects malformed payload via schema（invalid branch）", async () => {
      const formData = new FormData();
      formData.set("conversationId", "");
      formData.set("content", "");
      const result = await sendMessage({ success: false, message: "" }, formData);
      expect(result.success).toBe(false);
      expect(txMessageCreate).not.toHaveBeenCalled();
    });

    it("fail closed when the participant set is not exactly 1:1（0/1/>2 拒绝）", async () => {
      mockConversationDiscovery([{ userId: "user-1" }]);

      const result = await sendMessage({ success: false, message: "" }, messageFormData("你好"));

      expect(result).toEqual({
        success: false,
        message: "会话参与方状态异常，无法发送消息",
      });
      expect(txMessageCreate).not.toHaveBeenCalled();
    });

    it("fail closed when the participant pair changed after lock", async () => {
      mockConversationDiscovery([{ userId: "user-1" }, { userId: "user-2" }]);
      // 锁后重读发现参与方集合已变化
      txConversationFindUnique.mockResolvedValue({
        productId: null,
        errandTaskId: null,
        serviceListingId: null,
        rentalListingId: null,
        orderId: null,
        rentalOrderId: null,
        participants: [{ userId: "user-1" }, { userId: "user-3" }],
      });

      const result = await sendMessage({ success: false, message: "" }, messageFormData("你好"));

      expect(result).toEqual({
        success: false,
        message: "会话参与方状态异常，无法发送消息",
      });
      expect(txMessageCreate).not.toHaveBeenCalled();
    });

    it("returns a validation error for empty content", async () => {
      const result = await sendMessage({ success: false, message: "" }, messageFormData(""));

      expect(result.success).toBe(false);
      expect(txConversationFindFirst).not.toHaveBeenCalled();
    });
  });

  describe("8A-03 blocked new-contact（conversation creation）", () => {
    it("BLOCK-CONV-01：A blocks B → B 经 PRODUCT listing 建新会话 DENY（零会话/零消息/零通知）", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      conversationFindUnique.mockResolvedValue(null);
      txConversationFindUnique.mockResolvedValue(null);
      // 锁内 pair block 派生命中（counterpart blocked user，单向行足够）
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });

      const formData = new FormData();
      formData.set("productId", "product-1");

      const result = await createOrOpenProductConversation(null, formData);

      expect(result).toEqual({
        success: false,
        message: "你们之间存在消息屏蔽，无法发起新的会话沟通",
      });
      expect(txConversationCreate).not.toHaveBeenCalled();
      expect(txMessageCreate).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
      expect(gateRequireMarketplaceCapability).not.toHaveBeenCalled();
    });

    it("BLOCK-CONV-02：B blocks A → A 经 SERVICE/RENTAL listing 建新会话 DENY", async () => {
      serviceListingFindFirst.mockResolvedValue({
        id: "service-1",
        title: "高数辅导",
        providerId: "provider-1",
      });
      conversationFindUnique.mockResolvedValue(null);
      txConversationFindUnique.mockResolvedValue(null);
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });

      const formData = new FormData();
      formData.set("serviceId", "service-1");

      const result = await createOrOpenServiceConversation(null, formData);

      expect(result).toEqual({
        success: false,
        message: "你们之间存在消息屏蔽，无法发起新的会话沟通",
      });
      expect(txConversationCreate).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();

      // RENTAL listing 同责
      rentalListingFindFirst.mockResolvedValue({
        id: "rental-1",
        title: "相机出租",
        ownerId: "owner-1",
      });
      const rentalForm = new FormData();
      rentalForm.set("rentalListingId", "rental-1");

      const rentalResult = await createOrOpenRentalConversation(null, rentalForm);

      expect(rentalResult).toEqual({
        success: false,
        message: "你们之间存在消息屏蔽，无法发起新的会话沟通",
      });
    });

    it("BLOCK-CONV-03：pair blocked + 既有同 key 会话 → 仍可打开（历史证据保留，零新写）", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      // 事务外 fast path 命中
      conversationFindUnique.mockResolvedValue({ id: "conversation-existing" });
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-existing",
      );
      expect(txConversationCreate).not.toHaveBeenCalled();
      expect(txMessageCreate).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
      expect(acquireGovernanceSubjectLocks).not.toHaveBeenCalled();
    });

    it("BLOCK-CONV-03b：pair blocked + 锁后重读命中既有会话 → 放行（不做任何 gate）", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      conversationFindUnique.mockResolvedValue(null);
      // 锁后重读命中（既有沟通）
      txConversationFindUnique.mockResolvedValue({ id: "conversation-winner" });
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(null, formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-winner",
      );
      expect(gateRequireMarketplaceCapability).not.toHaveBeenCalled();
      expect(txConversationCreate).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
    });

    it("ERRAND listing：pair blocked → 新会话 DENY", async () => {
      errandTaskFindFirst.mockResolvedValue({
        id: "errand-1",
        title: "帮我取快递",
        publisherId: "publisher-1",
        accepterId: null,
      });
      conversationFindUnique.mockResolvedValue(null);
      txConversationFindUnique.mockResolvedValue(null);
      txErrandTaskFindFirst.mockResolvedValue({
        campusId: "campus-1",
        publisherId: "publisher-1",
        accepterId: null,
      });
      txBlockedUserFindUnique.mockResolvedValue({ id: "block-1" });

      const formData = new FormData();
      formData.set("errandId", "errand-1");

      const result = await createOrOpenErrandConversation(null, formData);

      expect(result).toEqual({
        success: false,
        message: "你们之间存在消息屏蔽，无法发起新的会话沟通",
      });
      expect(txConversationCreate).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
    });

    it("returns the unified counterparty denial when the owner is restricted（409 合同，rental catch）", async () => {
      rentalListingFindFirst.mockResolvedValue({
        id: "rental-1",
        title: "相机出租",
        ownerId: "owner-1",
      });
      gateRequireParticipantsEligible.mockRejectedValue(
        enforcementError("MARKETPLACE_COUNTERPARTY_UNAVAILABLE"),
      );

      const formData = new FormData();
      formData.set("rentalListingId", "rental-1");

      const result = await createOrOpenRentalConversation(null, formData);

      expect(result).toEqual({
        success: false,
        message: "对方当前无法开始新的交易，请稍后再试",
      });
      expect(txConversationCreate).not.toHaveBeenCalled();
    });
  });
});
