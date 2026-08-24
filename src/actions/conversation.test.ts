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
  blockedUserFindUnique,
  transactionMock,
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
    },
    message: {
      create: txMessageCreate,
    },
    conversationParticipant: {
      updateMany: txConversationParticipantUpdateMany,
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
    blockedUserFindUnique: vi.fn(),
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txConversationCreate,
    txMessageCreate,
    txConversationUpdate,
    txConversationParticipantUpdateMany,
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
  createNotification,
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
    blockedUser: {
      findUnique: blockedUserFindUnique,
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

function p2002Error() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

describe("conversation actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
      return (where?.id?.in || []).map((id: string) => ({ id }));
    });
    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT", name: "测试同学" });
    containsBannedKeyword.mockResolvedValue(null);
    blockedUserFindUnique.mockResolvedValue(null);
    conversationFindUnique.mockResolvedValue(null);
    txConversationCreate.mockResolvedValue({ id: "conversation-new" });
    txMessageCreate.mockResolvedValue({ id: "message-1" });
    txConversationUpdate.mockResolvedValue({});
    txConversationParticipantUpdateMany.mockResolvedValue({ count: 1 });
    createNotification.mockResolvedValue({});
  });

  describe("createOrOpenProductConversation", () => {
    it("redirects to the product page when the form is invalid", async () => {
      const formData = new FormData();

      await expect(createOrOpenProductConversation(formData)).rejects.toThrow(
        "REDIRECT:/products",
      );
      expect(productFindFirst).not.toHaveBeenCalled();
    });

    it("redirects when the product is missing or owned by the current user", async () => {
      productFindFirst.mockResolvedValue(null);
      let formData = new FormData();
      formData.set("productId", "product-1");
      await expect(createOrOpenProductConversation(formData)).rejects.toThrow(
        "REDIRECT:/products/product-1",
      );

      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "user-1" });
      formData = new FormData();
      formData.set("productId", "product-1");
      await expect(createOrOpenProductConversation(formData)).rejects.toThrow(
        "REDIRECT:/products/product-1",
      );
    });

    it("reuses an existing product conversation", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      conversationFindUnique.mockResolvedValue({ id: "conversation-existing" });

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-existing",
      );
      expect(txConversationCreate).not.toHaveBeenCalled();
    });

    it("creates a product conversation with an initial message and notification", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "高数教材", sellerId: "seller-1" });

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(formData)).rejects.toThrow(
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
    });

    it("falls back to the existing conversation on a P2002 race", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "seller-1" });
      txConversationCreate.mockRejectedValue(p2002Error());
      conversationFindUnique.mockResolvedValue({ id: "conversation-winner" });

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-winner",
      );
    });

    it("redirects back when the counterpart account no longer exists", async () => {
      productFindFirst.mockResolvedValue({ id: "product-1", title: "教材", sellerId: "ghost" });
      userFindMany.mockResolvedValue([{ id: "user-1" }]);

      const formData = new FormData();
      formData.set("productId", "product-1");

      await expect(createOrOpenProductConversation(formData)).rejects.toThrow(
        "REDIRECT:/products/product-1",
      );
    });
  });

  describe("createOrOpenErrandConversation", () => {
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

      await expect(createOrOpenErrandConversation(formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-1",
      );
    });

    it("creates a new errand conversation and redirects to the message page", async () => {
      errandTaskFindFirst.mockResolvedValue({
        id: "errand-1",
        title: "帮我取快递",
        publisherId: "publisher-1",
        accepterId: null,
      });
      conversationFindUnique.mockResolvedValue(null);
      txConversationCreate.mockResolvedValue({
        id: "conversation-2",
      });

      const formData = new FormData();
      formData.set("errandId", "errand-1");

      await expect(createOrOpenErrandConversation(formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-2",
      );
    });

    it("redirects when the errand is missing", async () => {
      errandTaskFindFirst.mockResolvedValue(null);

      const formData = new FormData();
      formData.set("errandId", "errand-x");

      await expect(createOrOpenErrandConversation(formData)).rejects.toThrow(
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

      await expect(createOrOpenErrandConversation(formData)).rejects.toThrow(
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

      await expect(createOrOpenServiceConversation(formData)).rejects.toThrow(
        "REDIRECT:/messages/conversation-new",
      );

      const createData = txConversationCreate.mock.calls[0][0].data;
      expect(createData.serviceListingId).toBe("service-1");
      expect(createData.title).toBe("服务咨询：高数辅导");
    });

    it("redirects for a missing service or one owned by the current user", async () => {
      serviceListingFindFirst.mockResolvedValue(null);
      let formData = new FormData();
      formData.set("serviceId", "service-1");
      await expect(createOrOpenServiceConversation(formData)).rejects.toThrow(
        "REDIRECT:/services/service-1",
      );

      serviceListingFindFirst.mockResolvedValue({
        id: "service-1",
        title: "辅导",
        providerId: "user-1",
      });
      formData = new FormData();
      formData.set("serviceId", "service-1");
      await expect(createOrOpenServiceConversation(formData)).rejects.toThrow(
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

      await expect(createOrOpenRentalConversation(formData)).rejects.toThrow(
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
      await expect(createOrOpenRentalConversation(formData)).rejects.toThrow(
        "REDIRECT:/rentals/rental-1",
      );

      rentalListingFindFirst.mockResolvedValue({
        id: "rental-1",
        title: "相机",
        ownerId: "user-1",
      });
      formData = new FormData();
      formData.set("rentalListingId", "rental-1");
      await expect(createOrOpenRentalConversation(formData)).rejects.toThrow(
        "REDIRECT:/rentals/rental-1",
      );
    });
  });

  describe("createOrOpenOrderConversation", () => {
    it("creates a conversation for a product order between buyer and seller", async () => {
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
  });

  describe("sendMessage", () => {
    function messageFormData(content: string) {
      const formData = new FormData();
      formData.set("conversationId", "conversation-1");
      formData.set("content", content);
      return formData;
    }

    it("rejects message sending when the current user is not in the conversation", async () => {
      conversationFindFirst.mockResolvedValue(null);

      const result = await sendMessage({ success: false, message: "" }, messageFormData("你好"));

      expect(result).toEqual({
        success: false,
        message: "无权在该会话中发送消息",
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("rejects when the counterpart has blocked the sender", async () => {
      conversationFindFirst.mockResolvedValue({
        id: "conversation-1",
        participants: [{ userId: "user-1" }, { userId: "user-2" }],
      });
      blockedUserFindUnique.mockResolvedValue({ id: "block-1" });

      const result = await sendMessage({ success: false, message: "" }, messageFormData("你好"));

      expect(result).toEqual({
        success: false,
        message: "对方对你设置了消息屏蔽，无法发送",
      });
      expect(txMessageCreate).not.toHaveBeenCalled();
    });

    it("rejects message content that hits a banned keyword", async () => {
      conversationFindFirst.mockResolvedValue({
        id: "conversation-1",
        participants: [{ userId: "user-1" }, { userId: "user-2" }],
      });
      containsBannedKeyword.mockResolvedValue("违禁词");

      const result = await sendMessage({ success: false, message: "" }, messageFormData("加微信"));

      expect(result).toEqual({
        success: false,
        message: "消息包含敏感违规内容，发送失败",
      });
      expect(txMessageCreate).not.toHaveBeenCalled();
    });

    it("sends a message and refreshes read state in one transaction", async () => {
      conversationFindFirst.mockResolvedValue({
        id: "conversation-1",
        participants: [{ userId: "user-1" }, { userId: "user-2" }],
      });

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
      });
      expect(txConversationParticipantUpdateMany).toHaveBeenCalledWith({
        where: { conversationId: "conversation-1", userId: "user-1" },
        data: { lastReadAt: expect.any(Date) },
      });
      expect(revalidatePath).toHaveBeenCalledWith("/messages/conversation-1");
    });

    it("returns a validation error for empty content", async () => {
      const result = await sendMessage({ success: false, message: "" }, messageFormData(""));

      expect(result.success).toBe(false);
      expect(conversationFindFirst).not.toHaveBeenCalled();
    });
  });
});
