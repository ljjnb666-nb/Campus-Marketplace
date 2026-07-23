import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  redirect,
  revalidatePath,
  requireUser,
  createNotification,
  conversationParticipantFindFirst,
  conversationFindFirst,
  conversationFindUnique,
  conversationFindMany,
  errandTaskFindFirst,
  userFindMany,
  transactionMock,
  txConversationCreate,
} = vi.hoisted(() => {
  const txConversationCreate = vi.fn();
  const transactionClient = {
    conversation: {
      create: txConversationCreate,
    },
  };

  return {
    redirect: vi.fn((location: string) => {
      throw new Error(`REDIRECT:${location}`);
    }),
    revalidatePath: vi.fn(),
    requireUser: vi.fn(),
    createNotification: vi.fn(),
    conversationParticipantFindFirst: vi.fn(),
    conversationFindFirst: vi.fn(),
    conversationFindUnique: vi.fn(),
    conversationFindMany: vi.fn(),
    errandTaskFindFirst: vi.fn(),
    userFindMany: vi.fn(),
    transactionMock: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
    ),
    txConversationCreate,
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

vi.mock("@/repositories/notification-repository", () => ({
  createNotification,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findMany: userFindMany,
    },
    conversationParticipant: {
      findFirst: conversationParticipantFindFirst,
    },
    conversation: {
      findFirst: conversationFindFirst,
      findUnique: conversationFindUnique,
      findMany: conversationFindMany,
    },
    errandTask: {
      findFirst: errandTaskFindFirst,
    },
    $transaction: transactionMock,
  },
}));

import { createOrOpenErrandConversation, sendMessage } from "@/actions/conversation";

describe("conversation actions", () => {
  beforeEach(() => {
    redirect.mockClear();
    revalidatePath.mockReset();
    requireUser.mockReset();
    createNotification.mockReset();
    conversationParticipantFindFirst.mockReset();
    conversationFindFirst.mockReset();
    conversationFindUnique.mockReset();
    conversationFindMany.mockReset();
    errandTaskFindFirst.mockReset();
    userFindMany.mockReset();
    transactionMock.mockClear();
    txConversationCreate.mockReset();

    userFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
      return (where?.id?.in || []).map((id: string) => ({ id }));
    });

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT", name: "测试同学" });
  });

  it("rejects message sending when the current user is not in the conversation", async () => {
    conversationFindFirst.mockResolvedValue(null);

    const formData = new FormData();
    formData.set("conversationId", "conversation-1");
    formData.set("content", "你好，我想再确认一下细节。");

    const result = await sendMessage({ success: false, message: "" }, formData);

    expect(result).toEqual({
      success: false,
      message: "无权在该会话中发送消息",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
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
});
