import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getVerifiedSession,
  getUnreadConversationCount,
  getUnreadNotificationCount,
} = vi.hoisted(() => ({
  getVerifiedSession: vi.fn(),
  getUnreadConversationCount: vi.fn(),
  getUnreadNotificationCount: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  getVerifiedSession,
}));

vi.mock("@/repositories/conversation-repository", () => ({
  getUnreadConversationCount,
}));

vi.mock("@/repositories/notification-repository", () => ({
  getUnreadNotificationCount,
}));

import { GET } from "@/app/api/user/live-summary/route";

describe("GET /api/user/live-summary", () => {
  beforeEach(() => {
    getVerifiedSession.mockReset();
    getUnreadConversationCount.mockReset();
    getUnreadNotificationCount.mockReset();
  });

  it("returns 401 with zero counts when the user is not logged in", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "UNAUTHENTICATED" });

    const response = await GET(new Request("http://localhost/api/user/live-summary"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      unreadNotifications: 0,
      unreadConversations: 0,
    });
  });

  it("AUTH-3E: denies private unread counts for a suspended session", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "ACCOUNT_INELIGIBLE" });

    const response = await GET(new Request("http://localhost/api/user/live-summary"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      unreadNotifications: 0,
      unreadConversations: 0,
    });
    expect(getUnreadNotificationCount).not.toHaveBeenCalled();
    expect(getUnreadConversationCount).not.toHaveBeenCalled();
  });

  it("returns unread counts for the logged-in user", async () => {
    getVerifiedSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    getUnreadNotificationCount.mockResolvedValue(3);
    getUnreadConversationCount.mockResolvedValue(5);

    const response = await GET(new Request("http://localhost/api/user/live-summary"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      unreadNotifications: 3,
      unreadConversations: 5,
    });
  });
});
