import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireVerificationReviewer,
  loadAuthorizedVerificationQueue,
  listVerificationQueueCampuses,
} = vi.hoisted(() => ({
  requireVerificationReviewer: vi.fn(),
  loadAuthorizedVerificationQueue: vi.fn(),
  listVerificationQueueCampuses: vi.fn(),
}));

vi.mock("@/lib/campus/verification-review-access", () => ({
  requireVerificationReviewer,
}));

vi.mock("@/lib/campus/verification-review-query", () => ({
  loadAuthorizedVerificationQueue,
  listVerificationQueueCampuses,
  VERIFICATION_QUEUE_DEFAULT_PAGE_SIZE: 25,
  VERIFICATION_QUEUE_MAX_PAGE_SIZE: 50,
  decodeVerificationCursor: (raw: string) =>
    raw === "good-cursor"
      ? {
          reviewDueAt: new Date("2026-09-20T00:00:00.000Z"),
          submittedAt: new Date("2026-09-18T00:00:00.000Z"),
          id: "v-1",
        }
      : null,
}));

import GovernanceVerificationsPage from "@/app/governance/verifications/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockReviewer(access: { global: boolean; campusIds: string[] } = { global: false, campusIds: ["campus-1"] }) {
  requireVerificationReviewer.mockResolvedValue({
    user: { id: "viewer-1", email: "r@x", name: "审核员", role: "STUDENT" },
    context: { userId: "viewer-1", accountActive: true, activeCampusIds: [], grants: [] },
    access,
  });
}

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    verificationId: "v-1",
    userDisplayName: "李同学",
    campusId: "campus-1",
    campusName: "主校区",
    status: "PENDING",
    submittedAt: new Date("2026-09-18T08:00:00.000Z").toISOString(),
    reviewDueAt: new Date("2026-09-20T08:00:00.000Z").toISOString(),
    overdue: false,
    ...overrides,
  };
}

describe("GovernanceVerificationsPage（认证审核队列）", () => {
  it("空队列渲染空态；默认 status=PENDING；campus 选项来自授权派生", async () => {
    mockReviewer();
    loadAuthorizedVerificationQueue.mockResolvedValue({ items: [], nextCursor: null });
    listVerificationQueueCampuses.mockResolvedValue([{ id: "campus-1", name: "主校区" }]);

    render(await GovernanceVerificationsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "认证审核" })).toBeTruthy();
    expect(screen.getByText("当前没有符合条件的认证申请。")).toBeTruthy();
    expect(loadAuthorizedVerificationQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        access: { global: false, campusIds: ["campus-1"] },
        limit: 25,
        filters: { campusId: undefined, status: "PENDING", overdueOnly: false },
      }),
    );
    expect(listVerificationQueueCampuses).toHaveBeenCalledWith({ global: false, campusIds: ["campus-1"] });
  });

  it("渲染队列行（状态/校区/时限/超时），不含 email/学号/证据引用", async () => {
    mockReviewer();
    loadAuthorizedVerificationQueue.mockResolvedValue({
      items: [baseItem({ overdue: true })],
      nextCursor: null,
    });
    listVerificationQueueCampuses.mockResolvedValue([]);

    render(await GovernanceVerificationsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("李同学")).toBeTruthy();
    expect(screen.getAllByText("审核中").length).toBeGreaterThan(0);
    expect(screen.getByText("主校区")).toBeTruthy();
    expect(screen.getByText("审核已超时")).toBeTruthy();
    expect(screen.getByText(/提交时间/)).toBeTruthy();
    expect(screen.getAllByText(/审核时限/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "查看详情" }).getAttribute("href")).toBe(
      "/governance/verifications/v-1",
    );
    expect(screen.queryByText(/asset:/)).toBeNull();
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it("畸形 cursor → 安全失败态；合法 cursor 透传 + 下一页链接", async () => {
    mockReviewer();
    loadAuthorizedVerificationQueue.mockResolvedValue({
      items: [baseItem()],
      nextCursor: "next-token",
    });
    listVerificationQueueCampuses.mockResolvedValue([]);

    render(
      await GovernanceVerificationsPage({ searchParams: Promise.resolve({ cursor: "bad" }) }),
    );
    expect(screen.getByText(/分页链接无效/)).toBeTruthy();
    expect(loadAuthorizedVerificationQueue).not.toHaveBeenCalled();

    cleanup();
    render(
      await GovernanceVerificationsPage({ searchParams: Promise.resolve({ cursor: "good-cursor" }) }),
    );
    expect(loadAuthorizedVerificationQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: {
          reviewDueAt: new Date("2026-09-20T00:00:00.000Z"),
          submittedAt: new Date("2026-09-18T00:00:00.000Z"),
          id: "v-1",
        },
      }),
    );
    expect(screen.getByRole("link", { name: "下一页" }).getAttribute("href")).toContain(
      "cursor=next-token",
    );
  });

  it("filters 透传（campus/status/overdue）；显式 status 覆盖默认 PENDING", async () => {
    mockReviewer({ global: true, campusIds: [] });
    loadAuthorizedVerificationQueue.mockResolvedValue({ items: [], nextCursor: null });
    listVerificationQueueCampuses.mockResolvedValue([]);

    render(
      await GovernanceVerificationsPage({
        searchParams: Promise.resolve({
          status: "VERIFIED",
          campus: "campus-1",
          overdue: "1",
          limit: "50",
        }),
      }),
    );

    expect(loadAuthorizedVerificationQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50,
        filters: { campusId: "campus-1", status: "VERIFIED", overdueOnly: true },
      }),
    );
  });
});
