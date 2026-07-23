import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  getConversationDetailPayload,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  getConversationDetailPayload: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/repositories/conversation-repository", () => ({
  getConversationDetailPayload,
}));

import { GET } from "@/app/api/messages/conversations/[id]/route";

describe("GET /api/messages/conversations/[id]", () => {
  beforeEach(() => {
    auth.mockReset();
    getConversationDetailPayload.mockReset();
  });

  it("returns 401 when the user is not logged in", async () => {
    auth.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "conversation-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ message: "Unauthorized" });
  });

  it("returns the conversation detail payload for the logged-in user", async () => {
    auth.mockResolvedValue({
      user: { id: "user-1" },
    });
    getConversationDetailPayload.mockResolvedValue({
      id: "conversation-1",
      title: "商品咨询：高数教材",
      counterpartName: "卖家同学",
      counterpartSchoolName: "示例大学",
      messages: [
        {
          id: "message-1",
          senderId: "seller-1",
          senderName: "卖家同学",
          content: "还在的，可以面交。",
          createdAt: "2026-07-17T10:00:00.000Z",
        },
      ],
    });

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "conversation-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getConversationDetailPayload).toHaveBeenCalledWith("conversation-1", "user-1");
    expect(body).toEqual({
      id: "conversation-1",
      title: "商品咨询：高数教材",
      counterpartName: "卖家同学",
      counterpartSchoolName: "示例大学",
      messages: [
        {
          id: "message-1",
          senderId: "seller-1",
          senderName: "卖家同学",
          content: "还在的，可以面交。",
          createdAt: "2026-07-17T10:00:00.000Z",
        },
      ],
    });
  });
});
