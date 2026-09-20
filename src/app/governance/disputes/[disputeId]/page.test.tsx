import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireDisputeReviewer, loadAuthorizedDisputeDetail } = vi.hoisted(() => ({
  requireDisputeReviewer: vi.fn(),
  loadAuthorizedDisputeDetail: vi.fn(),
}));

vi.mock("@/lib/disputes/dispute-access", () => ({ requireDisputeReviewer }));
vi.mock("@/lib/disputes/dispute-query", () => ({
  loadAuthorizedDisputeDetail,
  DISPUTE_QUEUE_DEFAULT_PAGE_SIZE: 25,
  DISPUTE_QUEUE_MAX_PAGE_SIZE: 50,
}));

import GovernanceDisputeDetailPage from "@/app/governance/disputes/[disputeId]/page";

const notFound = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ notFound }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockReviewer() {
  requireDisputeReviewer.mockResolvedValue({
    user: { id: "viewer-1", email: "r@x", name: "审核员" },
    context: { userId: "viewer-1", accountActive: true, activeCampusIds: ["A"], grants: [] },
    access: { global: false, campusIds: ["A"] },
  });
}

function detailFixture(overrides: Record<string, unknown> = {}) {
  return {
    disputeId: "d1",
    status: "OPEN",
    campusId: "A",
    campusName: "甲校区",
    orderId: "o1",
    safeOrderLabel: "订单 RO-1 · 投影仪",
    initiatorName: "发起人甲",
    ownerName: "出租者乙",
    renterName: "租客丙",
    reason: "物品损坏争议全文",
    evidenceRefs: ["asset:a1"],
    adminNote: null,
    createdAt: new Date("2026-09-19T00:00:00.000Z").toISOString(),
    dueAt: new Date("2026-09-21T00:00:00.000Z").toISOString(),
    overdue: false,
    assignedReviewer: null,
    selfAssigned: false,
    resolution: { code: null, action: null, resolvedAt: null, resolvedByName: null },
    openedFromOrderStatus: "IN_RENTAL",
    scopeAuthorized: true,
    canViewEvidence: true,
    ...overrides,
  };
}

describe("GovernanceDisputeDetailPage（两阶段详情）", () => {
  it("ok=false → notFound（无存在性 oracle）", async () => {
    mockReviewer();
    loadAuthorizedDisputeDetail.mockResolvedValue({ ok: false });
    notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await expect(
      GovernanceDisputeDetailPage({ params: Promise.resolve({ disputeId: "d1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("active dispute：渲染敏感面 + 领用/终局控件", async () => {
    mockReviewer();
    loadAuthorizedDisputeDetail.mockResolvedValue({ ok: true, detail: detailFixture() });

    render(await GovernanceDisputeDetailPage({ params: Promise.resolve({ disputeId: "d1" }) }));

    expect(screen.getByText("物品损坏争议全文")).toBeVisible();
    expect(screen.getByText(/出租者乙/)).toBeVisible();
    expect(screen.getByRole("form", { name: "领用纠纷" })).toBeVisible();
    expect(screen.getByRole("form", { name: "解决纠纷" })).toBeVisible();
    expect(screen.getByRole("form", { name: "关闭纠纷" })).toBeVisible();
  });

  it("terminal dispute：不渲染任何处理控件，渲染处理结果", async () => {
    mockReviewer();
    loadAuthorizedDisputeDetail.mockResolvedValue({
      ok: true,
      detail: detailFixture({
        status: "RESOLVED",
        resolution: {
          code: "MUTUAL_AGREEMENT",
          action: "RESTORE_PREVIOUS",
          resolvedAt: new Date("2026-09-19T12:00:00.000Z").toISOString(),
          resolvedByName: "审核员",
        },
      }),
    });

    render(await GovernanceDisputeDetailPage({ params: Promise.resolve({ disputeId: "d1" }) }));

    expect(screen.getByText("处理结果")).toBeVisible();
    expect(screen.getByText(/双方协商一致/)).toBeVisible();
    expect(screen.getByText(/恢复纠纷前订单状态/)).toBeVisible();
    expect(screen.queryByRole("form", { name: "领用纠纷" })).toBeNull();
    expect(screen.queryByRole("form", { name: "解决纠纷" })).toBeNull();
  });

  it("无证据读取权限 → 不渲染证据查看入口（仅计数）", async () => {
    mockReviewer();
    loadAuthorizedDisputeDetail.mockResolvedValue({
      ok: true,
      detail: detailFixture({ canViewEvidence: false }),
    });

    render(await GovernanceDisputeDetailPage({ params: Promise.resolve({ disputeId: "d1" }) }));

    expect(screen.getByText(/需要纠纷证据读取权限/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /查看证据/ })).toBeNull();
  });
});
