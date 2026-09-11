import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getVerifiedSession,
  getConversationListItems,
} = vi.hoisted(() => ({
  getVerifiedSession: vi.fn(),
  getConversationListItems: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  getVerifiedSession,
}));

vi.mock("@/repositories/conversation-repository", () => ({
  getConversationListItems,
}));

import { GET } from "@/app/api/messages/conversations/route";

describe("GET /api/messages/conversations", () => {
  beforeEach(() => {
    getVerifiedSession.mockReset();
    getConversationListItems.mockReset();
  });

  it("returns 401 with an empty list when the user is not logged in", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "UNAUTHENTICATED" });

    const response = await GET(new Request("http://localhost/api/messages/conversations"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ items: [] });
  });

  it("AUTH-3C: denies the private conversation list for a suspended session", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "ACCOUNT_INELIGIBLE" });

    const response = await GET(new Request("http://localhost/api/messages/conversations"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ items: [] });
    expect(getConversationListItems).not.toHaveBeenCalled();
  });

  it("returns conversation list items for the logged-in user", async () => {
    getVerifiedSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    getConversationListItems.mockResolvedValue([
      {
        id: "conversation-1",
        title: "商品咨询：高数教材",
        counterpartName: "卖家同学",
        counterpartSchoolName: "示例大学",
        lastMessageSenderName: "卖家同学",
        lastMessageContent: "还在的，可以面交。",
        lastMessageAt: "2026-07-17T10:00:00.000Z",
        updatedAt: "2026-07-17T10:00:00.000Z",
        hasUnread: true,
      },
    ]);

    const response = await GET(new Request("http://localhost/api/messages/conversations"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      items: [
        {
          id: "conversation-1",
          title: "商品咨询：高数教材",
          counterpartName: "卖家同学",
          counterpartSchoolName: "示例大学",
          lastMessageSenderName: "卖家同学",
          lastMessageContent: "还在的，可以面交。",
          lastMessageAt: "2026-07-17T10:00:00.000Z",
          updatedAt: "2026-07-17T10:00:00.000Z",
          hasUnread: true,
        },
      ],
    });
  });

  it("threads a valid limit query param into the repository call", async () => {
    getVerifiedSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    getConversationListItems.mockResolvedValue([]);

    const response = await GET(
      new Request("http://localhost/api/messages/conversations?limit=10"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getConversationListItems).toHaveBeenCalledWith("user-1", { limit: 10 });
    expect(body).toEqual({ items: [] });
  });

  it("ignores an invalid limit query param", async () => {
    getVerifiedSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    getConversationListItems.mockResolvedValue([]);

    const response = await GET(
      new Request("http://localhost/api/messages/conversations?limit=abc"),
    );

    expect(response.status).toBe(200);
    expect(getConversationListItems).toHaveBeenCalledWith("user-1", { limit: undefined });
  });
});
