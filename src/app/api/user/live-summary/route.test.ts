import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  getUnreadConversationCount,
  getUnreadNotificationCount,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  getUnreadConversationCount: vi.fn(),
  getUnreadNotificationCount: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth,
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
    auth.mockReset();
    getUnreadConversationCount.mockReset();
    getUnreadNotificationCount.mockReset();
  });

  it("returns 401 with zero counts when the user is not logged in", async () => {
    auth.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/user/live-summary"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      unreadNotifications: 0,
      unreadConversations: 0,
    });
  });

  it("returns unread counts for the logged-in user", async () => {
    auth.mockResolvedValue({
      user: { id: "user-1" },
    });
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
