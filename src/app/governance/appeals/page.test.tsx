import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireAppealReviewer,
  loadAuthorizedAppealQueue,
  beginGovernanceAppealReview,
} = vi.hoisted(() => ({
  requireAppealReviewer: vi.fn(),
  loadAuthorizedAppealQueue: vi.fn(),
  beginGovernanceAppealReview: vi.fn(),
}));

vi.mock("@/lib/appeals/reviewer-access", () => ({
  requireAppealReviewer,
}));

vi.mock("@/lib/appeals/review-queue", () => ({
  loadAuthorizedAppealQueue,
}));

vi.mock("@/actions/governance-appeals", () => ({
  beginGovernanceAppealReview,
  decideGovernanceAppeal: vi.fn(),
}));

import GovernanceAppealsPage from "@/app/governance/appeals/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockReviewer() {
  requireAppealReviewer.mockResolvedValue({
    user: { id: "viewer-1", email: "r@x", name: "审核员", role: "STUDENT" },
    context: { userId: "viewer-1", accountActive: true, activeCampusIds: [], grants: [] },
    access: { global: false, campusIds: ["campus-1"] },
  });
}

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "appeal-1",
    status: "SUBMITTED",
    createdAt: new Date("2026-09-12T08:00:00.000Z").toISOString(),
    enforcementType: "MEMBERSHIP_SUSPEND",
    scopeKind: "CAMPUS",
    campusName: "主校区",
    appellantName: "申诉人甲",
    selfReview: false,
    ...overrides,
  };
}

describe("GovernanceAppealsPage（申诉审核队列）", () => {
  it("空队列渲染空态", async () => {
    mockReviewer();
    loadAuthorizedAppealQueue.mockResolvedValue({ items: [], nextCursor: null });

    render(await GovernanceAppealsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "申诉审核" })).toBeTruthy();
    expect(screen.getByText("当前没有待处理的申诉。")).toBeTruthy();
  });

  it("渲染队列行（scope/类型/状态/appellant + 详情链接），不渲染机密面", async () => {
    mockReviewer();
    loadAuthorizedAppealQueue.mockResolvedValue({
      items: [baseItem()],
      nextCursor: null,
    });

    render(await GovernanceAppealsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("申诉人：申诉人甲")).toBeTruthy();
    expect(screen.getByText("成员身份停用")).toBeTruthy();
    expect(screen.getByText("校区：主校区")).toBeTruthy();
    expect(screen.getByText("待审核")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看详情" }).getAttribute("href")).toBe(
      "/governance/appeals/appeal-1",
    );
    // SUBMITTED 行呈现 W1「开始审核」
    expect(screen.getByRole("button", { name: "开始审核" })).toBeTruthy();
    // 队列 DTO 不含 statement/decisionNote（最小面）
    expect(screen.queryByText("申诉内容")).toBeNull();
  });

  it("IN_REVIEW 行不渲染 begin 控件；selfReview 行渲染非阻断徽标", async () => {
    mockReviewer();
    loadAuthorizedAppealQueue.mockResolvedValue({
      items: [baseItem({ status: "IN_REVIEW", selfReview: true })],
      nextCursor: null,
    });

    render(await GovernanceAppealsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("审核中")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "开始审核" })).toBeNull();
    expect(screen.getByText("你是该处罚的原执行者")).toBeTruthy();
  });

  it("GLOBAL 行显示全平台 scope", async () => {
    mockReviewer();
    loadAuthorizedAppealQueue.mockResolvedValue({
      items: [baseItem({ enforcementType: "ACCOUNT_SUSPEND", scopeKind: "GLOBAL", campusName: null })],
      nextCursor: null,
    });

    render(await GovernanceAppealsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("全平台")).toBeTruthy();
    expect(screen.getByText("账号停用")).toBeTruthy();
  });

  it("畸形 cursor → 安全失败态（不渲染任何队列行）", async () => {
    mockReviewer();
    loadAuthorizedAppealQueue.mockResolvedValue({ items: [], nextCursor: null });

    render(await GovernanceAppealsPage({ searchParams: Promise.resolve({ cursor: "!!bad!!" }) }));

    expect(screen.getByText(/分页链接无效/)).toBeTruthy();
    expect(loadAuthorizedAppealQueue).not.toHaveBeenCalled();
  });

  it("有 nextCursor → 渲染下一页链接", async () => {
    mockReviewer();
    loadAuthorizedAppealQueue.mockResolvedValue({
      items: [baseItem()],
      nextCursor: "CURSOR==",
    });

    render(await GovernanceAppealsPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("link", { name: "下一页" }).getAttribute("href"),
    ).toBe("/governance/appeals?cursor=CURSOR%3D%3D&limit=25");
  });
});
