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
  notFound.mockReset();
});

function mockReviewer() {
  requireDisputeReviewer.mockResolvedValue({
    user: { id: "viewer-1", email: "r@x", name: "审核员" },
    context: { userId: "viewer-1", accountActive: true, activeCampusIds: ["A"], grants: [] },
    access: { global: false, campusIds: ["A"] },
  });
}

function rentalDetailFixture(overrides: Record<string, unknown> = {}) {
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

function orderDetailFixture(overrides: Record<string, unknown> = {}) {
  return {
    disputeId: "od-1",
    status: "OPEN",
    campusId: "A",
    campusName: "甲校区",
    orderId: "o1",
    orderType: "PRODUCT",
    safeOrderLabel: "订单 PO-1 · 二手商品",
    initiatorName: "发起人甲",
    participants: [
      { label: "买家", displayName: "买家乙" },
      { label: "卖家", displayName: "卖家丙" },
    ],
    reason: "商品与描述不符全文",
    adminNote: null,
    createdAt: new Date("2026-09-19T00:00:00.000Z").toISOString(),
    dueAt: new Date("2026-09-21T00:00:00.000Z").toISOString(),
    overdue: false,
    assignedReviewer: null,
    selfAssigned: false,
    resolution: { code: null, action: null, resolvedAt: null, resolvedByName: null },
    openedFromOrderStatus: "ACCEPTED",
    openedFromErrandStatus: null,
    scopeAuthorized: true,
    evidenceSupported: false,
    ...overrides,
  };
}

function renderPage(params: {
  disputeId: string;
  kind?: string;
  loaderResult: Record<string, unknown>;
}) {
  loadAuthorizedDisputeDetail.mockResolvedValue(params.loaderResult);
  const searchParams: Record<string, string> = {};
  if (params.kind !== undefined) {
    searchParams.kind = params.kind;
  }
  return GovernanceDisputeDetailPage({
    params: Promise.resolve({ disputeId: params.disputeId }),
    searchParams: Promise.resolve(searchParams),
  });
}

describe("GovernanceDisputeDetailPage（两阶段详情；kind dispatch）", () => {
  it("ok=false → notFound（无存在性 oracle）", async () => {
    mockReviewer();
    notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");

    });

    await expect(
      renderPage({ disputeId: "d1", loaderResult: { ok: false } }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("§6：缺 kind → RENTAL legacy dispatch（旧 Rental bookmark 兼容）", async () => {
    mockReviewer();

    render(
      await renderPage({
        disputeId: "d1",
        loaderResult: { ok: true, kind: "RENTAL", detail: rentalDetailFixture() },
      }),
    );

    expect(loadAuthorizedDisputeDetail).toHaveBeenCalledWith(
      expect.objectContaining({ disputeId: "d1", kind: "RENTAL" }),
    );
    expect(screen.getByText("纠纷类型：租赁订单")).toBeVisible();
    expect(screen.getByText(/出租者乙/)).toBeVisible();
  });

  it("§6：非法 kind=xxx → notFound（safe failure，不猜测）", async () => {
    mockReviewer();
    notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await expect(
      renderPage({ disputeId: "d1", kind: "xxx", loaderResult: { ok: true, kind: "RENTAL", detail: rentalDetailFixture() } }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(loadAuthorizedDisputeDetail).not.toHaveBeenCalled();
  });

  it("active rental dispute：渲染敏感面 + 领用/终局控件（disputeKind 显式提交）", async () => {
    mockReviewer();

    render(
      await renderPage({
        disputeId: "d1",
        kind: "RENTAL",
        loaderResult: { ok: true, kind: "RENTAL", detail: rentalDetailFixture() },
      }),
    );

    expect(screen.getByText("物品损坏争议全文")).toBeVisible();
    expect(screen.getByText(/出租者乙/)).toBeVisible();
    expect(screen.getByText("纠纷类型：租赁订单")).toBeVisible();
    expect(screen.getByRole("form", { name: "领用纠纷" })).toBeVisible();
    expect(screen.getByRole("form", { name: "解决纠纷" })).toBeVisible();
    expect(screen.getByRole("form", { name: "关闭纠纷" })).toBeVisible();

    const claimForm = screen.getByRole("form", { name: "领用纠纷" });
    const kindInput = claimForm.querySelector('input[name="disputeKind"]');
    expect(kindInput).not.toBeNull();
    expect(kindInput!.getAttribute("value")).toBe("RENTAL");
  });

  it("§53：ORDER 详情渲染 纠纷类型：普通订单 · <子类型> + participants", async () => {
    mockReviewer();

    render(
      await renderPage({
        disputeId: "od-1",
        kind: "ORDER",
        loaderResult: { ok: true, kind: "ORDER", detail: orderDetailFixture() },
      }),
    );

    expect(screen.getByText("纠纷类型：普通订单 · 二手商品")).toBeVisible();
    expect(screen.getByText(/买家：买家乙/)).toBeVisible();
    expect(screen.getByText(/卖家：卖家丙/)).toBeVisible();
    expect(screen.getByText("商品与描述不符全文")).toBeVisible();
    expect(screen.queryByText(/出租者/)).toBeNull();
  });

  it("§43：ORDER 详情证据区恒显示『暂不支持附件证据』（无 PrivateAssetViewer）", async () => {
    mockReviewer();

    render(
      await renderPage({
        disputeId: "od-1",
        kind: "ORDER",
        loaderResult: { ok: true, kind: "ORDER", detail: orderDetailFixture() },
      }),
    );

    expect(screen.getByText("当前普通订单纠纷暂不支持附件证据")).toBeVisible();
    expect(screen.queryByRole("button", { name: /查看证据/ })).toBeNull();

    const claimForm = screen.getByRole("form", { name: "领用纠纷" });
    const kindInput = claimForm.querySelector('input[name="disputeKind"]');
    expect(kindInput!.getAttribute("value")).toBe("ORDER");
  });

  it("§54：ORDER 详情保留 RESTORE_PREVIOUS 选项（不在客户端按 openedFrom 隐藏）", async () => {
    mockReviewer();

    render(
      await renderPage({
        disputeId: "od-1",
        kind: "ORDER",
        loaderResult: { ok: true, kind: "ORDER", detail: orderDetailFixture() },
      }),
    );

    const resolveForm = screen.getByRole("form", { name: "解决纠纷" });
    const actionSelect = resolveForm.querySelector('select[name="resolutionAction"]');
    expect(actionSelect).not.toBeNull();
    const options = Array.from(actionSelect!.querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(options).toContain("RESTORE_PREVIOUS");
    expect(options).toContain("CLOSE_ORDER");
  });

  it("terminal dispute：不渲染任何处理控件，渲染处理结果", async () => {
    mockReviewer();

    render(
      await renderPage({
        disputeId: "d1",
        loaderResult: {
          ok: true,
          kind: "RENTAL",
          detail: rentalDetailFixture({
            status: "RESOLVED",
            resolution: {
              code: "MUTUAL_AGREEMENT",
              action: "RESTORE_PREVIOUS",
              resolvedAt: new Date("2026-09-19T12:00:00.000Z").toISOString(),
              resolvedByName: "审核员",
            },
          }),
        },
      }),
    );

    expect(screen.getByText("处理结果")).toBeVisible();
    expect(screen.getByText(/双方协商一致/)).toBeVisible();
    expect(screen.getByText(/恢复纠纷前订单状态/)).toBeVisible();
    expect(screen.queryByRole("form", { name: "领用纠纷" })).toBeNull();
    expect(screen.queryByRole("form", { name: "解决纠纷" })).toBeNull();
  });

  it("无证据读取权限 → 不渲染证据查看入口（仅计数）", async () => {
    mockReviewer();

    render(
      await renderPage({
        disputeId: "d1",
        loaderResult: {
          ok: true,
          kind: "RENTAL",
          detail: rentalDetailFixture({ canViewEvidence: false }),
        },
      }),
    );

    expect(screen.getByText(/需要纠纷证据读取权限/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /查看证据/ })).toBeNull();
  });
});
